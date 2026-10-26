import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
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

/** Everything a write needs besides the actor: the client address for the audit row, the app's clock, the object store and a logger. */
export interface NoteDeps { ip?: string; now?: Date; storage?: Storage; log?: { error(obj: object, msg: string): void } }

/** Microsecond-exact text of created_at, so the cursor round-trips without losing the precision the sort uses. */
const createdText = sql<string>`to_char(${notes.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const CURSOR_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const encodeCursor = (createdAt: string, id: string): string => Buffer.from(`${createdAt}|${id}`).toString('base64url');
function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id, ...rest] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const bad = badRequest('That page link is not valid. Go back to the first page.');
  if (rest.length > 0 || !createdAt || !id || !CURSOR_TS.test(createdAt) || !UUID.test(id)) throw bad;
  // The shape is not enough: the date must exist (no month 99, no 30 February) and be a real year, or the database cast would fail with a 500.
  const ms = new Date(`${createdAt.slice(0, 23)}Z`);
  if (Number.isNaN(ms.getTime()) || ms.toISOString() !== `${createdAt.slice(0, 23)}Z` || ms.getUTCFullYear() < 1) throw bad;
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

type Discard = { id: string; storageKey: string };

/**
 * Inside the transaction a discarded photo is only detached (the file row no longer points at the note), never deleted.
 * The object and the row are removed by `removeDiscarded` after the commit, so a failed transaction never loses a photo.
 */
async function detachFile(tx: Tx, fileId: string): Promise<Discard | null> {
  const [row] = await tx.select().from(files).where(eq(files.id, fileId)).for('update');
  if (!row) return null;
  await tx.update(files).set({ attachedType: null, attachedId: null }).where(eq(files.id, fileId));
  return { id: row.id, storageKey: row.storageKey };
}

/** After the commit: best effort. A failure leaves an unattached row, which the orphan sweep collects. Nothing but the file id and error name is logged. */
async function removeDiscarded(db: Db, deps: NoteDeps, discarded: Discard[]): Promise<void> {
  for (const f of discarded) {
    try {
      await deps.storage?.delete(f.storageKey);
      await db.delete(files).where(and(eq(files.id, f.id), isNull(files.attachedType)));
    } catch (e) {
      deps.log?.error({ fileId: f.id, errName: (e as { name?: string }).name }, 'A discarded note photo could not be removed; the sweep will retry');
    }
  }
}

export async function createNote(db: Db, actor: Actor, input: CreateNoteInput, deps: NoteDeps = {}): Promise<NoteView> {
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.insert(notes).values({
      ownerId: actor.id, teamId: actor.teamId, title: input.title, body: input.body, createdAt: stamp(deps.now), updatedAt: stamp(deps.now),
    }).returning({ id: notes.id });
    if (!row) throw new Error('The note was not created.');
    if (input.attachmentId !== null) {
      await attachFile(tx, actor, input.attachmentId, { type: PARENT_TYPE, id: row.id });
      await tx.update(notes).set({ attachmentFileId: input.attachmentId }).where(eq(notes.id, row.id));
    }
    await audit(tx, { actor, ...(deps.ip === undefined ? {} : { ip: deps.ip }) }, { action: 'note.created', targetType: 'note', targetId: row.id });
    return row.id;
  });
  const view = await getNote(db, actor, id);
  if (!view) throw new Error('The note was not found after it was created.');
  return view;
}

export async function updateNote(db: Db, actor: Actor, id: string, input: UpdateNoteInput, deps: NoteDeps = {}): Promise<NoteView> {
  const discarded: Discard[] = [];
  await db.transaction(async (tx) => {
    const current = await lockEditable(tx, actor, id);
    const set: Partial<typeof notes.$inferInsert> = {};
    const changed: string[] = [];
    // Only a value that really differs counts as a change: no audit row and no new updated_at for a no-op.
    if (input.title !== undefined && input.title !== current.title) { set.title = input.title; changed.push('title'); }
    if (input.body !== undefined && input.body !== current.body) { set.body = input.body; changed.push('body'); }
    if (input.attachmentId !== undefined && input.attachmentId !== current.attachmentFileId) {
      if (input.attachmentId !== null) await attachFile(tx, actor, input.attachmentId, { type: PARENT_TYPE, id });
      // The note stops pointing at the old photo first; the old file is only detached here and removed after the commit.
      if (current.attachmentFileId !== null) {
        await tx.update(notes).set({ attachmentFileId: null }).where(eq(notes.id, id));
        const d = await detachFile(tx, current.attachmentFileId);
        if (d) discarded.push(d);
      }
      set.attachmentFileId = input.attachmentId;
      changed.push('attachmentId');
    }
    if (changed.length === 0) return;
    await tx.update(notes).set({ ...set, updatedAt: stamp(deps.now) }).where(eq(notes.id, id));
    // Field names only: the text of a note may be personal data.
    await audit(tx, { actor, ...(deps.ip === undefined ? {} : { ip: deps.ip }) }, { action: 'note.updated', targetType: 'note', targetId: id, details: { fields: changed.sort() } });
  });
  await removeDiscarded(db, deps, discarded);
  const view = await getNote(db, actor, id);
  if (!view) throw notFound();
  return view;
}

export async function deleteNote(db: Db, actor: Actor, id: string, deps: NoteDeps = {}): Promise<void> {
  const discarded: Discard[] = [];
  await db.transaction(async (tx) => {
    const current = await lockEditable(tx, actor, id);
    await tx.delete(notes).where(eq(notes.id, id));
    if (current.attachmentFileId !== null) {
      const d = await detachFile(tx, current.attachmentFileId);
      if (d) discarded.push(d);
    }
    await audit(tx, { actor, ...(deps.ip === undefined ? {} : { ip: deps.ip }) }, { action: 'note.deleted', targetType: 'note', targetId: id });
  });
  await removeDiscarded(db, deps, discarded);
}
