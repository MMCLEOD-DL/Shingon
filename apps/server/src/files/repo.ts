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
 * Deletes unattached files older than `olderThan`. For each file the stored object goes first and the row second,
 * so a crash leaves at worst a row whose object is gone (the next sweep removes it), never an object no row points to.
 * The row is locked and re-checked first, so a file attached a moment ago is not removed.
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
  return removed;
}
