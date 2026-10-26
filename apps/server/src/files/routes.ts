import { randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { formatLimit } from '@hf/shared';
import { defineRoute } from '../http/route.js';
import { badRequest, forbidden, notFound, tooLarge, unauthorized } from '../http/errors.js';
import { audit } from '../audit/audit.js';
import { canEdit } from '../access/scope.js';
import { files } from '../db/schema/index.js';
import type { Config } from '../config.js';
import { eq } from 'drizzle-orm';
import { sniffType } from './sniff.js';
import type { Storage } from './storage.js';
import { getVisibleFile, toFileView } from './repo.js';

const IdParams = z.strictObject({ id: z.uuid() });
const NoQuery = z.strictObject({});

const EMPTY = 'That file is empty.';
const ONE_FILE = 'Send just one file, with nothing else.';
const NOT_ACCEPTED = "That kind of file isn't accepted. Use a photo (JPEG, PNG, WebP, HEIC) or a PDF.";
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Stored name: no path parts, no control characters, at most 200 characters. */
export function cleanName(raw: string): string {
  const base = (raw.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop() ?? '').trim();
  const name = Array.from(base).slice(0, 200).join('').trim();
  return name === '' || name === '.' || name === '..' ? 'file' : name;
}

/** RFC 5987 value: percent-encodes everything but unreserved characters. */
const encodeName = (name: string): string => encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function drain(stream: Readable): Promise<void> {
  await pipeline(stream, new Writable({ write(_c, _e, cb) { cb(); } })).catch(() => undefined);
}

const errCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

export function registerFileRoutes(app: FastifyInstance, config: Pick<Config, 'uploadMaxBytes'>, storage: Storage): void {
  // Nothing but the one `file` part is accepted: the handler refuses any extra field or second file. fields is 1 (not 0) so that a stray field is seen and refused rather than dropped silently.
  void app.register(multipart, { limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 1 } });

  defineRoute(app, {
    method: 'POST',
    url: '/api/files',
    access: { permission: 'files:upload' },
    async handler(req, reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const key = randomBytes(16).toString('hex');
      let stored = false;
      try {
        const parts = req.parts();
        const nextPart = async () => {
          try {
            return await parts.next();
          } catch (e) {
            if (errCode(e) === 'FST_FIELDS_LIMIT' || errCode(e) === 'FST_FILES_LIMIT' || errCode(e) === 'FST_PARTS_LIMIT') throw badRequest(ONE_FILE);
            throw e;
          }
        };
        const first = await nextPart();
        const part = first.done ? undefined : first.value;
        if (!part || part.type !== 'file' || part.fieldname !== 'file') throw badRequest(part ? ONE_FILE : 'Choose a file to upload.');

        // Read just enough to sniff the type, then stream head + rest to storage.
        const iter = part.file[Symbol.asyncIterator]();
        const head: Buffer[] = [];
        let headLen = 0;
        let ended = false;
        while (headLen < 32) {
          const n = await iter.next();
          if (n.done) { ended = true; break; }
          head.push(n.value as Buffer);
          headLen += (n.value as Buffer).length;
        }
        const headBuf = Buffer.concat(head);
        if (headBuf.length === 0) { await drain(part.file); throw badRequest(EMPTY); }
        const contentType = sniffType(headBuf);
        if (!contentType) { await drain(part.file); throw badRequest(NOT_ACCEPTED); }

        const body = Readable.from((async function* () {
          yield headBuf;
          if (!ended) for (;;) { const n = await iter.next(); if (n.done) return; yield n.value as Buffer; }
        })());
        let result;
        try {
          result = await storage.put(key, body);
        } catch (e) {
          if (errCode(e) === 'FST_REQ_FILE_TOO_LARGE' || part.file.truncated) throw tooLarge(`That file is too large. The limit is ${formatLimit(config.uploadMaxBytes)}.`);
          throw e;
        }
        stored = true;
        if (part.file.truncated) throw tooLarge(`That file is too large. The limit is ${formatLimit(config.uploadMaxBytes)}.`);

        // Anything after the file (an extra field or a second file) is refused, so nothing but the file is ever read.
        if (!(await nextPart()).done) throw badRequest(ONE_FILE);

        const name = cleanName(part.filename);
        const row = await db.transaction(async (tx) => {
          const [inserted] = await tx.insert(files).values({
            ownerId: actor.id, teamId: actor.teamId, storageKey: key, originalName: name, contentType, size: result.size, sha256: result.sha256,
          }).returning();
          if (!inserted) throw new Error('The file row was not created.');
          await audit(tx, { actor, ip: req.ip }, { action: 'file.uploaded', targetType: 'file', targetId: inserted.id, details: { name, size: result.size, contentType } });
          return inserted;
        });
        return await reply.code(201).send({ file: toFileView(row) });
      } catch (e) {
        // Whatever went wrong after the bytes were stored, the object must not outlive the failed request.
        if (stored) await storage.delete(key).catch(() => undefined);
        if (errCode(e) === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(`That file is too large. The limit is ${formatLimit(config.uploadMaxBytes)}.`);
        throw e;
      }
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/files/:id',
    access: { permission: 'files:read' },
    schema: { params: IdParams, query: NoQuery },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const row = await getVisibleFile(db, actor, req.params.id);
      if (!row) throw notFound();
      return { file: toFileView(row) };
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/files/:id/content',
    access: { permission: 'files:read' },
    schema: { params: IdParams, query: NoQuery },
    async handler(req, reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const row = await getVisibleFile(db, actor, req.params.id);
      if (!row) throw notFound();
      await audit(db, { actor, ip: req.ip }, { action: 'file.downloaded', targetType: 'file', targetId: row.id });
      const inline = INLINE_TYPES.has(row.contentType);
      // A download must never run as a page in the app's origin: sniffed type, nosniff, a sandboxing CSP, and attachment for non-raster types.
      return reply
        .header('content-type', row.contentType)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .header('content-length', row.size)
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeName(row.originalName)}`)
        .send(storage.get(row.storageKey));
    },
  });

  defineRoute(app, {
    method: 'DELETE',
    url: '/api/files/:id',
    access: { permission: 'files:upload' },
    schema: { params: IdParams },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const row = await getVisibleFile(db, actor, req.params.id);
      if (!row) throw notFound();
      if (!canEdit(actor, row)) throw forbidden();
      // The object goes first, then the row (the same order as the orphan sweep).
      await storage.delete(row.storageKey);
      await db.transaction(async (tx) => {
        await tx.delete(files).where(eq(files.id, row.id));
        await audit(tx, { actor, ip: req.ip }, { action: 'file.deleted', targetType: 'file', targetId: row.id, details: { name: row.originalName } });
      });
    },
  });
}
