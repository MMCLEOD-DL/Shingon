import { randomBytes } from 'node:crypto';
import type { ReadStream } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { formatLimit } from '@hf/shared';
import { defineRoute } from '../http/route.js';
import { HttpError, badRequest, forbidden, notFound, tooLarge, unauthorized } from '../http/errors.js';
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
const BAD_UPLOAD = "That upload didn't come through properly. Please choose the file and try again.";
const NOT_ACCEPTED = "That kind of file isn't accepted. Use a photo (JPEG, PNG, WebP, HEIC) or a PDF.";
const INLINE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Stored name: no path parts, no control characters, at most 200 characters. */
export function cleanName(raw: string): string {
  const base = (raw.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').split(/[\\/]/).pop() ?? '').trim();
  const name = Array.from(base).slice(0, 200).join('').trim();
  return name === '' || name === '.' || name === '..' ? 'file' : name;
}

/** RFC 5987 value: percent-encodes everything but unreserved characters. */
const encodeName = (name: string): string => encodeURIComponent(name).replace(/['()*!]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

async function drain(stream: Readable): Promise<void> {
  await pipeline(stream, new Writable({ write(_c, _e, cb) { cb(); } })).catch(() => undefined);
}

/** Resolves once a file stream has really opened, or rejects (for example ENOENT). Other streams are passed through. */
function opened(stream: Readable): Promise<void> {
  const fsStream = stream as Partial<ReadStream>;
  if (typeof fsStream.pending !== 'boolean') return Promise.resolve();
  if (!fsStream.pending) return Promise.resolve();
  return new Promise((resolve, reject) => { stream.once('open', () => { resolve(); }); stream.once('error', reject); });
}

const errCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

export function registerFileRoutes(app: FastifyInstance, config: Pick<Config, 'uploadMaxBytes'>, storage: Storage): void {
  const tooBig = `That file is too large. The limit is ${formatLimit(config.uploadMaxBytes)}.`;
  // Nothing but the one `file` part is accepted. The limits make busboy raise an error for any field or second file (mapped to 400 below);
  // the handler also refuses a stray part itself, as defence in depth.
  void app.register(multipart, { limits: { fileSize: config.uploadMaxBytes, files: 1, fields: 0 } });

  defineRoute(app, {
    method: 'POST',
    url: '/api/files',
    access: { permission: 'files:upload' },
    config: {
      // 60 uploads per 15 minutes per signed-in user.
      rateLimit: { max: 60, timeWindow: '15 minutes', hook: 'preHandler', keyGenerator: (req: { ip: string; actor?: { id: string } | null }) => req.actor?.id ?? req.ip },
    },
    async handler(req, reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const key = randomBytes(16).toString('hex');
      let stored = false;
      try {
        let parts: ReturnType<typeof req.parts>;
        try {
          parts = req.parts();
        } catch {
          throw badRequest(BAD_UPLOAD);
        }
        const nextPart = async () => {
          try {
            return await parts.next();
          } catch (e) {
            if (e instanceof HttpError) throw e;
            if (errCode(e) === 'FST_FIELDS_LIMIT' || errCode(e) === 'FST_FILES_LIMIT' || errCode(e) === 'FST_PARTS_LIMIT') throw badRequest(ONE_FILE);
            if (errCode(e) === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(tooBig);
            // Not multipart, a missing or bad boundary, a truncated form: all the client's mistake.
            throw badRequest(BAD_UPLOAD);
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
          if (errCode(e) === 'FST_REQ_FILE_TOO_LARGE' || part.file.truncated) throw tooLarge(tooBig);
          throw e;
        }
        stored = true;
        if (part.file.truncated) throw tooLarge(tooBig);

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
        if (errCode(e) === 'FST_REQ_FILE_TOO_LARGE') throw tooLarge(tooBig);
        // The browser gave up part-way, or the form was cut short.
        if (errCode(e) === 'ERR_STREAM_PREMATURE_CLOSE') throw badRequest(BAD_UPLOAD);
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
      // Open the object before any download header is set, so a missing object is an ordinary plain error.
      const stream = storage.get(row.storageKey);
      try {
        await opened(stream);
      } catch (e) {
        stream.destroy();
        if (errCode(e) === 'ENOENT') throw notFound('We could not find that file.');
        throw e;
      }
      if (req.method === 'GET') await audit(db, { actor, ip: req.ip }, { action: 'file.downloaded', targetType: 'file', targetId: row.id });
      const inline = INLINE_TYPES.has(row.contentType);
      // A download must never run as a page in the app's origin: sniffed type, nosniff, a sandboxing CSP, and attachment for non-raster types.
      return reply
        .header('content-type', row.contentType)
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .header('cache-control', 'private, no-store')
        .header('content-length', row.size)
        .header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeName(row.originalName)}`)
        .send(stream);
    },
  });

  defineRoute(app, {
    method: 'DELETE',
    url: '/api/files/:id',
    access: { permission: 'files:upload' },
    schema: { params: IdParams, query: NoQuery },
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
