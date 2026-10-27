import { and, eq, isNull, lt } from 'drizzle-orm';
import type { FileView } from '@hf/shared';
import type { Actor } from '../auth/sessions.js';
import type { Db, Tx } from '../db/client.js';
import { files, type FileRow } from '../db/schema/index.js';
import { canEdit, visibleTo } from '../access/scope.js';
import { conflict, notFound } from '../http/errors.js';
import type { Storage } from './storage.js';

export type { FileRow };

export const toFileView = (r: FileRow): FileView => ({
  id: r.id, name: r.originalName, contentType: r.contentType, size: r.size, createdAt: r.createdAt.toISOString(), ownerId: r.ownerId,
});

/** Null when the file does not exist or is outside the actor's visibility (the caller answers 404 either way). */
export async function getVisibleFile(db: Db | Tx, actor: Actor, id: string): Promise<FileRow | null> {
  const [row] = await db.select().from(files).where(and(eq(files.id, id), visibleTo(actor, { owner: files.ownerId, team: files.teamId })));
  return row ?? null;
}

/**
 * Links an uploaded file to the record it belongs to. Only the owner (or an admin) may; anything else is a 404.
 * A file the actor can see but does not own (a manager looking at a team member's file) is a 404 too, deliberately:
 * attaching changes the file, so only an owner or admin may, and the answer must not hint that the file exists. Client features copy this.
 * A file already attached to a different record is a 409: it is never moved from one parent to another.
 */
export async function attachFile(tx: Tx, actor: Actor, fileId: string, parent: { type: string; id: string }): Promise<void> {
  const [row] = await tx.select().from(files).where(eq(files.id, fileId)).for('update');
  if (!row || !canEdit(actor, row)) throw notFound("We couldn't find that file.");
  if (row.attachedType !== null && (row.attachedType !== parent.type || row.attachedId !== parent.id)) {
    throw conflict('That file is already attached to something else.');
  }
  await tx.update(files).set({ attachedType: parent.type, attachedId: parent.id }).where(eq(files.id, fileId));
}

/**
 * Deletes unattached files older than `olderThan`, then reconciles the disk (`sweepStrayObjects`). The row is locked and re-checked
 * first, so a file attached a moment ago is not removed. Here, unlike a delete someone asks for (the file route and the notes'
 * removeDiscarded, which remove the row first so nobody is ever shown a file whose bytes are gone), the object goes first and
 * the row second, inside the row's transaction: these files are unattached and old, so nobody is looking at them, and a
 * failed object delete keeps the row, so the next sweep simply tries that file again.
 */
export async function sweepOrphans(db: Db, storage: Storage, olderThan: Date, log?: { error(obj: object, msg: string): void }): Promise<number> {
  const old = await db.select({ id: files.id }).from(files).where(and(isNull(files.attachedType), lt(files.createdAt, olderThan)));
  let removed = 0;
  for (const { id } of old) {
    try {
      const done = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(files)
          .where(and(eq(files.id, id), isNull(files.attachedType), lt(files.createdAt, olderThan))).for('update', { skipLocked: true });
        if (!row) return false;
        await storage.delete(row.storageKey);
        await tx.delete(files).where(eq(files.id, id));
        return true;
      });
      if (done) removed++;
    } catch (e) {
      // One bad file must not stop the rest; the next sweep tries it again. Only the error name/code and the file id are logged.
      const err = e as { name?: string; code?: string };
      log?.error({ fileId: id, errName: err.name, errCode: err.code }, 'File sweep could not remove a file');
    }
  }
  await sweepStrayObjects(db, storage, olderThan, log);
  return removed;
}

/**
 * Disk side of the sweep: removes stored objects that no files row points to (for example when a post-commit removal deleted the row
 * but then failed to delete the object) and leftover partial uploads, when older than `olderThan`. Failures are logged by error name/code only.
 */
export async function sweepStrayObjects(db: Db, storage: Storage, olderThan: Date, log?: { error(obj: object, msg: string): void }): Promise<number> {
  let removed = 0;
  const fail = (e: unknown): void => {
    const err = e as { name?: string; code?: string };
    log?.error({ errName: err.name, errCode: err.code }, 'File sweep could not remove a stray stored object');
  };
  try {
    for await (const o of storage.list()) {
      if (o.mtime >= olderThan) continue;
      try {
        if (!o.tmp) {
          const [row] = await db.select({ id: files.id }).from(files).where(eq(files.storageKey, o.key)).limit(1);
          if (row) continue;
        }
        await storage.delete(o.key);
        removed++;
      } catch (e) { fail(e); }
    }
  } catch (e) { fail(e); }
  return removed;
}
