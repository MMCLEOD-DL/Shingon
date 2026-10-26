import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { CreateNoteInput, FileView, NoteView, UpdateNoteInput } from '@hf/shared';
import type { Actor } from '../auth/sessions.js';
import type { Db, Tx } from '../db/client.js';
import { files, notes, users, type FileRow } from '../db/schema/index.js';
import { canEdit, visibleTo } from '../access/scope.js';
import { audit } from '../audit/audit.js';
import { badRequest, forbidden, notFound } from '../http/errors.js';
import { attachFile, toFileView } from '../files/repo.js';
import type { Storage } from '../files/storage.js';

const PARENT_TYPE = 'note';

/** Microsecond-exact text of created_at, so the cursor round-trips without losing the precision the sort uses. */
const createdText = sql<string>`to_char(${notes.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (createdAt: string, id: string): string => Buffer.from(`${createdAt}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  if (rest.length > 0 || !createdAt || !id || !CURSOR_TS.test(createdAt) || !UUID.test(id)) throw badRequest('That page link is not valid. Go back to the first page.');
  return { createdAt, id };
}

/** `now` is the app's injected clock; without one the database clock is used, which keeps rows made in the same millisecond in order. */
const stamp = (now?: Date): SQL | Date => now ?? sql`clock_timestamp()`;

const viewColumns = {
  id: notes.id, title: notes.title, body: notes.body, ownerId: notes.ownerId, ownerName: users.name, teamId: notes.teamId,
  createdAt: notes.createdAt, updatedAt: notes.updatedAt, created: createdText, file: files,
};

function toView(actor: Actor, r: { id: string; title: string; body: string; ownerId: string; ownerName: string; teamId: string | null; createdAt: Date; updatedAt: Date; file: FileRow | null }): NoteView {
  return {
    id: r.id, title: r.title, body: r.body, ownerId: r.ownerId, ownerName: r.ownerName, teamId: r.teamId,
    attachment: r.file ? (toFileView(r.file) satisfies FileView) : null,
    createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), canEdit: canEdit(actor, r),
  };
}

const baseQuery = (db: Db | Tx) =>
  db.select(viewColumns).from(notes).innerJoin(users, eq(users.id, notes.ownerId)).leftJoin(files, eq(files.id, notes.attachmentFileId));

export async function listNotes(db: Db, actor: Actor, q: { cursor?: string; limit: number }): Promise<{ notes: NoteView[]; nextCursor: string | null }> {
  const conds: (SQL | undefined)[] = [visibleTo(actor, { owner: notes.ownerId, team: notes.teamId })];
  if (q.cursor !== undefined) {
    const c = decodeCursor(q.cursor);
    conds.push(sql`(${notes.createdAt}, ${notes.id}) < (${c.createdAt}::timestamptz, ${c.id}::uuid)`);
  }
  const rows = await baseQuery(db).where(and(...conds)).orderBy(desc(notes.createdAt), desc(notes.id)).limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const last = page[page.length - 1];
  return {
    notes: page.map((r) => toView(actor, r)),
    nextCursor: rows.length > q.limit && last ? encodeCursor(last.created, last.id) : null,
  };
}

export async function getNote(db: Db | Tx, actor: Actor, id: string): Promise<NoteView | null> {
  const [row] = await baseQuery(db).where(and(eq(notes.id, id), visibleTo(actor, { owner: notes.ownerId, team: notes.teamId })));
  return row ? toView(actor, row) : null;
}

/** Locks the note row. 404 when the actor cannot see it, 403 when they can see it but may not change it. */
async function lockEditable(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(notes)
    .where(and(eq(notes.id, id), visibleTo(actor, { owner: notes.ownerId, team: notes.teamId }))).for('update');
  if (!row) throw notFound();
  if (!canEdit(actor, row)) throw forbidden();
  return row;
}

/**
 * Removes a file that no note points to any more: the stored object first, then the row (the same order as the orphan sweep).
 * It runs inside the caller's transaction, so if the object cannot be removed nothing else changes either.
 */
async function discardFile(tx: Tx, storage: Storage, fileId: string): Promise<void> {
  const [row] = await tx.select().from(files).where(eq(files.id, fileId)).for('update');
  if (!row) return;
  await storage.delete(row.storageKey);
  await tx.delete(files).where(eq(files.id, fileId));
}

export async function createNote(db: Db, actor: Actor, input: CreateNoteInput, ip?: string, now?: Date): Promise<NoteView> {
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(notes).values({
      ownerId: actor.id, teamId: actor.teamId, title: input.title, body: input.body, createdAt: stamp(now), updatedAt: stamp(now),
    }).returning({ id: notes.id });
    if (!row) throw new Error('The note was not created.');
    if (input.attachmentId !== null) {
      await attachFile(tx, actor, input.attachmentId, { type: PARENT_TYPE, id: row.id });
      await tx.update(notes).set({ attachmentFileId: input.attachmentId }).where(eq(notes.id, row.id));
    }
    await audit(tx, { actor, ip }, { action: 'note.created', targetType: 'note', targetId: row.id });
    return row.id;
  });
  const view = await getNote(db, actor, id);
  if (!view) throw new Error('The note was not found after it was created.');
  return view;
}

export async function updateNote(db: Db, storage: Storage, actor: Actor, id: string, input: UpdateNoteInput, ip?: string, now?: Date): Promise<NoteView> {
  await db.transaction(async (tx) => {
    const current = await lockEditable(tx, actor, id);
    const set: Partial<typeof notes.$inferInsert> = {};
    if (input.title !== undefined) set.title = input.title;
    if (input.body !== undefined) set.body = input.body;
    const changed = Object.keys(input).filter((k) => (input as Record<string, unknown>)[k] !== undefined).sort();
    if (input.attachmentId !== undefined && input.attachmentId !== current.attachmentFileId) {
      if (input.attachmentId !== null) {
        await attachFile(tx, actor, input.attachmentId, { type: PARENT_TYPE, id });
      }
      set.attachmentFileId = input.attachmentId;
      if (current.attachmentFileId !== null) {
        // Detaching or replacing: the old photo belonged to this note alone, so it goes with the link.
        await tx.update(notes).set({ attachmentFileId: null }).where(eq(notes.id, id));
        await discardFile(tx, storage, current.attachmentFileId);
      }
    }
    if (changed.length === 0) return;
    await tx.update(notes).set({ ...set, updatedAt: stamp(now) }).where(eq(notes.id, id));
    // Field names only: the text of a note may be personal data.
    await audit(tx, { actor, ip }, { action: 'note.updated', targetType: 'note', targetId: id, details: { fields: changed } });
  });
  const view = await getNote(db, actor, id);
  if (!view) throw notFound();
  return view;
}

export async function deleteNote(db: Db, storage: Storage, actor: Actor, id: string, ip?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockEditable(tx, actor, id);
    await tx.delete(notes).where(eq(notes.id, id));
    if (current.attachmentFileId !== null) await discardFile(tx, storage, current.attachmentFileId);
    await audit(tx, { actor, ip }, { action: 'note.deleted', targetType: 'note', targetId: id });
  });
}
