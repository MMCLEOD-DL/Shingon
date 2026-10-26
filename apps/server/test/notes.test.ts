import { test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { createTestApp, call as rawCall, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { createNote, updateNote, removeDiscarded } from '../src/notes/repo.js';
import { LocalDiskStorage } from '../src/files/storage.js';
import { auditLog, files, notes } from '../src/db/schema/index.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
type U = { id: string; email: string };
interface Note { id: string; title: string; body: string; ownerId: string; teamId: string | null; attachment: { id: string; ownerId: string } | null; createdAt: string; updatedAt: string; canEdit: boolean }
interface Reply { status: number; json: { note: Note; notes: Note[]; nextCursor: string | null; error: string } }
const call = (tt: typeof t, auth: { cookie: string } | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown): Promise<Reply> =>
  rawCall(tt, auth, method, url, body);
let N: { id: string }, S: { id: string }, admin: U, mN: U, alice: U, bob: U, carol: U;
beforeAll(async () => {
  t = await createTestApp();
  N = await makeTeam(t.db, 'North'); S = await makeTeam(t.db, 'South');
  admin = await makeUser(t.db, { role: 'admin' });
  mN = await makeUser(t.db, { role: 'manager', teamId: N.id });
  alice = await makeUser(t.db, { role: 'member', teamId: N.id, name: 'Alice' });
  bob = await makeUser(t.db, { role: 'member', teamId: N.id });
  carol = await makeUser(t.db, { role: 'member', teamId: S.id });
});
afterAll(async () => { await t.close(); });

const as = async (u: U) => signInAs(t, u);
const png = readFileSync(new URL('./fixtures/files/tiny.png', import.meta.url));
async function upload(u: U): Promise<string> {
  const up = await t.app.inject({ method: 'POST', url: '/api/files', headers: { cookie: (await as(u)).cookie, origin: 'http://hf.test', 'content-type': 'multipart/form-data; boundary=b' },
    payload: Buffer.concat([Buffer.from(`--b\r\nContent-Disposition: form-data; name="file"; filename="r.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from('\r\n--b--\r\n')]) });
  return up.json<{ file: { id: string } }>().file.id;
}
const fileRow = async (id: string) => (await t.db.select().from(files).where(eq(files.id, id)))[0];
const objectExists = (key: string) => existsSync(join(t.config.uploadDir, key.slice(0, 2), key)) || existsSync(join(t.config.uploadDir, key));

test('create, read, update, delete as the owner; owner and team are set by the server', async () => {
  const a = await as(alice);
  const c = await call(t, a, 'POST', '/api/notes', { title: 'Taxi to client', body: '£12.40' });
  expect(c.status).toBe(201);
  expect(c.json.note).toMatchObject({ title: 'Taxi to client', ownerId: alice.id, ownerName: 'Alice', teamId: N.id, canEdit: true, attachment: null });
  const id = c.json.note.id;
  expect((await call(t, a, 'PATCH', `/api/notes/${id}`, { title: 'Taxi' })).json.note.title).toBe('Taxi');
  expect((await call(t, a, 'DELETE', `/api/notes/${id}`)).status).toBe(204);
  expect((await call(t, a, 'GET', `/api/notes/${id}`)).status).toBe(404);
});

test('a partial update changes only the fields sent', async () => {
  const a = await as(alice);
  const fileId = await upload(alice);
  const c = await call(t, a, 'POST', '/api/notes', { title: 'Lunch', body: '£8.20 with client', attachmentId: fileId });
  const id = c.json.note.id;
  const p = await call(t, a, 'PATCH', `/api/notes/${id}`, { title: 'Lunch (Acme)' });
  expect(p.status).toBe(200);
  expect(p.json.note).toMatchObject({ title: 'Lunch (Acme)', body: '£8.20 with client', attachment: { id: fileId } });
  const g = await call(t, a, 'GET', `/api/notes/${id}`);
  expect(g.json.note).toMatchObject({ body: '£8.20 with client', attachment: { id: fileId } });
  const d = await call(t, a, 'PATCH', `/api/notes/${id}`, { attachmentId: null });   // detaching is explicit
  expect(d.json.note).toMatchObject({ title: 'Lunch (Acme)', body: '£8.20 with client', attachment: null });
});

test('a manager sees team notes read-only; another team sees nothing; a teammate sees nothing', async () => {
  const id = (await call(t, await as(alice), 'POST', '/api/notes', { title: 'Hotel' })).json.note.id;
  const m = await as(mN);
  expect((await call(t, m, 'GET', `/api/notes/${id}`)).json.note.canEdit).toBe(false);
  expect((await call(t, m, 'PATCH', `/api/notes/${id}`, { title: 'x' })).status).toBe(403);
  expect((await call(t, m, 'DELETE', `/api/notes/${id}`)).status).toBe(403);
  expect((await call(t, await as(bob), 'GET', `/api/notes/${id}`)).status).toBe(404);
  expect((await call(t, await as(carol), 'GET', `/api/notes/${id}`)).status).toBe(404);
  expect((await call(t, await as(admin), 'PATCH', `/api/notes/${id}`, { title: 'Hotel (fixed)' })).status).toBe(200);
});

test('ownership and team cannot be smuggled in, and nothing changes', async () => {
  const a = await as(alice);
  const before = (await t.db.select().from(notes)).length;
  for (const extra of [{ ownerId: carol.id }, { teamId: S.id }, { canEdit: true }, { id: carol.id }, { createdAt: '2020-01-01T00:00:00Z' }]) {
    const r = await call(t, a, 'POST', '/api/notes', { title: 'x', ...extra });
    expect(r.status).toBe(400);
  }
  expect((await t.db.select().from(notes)).length).toBe(before);
  const id = (await call(t, a, 'POST', '/api/notes', { title: 'mine' })).json.note.id;
  for (const extra of [{ ownerId: carol.id }, { teamId: S.id }]) {
    expect((await call(t, a, 'PATCH', `/api/notes/${id}`, { title: 'y', ...extra })).status).toBe(400);
  }
  expect((await call(t, a, 'GET', `/api/notes/${id}`)).json.note).toMatchObject({ title: 'mine', ownerId: alice.id, teamId: N.id });
});

test('the list is scoped, newest first, and pages', async () => {
  const a = await as(alice);
  for (let i = 0; i < 3; i++) await call(t, a, 'POST', '/api/notes', { title: `page-${String(i)}` });
  const p1 = await call(t, a, 'GET', '/api/notes?limit=2');
  expect(p1.json.notes.map((n) => n.title)).toEqual(['page-2', 'page-1']);
  const p2 = await call(t, a, 'GET', `/api/notes?limit=2&cursor=${String(p1.json.nextCursor)}`);
  expect(p2.json.notes[0]?.title).toBe('page-0');
  const carolList = await call(t, await as(carol), 'GET', '/api/notes');
  expect(carolList.json.notes).toEqual([]);
  expect((await call(t, a, 'GET', '/api/notes?cursor=not-a-cursor')).status).toBe(400);
  const id0 = p1.json.notes[0]?.id ?? '';
  for (const ts of ['2026-99-99T99:99:99.000000Z', '2026-02-30T00:00:00.000000Z', '0000-01-01T00:00:00.000000Z']) {
    const bad = Buffer.from(`${ts}|${id0}`).toString('base64url');
    expect((await call(t, a, 'GET', `/api/notes?cursor=${bad}`)).status).toBe(400);
  }
  expect((await call(t, a, 'GET', '/api/notes?limit=0')).status).toBe(400);
  expect((await call(t, a, 'GET', '/api/notes?limit=101')).status).toBe(400);
});

test("you cannot attach someone else's file", async () => {
  const carolFile = await upload(carol);
  const r = await call(t, await as(alice), 'POST', '/api/notes', { title: 'x', attachmentId: carolFile });
  expect(r.status).toBe(404);
  expect(r.json.error).toBe("We couldn't find that file.");
  expect((await fileRow(carolFile))?.attachedType).toBeNull();
  // The refused create left no note behind.
  expect((await t.db.select().from(notes).where(eq(notes.title, 'x'))).length).toBe(0);
  // A manager does not own a team member's file either, and a made-up id is the same 404.
  const aliceFile = await upload(alice);
  expect((await call(t, await as(mN), 'POST', '/api/notes', { title: 'm', attachmentId: aliceFile })).status).toBe(404);
  expect((await call(t, await as(alice), 'POST', '/api/notes', { title: 'm', attachmentId: '0a000000-0000-4000-8000-0000000000ff' })).status).toBe(404);
  // Updating someone else's note with your own file is refused before the file is touched.
  const note = (await call(t, await as(alice), 'POST', '/api/notes', { title: 'a' })).json.note.id;
  const bobFile = await upload(bob);
  expect((await call(t, await as(bob), 'PATCH', `/api/notes/${note}`, { attachmentId: bobFile })).status).toBe(404);
  expect((await fileRow(bobFile))?.attachedType).toBeNull();
  // Attaching a file to someone else's note is not possible for a manager either (403, and the file stays free).
  const mFile = await upload(mN);
  expect((await call(t, await as(mN), 'PATCH', `/api/notes/${note}`, { attachmentId: mFile })).status).toBe(403);
  expect((await fileRow(mFile))?.attachedType).toBeNull();
});

test('an admin may attach any file; the file keeps its owner', async () => {
  const f = await upload(alice);
  const r = await call(t, await as(admin), 'POST', '/api/notes', { title: 'admin note', attachmentId: f });
  expect(r.status).toBe(201);
  expect(r.json.note.attachment?.ownerId).toBe(alice.id);
});

test('a file already attached to a different note is refused with 409', async () => {
  const a = await as(alice);
  const f = await upload(alice);
  const first = (await call(t, a, 'POST', '/api/notes', { title: 'one', attachmentId: f })).json.note.id;
  const again = await call(t, a, 'POST', '/api/notes', { title: 'two', attachmentId: f });
  expect(again.status).toBe(409);
  expect((await t.db.select().from(notes).where(eq(notes.title, 'two'))).length).toBe(0);
  const other = (await call(t, a, 'POST', '/api/notes', { title: 'three' })).json.note.id;
  expect((await call(t, a, 'PATCH', `/api/notes/${other}`, { attachmentId: f })).status).toBe(409);
  // The file stays with the first note, and sending the same file again to that note is harmless.
  expect((await call(t, a, 'GET', `/api/notes/${first}`)).json.note.attachment?.id).toBe(f);
  expect((await call(t, a, 'PATCH', `/api/notes/${first}`, { attachmentId: f })).status).toBe(200);
});

test('detaching or replacing a photo removes the old file and its object; deleting the note does too', async () => {
  const a = await as(alice);
  const f1 = await upload(alice);
  const f2 = await upload(alice);
  const id = (await call(t, a, 'POST', '/api/notes', { title: 'photos', attachmentId: f1 })).json.note.id;
  const key1 = (await fileRow(f1))!.storageKey;
  expect(objectExists(key1)).toBe(true);
  const rep = await call(t, a, 'PATCH', `/api/notes/${id}`, { attachmentId: f2 });
  expect(rep.json.note.attachment?.id).toBe(f2);
  expect(await fileRow(f1)).toBeUndefined();
  expect(objectExists(key1)).toBe(false);
  const key2 = (await fileRow(f2))!.storageKey;
  expect((await call(t, a, 'PATCH', `/api/notes/${id}`, { attachmentId: null })).json.note.attachment).toBeNull();
  expect(await fileRow(f2)).toBeUndefined();
  expect(objectExists(key2)).toBe(false);
  const f3 = await upload(alice);
  const id2 = (await call(t, a, 'POST', '/api/notes', { title: 'gone', attachmentId: f3 })).json.note.id;
  const key3 = (await fileRow(f3))!.storageKey;
  expect((await call(t, a, 'DELETE', `/api/notes/${id2}`)).status).toBe(204);
  expect(await fileRow(f3)).toBeUndefined();
  expect(objectExists(key3)).toBe(false);
});

test('a discarded photo that was re-attached before removal keeps its row and its object', async () => {
  const a = await as(alice);
  const f = await upload(alice);
  const row = (await fileRow(f))!;
  // After the commit that discarded it the file is unattached; the owner now attaches it to another note, then removal runs.
  const id = (await call(t, a, 'POST', '/api/notes', { title: 'rescued', attachmentId: f })).json.note.id;
  await removeDiscarded(t.db, { storage: new LocalDiskStorage(t.config.uploadDir) }, [{ id: f, storageKey: row.storageKey }]);
  expect(await fileRow(f)).toBeDefined();
  expect(objectExists(row.storageKey)).toBe(true);
  const served = await t.app.inject({ method: 'GET', url: `/api/files/${f}/content`, headers: { cookie: a.cookie } });
  expect(served.statusCode).toBe(200);
  expect(served.rawPayload.length).toBe(png.length);
  expect((await call(t, a, 'GET', '/api/notes')).json.notes.find((n) => n.id === id)?.attachment?.id).toBe(f);
});

test('writes are audited in the same transaction, with field names only', async () => {
  const a = await as(alice);
  const id = (await call(t, a, 'POST', '/api/notes', { title: 'Private title', body: 'SECRET-BODY-TEXT' })).json.note.id;
  await call(t, a, 'PATCH', `/api/notes/${id}`, { body: 'SECRET-NEW-BODY', title: 'Other title' });
  await call(t, a, 'DELETE', `/api/notes/${id}`);
  const rows = (await t.db.select().from(auditLog).where(eq(auditLog.targetId, id))).sort((x, y) => x.id - y.id);
  expect(rows.map((r) => r.action)).toEqual(['note.created', 'note.updated', 'note.deleted']);
  expect(rows[1]!.details).toEqual({ fields: ['body', 'title'] });
  expect(JSON.stringify(rows)).not.toContain('SECRET');
  // A refused change writes nothing.
  const other = (await call(t, await as(bob), 'POST', '/api/notes', { title: 'b' })).json.note.id;
  const n = (await t.db.select().from(auditLog)).length;
  expect((await call(t, a, 'PATCH', `/api/notes/${other}`, { title: 'z' })).status).toBe(404);
  expect((await t.db.select().from(auditLog)).length).toBe(n);
});

test('the clock handed to the repo stamps new and changed notes', async () => {
  const fixed = new Date('2031-05-06T07:08:09.000Z');
  const later = new Date('2031-05-07T07:08:09.000Z');
  const actor = { id: alice.id, email: alice.email, name: 'Alice', role: 'member' as const, teamId: N.id };
  const note = await createNote(t.db, actor, { title: 'clocked', body: '', attachmentId: null }, { now: fixed });
  expect(note.createdAt).toBe(fixed.toISOString());
  const upd = await updateNote(t.db, actor, note.id, { title: 'clocked 2' }, { now: later, storage: new LocalDiskStorage(t.config.uploadDir) });
  expect(upd).toMatchObject({ createdAt: fixed.toISOString(), updatedAt: later.toISOString() });
});

test('a change that changes nothing is not audited and does not bump updated_at', async () => {
  const a = await as(alice);
  const f = await upload(alice);
  const made = (await call(t, a, 'POST', '/api/notes', { title: 'same', body: 'text', attachmentId: f })).json.note;
  const plain = (await call(t, a, 'POST', '/api/notes', { title: 'plain' })).json.note;
  const n = (await t.db.select().from(auditLog)).length;
  for (const [id, patch] of [[made.id, { attachmentId: f }], [made.id, { title: 'same', body: 'text' }], [plain.id, { attachmentId: null }], [plain.id, {}]] as const) {
    const r = await call(t, a, 'PATCH', `/api/notes/${id}`, patch);
    expect(r.status).toBe(200);
    expect(r.json.note.updatedAt).toBe(id === made.id ? made.updatedAt : plain.updatedAt);
  }
  expect((await t.db.select().from(auditLog)).length).toBe(n);
  expect((await fileRow(f))?.attachedId).toBe(made.id);
});

test('if the update fails after the photo is swapped, the note keeps its original photo and the object stays', async () => {
  const a = await as(alice);
  const f1 = await upload(alice);
  const f2 = await upload(alice);
  const id = (await call(t, a, 'POST', '/api/notes', { title: 'safe', attachmentId: f1 })).json.note.id;
  const key1 = (await fileRow(f1))!.storageKey;
  await t.db.execute(sql`create function hf_fail_note_audit() returns trigger language plpgsql as $$ begin if new.action in ('note.updated','note.deleted') then raise exception 'forced failure'; end if; return new; end $$`);
  await t.db.execute(sql`create trigger hf_fail_note_audit before insert on audit_log for each row execute function hf_fail_note_audit()`);
  try {
    expect((await call(t, a, 'PATCH', `/api/notes/${id}`, { attachmentId: f2 })).status).toBe(500);
    expect((await call(t, a, 'DELETE', `/api/notes/${id}`)).status).toBe(500);
  } finally {
    await t.db.execute(sql`drop trigger hf_fail_note_audit on audit_log`);
    await t.db.execute(sql`drop function hf_fail_note_audit()`);
  }
  expect((await call(t, a, 'GET', `/api/notes/${id}`)).json.note.attachment?.id).toBe(f1);
  expect(await fileRow(f1)).toMatchObject({ attachedType: 'note', attachedId: id });
  expect(objectExists(key1)).toBe(true);
  expect((await fileRow(f2))?.attachedType).toBeNull();
});
