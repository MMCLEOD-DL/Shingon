# Task 10: Example feature — notes (API)

This is the "tiny example feature proving the pattern end to end". It is deliberately shaped like the first client job (an expense with a receipt):
- a member creates a note with an optional attached photo;
- their manager can view their team's notes but not edit them;
- an admin can do anything.

Every rule the factory must follow for a client feature appears here once: a shared schema, an actor-first repository with `visibleTo`, `defineRoute` with a permission, audit in the same transaction, crossing cases, and (Tasks 13 and 15) pages and demo data. `docs/BUILDING-ON.md` (Task 21) points to these files as the template.

**Files:**
- Create: `apps/server/src/db/schema/notes.ts`, `apps/server/src/notes/{repo,routes}.ts`, `apps/server/test/crossing/resources/notes.ts`
- Modify: `packages/shared/src/schemas.ts` (notes), `apps/server/src/app.ts`, `apps/server/test/crossing/{cases.ts,resources/index.ts}`
- Test: `apps/server/test/notes.test.ts`

**Interfaces:**
- Consumes: `visibleTo`/`canSee`/`canEdit` (Task 4), `audit` (Task 5), `attachFile`/`getVisibleFile` (Task 9), the crossing harness (Task 8).
- Produces:
  - `@hf/shared`:
    - The input schemas are built from one base with **no defaults**, because in Zod 4 `.partial()` keeps field defaults. Checked with zod 4: `z.strictObject({ title: z.string(), body: z.string().default('') }).partial().parse({ title: 'x' })` returns `{ title: 'x', body: '' }`. So `CreateNoteInput.partial()` would make `PATCH { title }` silently wipe the body and detach the photo. The pattern, which every client resource copies:

```ts
// packages/shared/src/schemas.ts
const NoteFields = z.strictObject({
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10000),
  attachmentId: z.uuid().nullable(),        // null detaches
});
export const CreateNoteInput = NoteFields.extend({
  body: NoteFields.shape.body.default(''),
  attachmentId: NoteFields.shape.attachmentId.default(null),
});
export const UpdateNoteInput = NoteFields.partial();   // no defaults: an absent field means "leave it alone"
```

    - Both stay strict (`extend` and `partial` keep `strictObject`'s unknown-key refusal).
    - `NoteView = { id, title, body, ownerId, ownerName, teamId, attachment: FileView | null, createdAt, updatedAt, canEdit: boolean }`
  - `apps/server/src/notes/repo.ts`, each function taking `actor` first:
    - `listNotes(db, actor, { cursor?: string; limit: number }): Promise<{ notes: NoteView[]; nextCursor: string | null }>`: newest first; the cursor is the base64url of `createdAt|id`.
    - `getNote(db, actor, id): Promise<NoteView | null>`
    - `createNote(db, actor, input, ip?): Promise<NoteView>`
    - `updateNote(db, actor, id, input, ip?): Promise<NoteView>`: throws `notFound()` when the note is not visible and `forbidden()` when visible but not editable.
    - `deleteNote(db, actor, id, ip?): Promise<void>`: same rules. It also deletes the attachment row and the object.
  - Routes:
    - `GET /api/notes` [`notes:read`], query `{ cursor?, limit = 20 (1–100) }`
    - `POST /api/notes` [`notes:create`] → 201 `{ note }`
    - `GET /api/notes/:id` [`notes:read`]
    - `PATCH /api/notes/:id` [`notes:update`]
    - `DELETE /api/notes/:id` [`notes:delete`] → 204
  - `attachmentId` must be a file the actor may **edit** (their own, or any file for an admin). Otherwise the answer is 404 `We couldn't find that file.` Then `attachFile(tx, actor, id, { type: 'note', id })` runs.

Table `notes`:
- `id uuid pk`, `owner_id uuid not null references users(id)`, `team_id uuid null` (the owner's team at creation);
- `title text not null`, `body text not null default ''`, `attachment_file_id uuid null references files(id) on delete set null`;
- `created_at`, `updated_at`;
- an index on `(team_id, created_at desc)` and on `(owner_id, created_at desc)`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/notes.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let N: any, S: any, admin: any, mN: any, alice: any, bob: any, carol: any;
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

const as = async (u: any) => signInAs(t, u);

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
  const png = readFileSync(new URL('./fixtures/files/tiny.png', import.meta.url));
  const up = await t.app.inject({ method: 'POST', url: '/api/files', headers: { cookie: a.cookie, origin: 'http://hf.test', 'content-type': 'multipart/form-data; boundary=b' },
    payload: Buffer.concat([Buffer.from(`--b\r\nContent-Disposition: form-data; name="file"; filename="r.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from('\r\n--b--\r\n')]) });
  const fileId = up.json().file.id;
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

test('ownership and team cannot be smuggled in', async () => {
  const a = await as(alice);
  for (const extra of [{ ownerId: carol.id }, { teamId: S.id }, { canEdit: true }]) {
    const r = await call(t, a, 'POST', '/api/notes', { title: 'x', ...extra });
    expect(r.status).toBe(400);
  }
});

test('the list is scoped, newest first, and pages', async () => {
  const a = await as(alice);
  for (let i = 0; i < 3; i++) await call(t, a, 'POST', '/api/notes', { title: `page-${i}` });
  const p1 = await call(t, a, 'GET', '/api/notes?limit=2');
  expect(p1.json.notes.map((n: any) => n.title)).toEqual(['page-2', 'page-1']);
  const p2 = await call(t, a, 'GET', `/api/notes?limit=2&cursor=${p1.json.nextCursor}`);
  expect(p2.json.notes[0].title).toBe('page-0');
  const carolList = await call(t, await as(carol), 'GET', '/api/notes');
  expect(carolList.json.notes).toEqual([]);
});

test("you cannot attach someone else's file", async () => {
  // carol uploads; alice tries to attach carol's file id
  const boundary = 'b';
  const png = readFileSync(new URL('./fixtures/files/tiny.png', import.meta.url));
  const up = await t.app.inject({ method: 'POST', url: '/api/files', headers: { cookie: (await as(carol)).cookie, origin: 'http://hf.test', 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([Buffer.from(`--b\r\nContent-Disposition: form-data; name="file"; filename="c.png"\r\nContent-Type: image/png\r\n\r\n`), png, Buffer.from('\r\n--b--\r\n')]) });
  const r = await call(t, await as(alice), 'POST', '/api/notes', { title: 'x', attachmentId: up.json().file.id });
  expect(r.status).toBe(404);
  expect(r.json.error).toBe("We couldn't find that file.");
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project apps/server test/notes.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the schema, repo and routes**

- The repo joins `users` (for `ownerName`) and `files` (for the attachment), and filters with `visibleTo(actor, { owner: notes.ownerId, team: notes.teamId })`.
- `canEdit` in `NoteView` is computed with `canEdit(actor, row)`.
- Each mutation runs in one transaction with `audit('note.created' | 'note.updated' | 'note.deleted', { targetType: 'note', targetId })`.
- `details` for an update hold the list of changed field names only, never the body text, because notes may hold personal data.
- Generate the migration: `db:generate -- --name notes`.

- [ ] **Step 4: Add the crossing coverage**

- `resources/notes.ts` seeds one note per non-anon actor, titled `CANARY-note-<key>`, with `table: 'notes'`.
- Add to `EXPECTED_ROLES` (by hand): `'GET /api/notes': ALL`, `'POST /api/notes': ALL`, `'GET /api/notes/:id': ALL`, `'PATCH /api/notes/:id': ALL`, `'DELETE /api/notes/:id': ALL`. Who may edit a given note is the item rule (`allowed`), not a role rule.
- Add to `CASES`:

```ts
{ kind: 'list', route: 'GET /api/notes', resource: 'note' },
{ kind: 'item', route: 'GET /api/notes/:id', resource: 'note' },
{ kind: 'item', route: 'PATCH /api/notes/:id', resource: 'note', body: () => ({ title: 'Changed' }), mutates: true,
  allowed: (a, r) => a.role === 'admin' || a.id === r.ownerId },
{ kind: 'item', route: 'DELETE /api/notes/:id', resource: 'note', mutates: true,
  allowed: (a, r) => a.role === 'admin' || a.id === r.ownerId },
{ kind: 'action', route: 'POST /api/notes', body: () => ({ title: 'New' }), mutates: true,
  forbiddenFields: [{ ownerId: IDS.users.southCarol }, { teamId: IDS.teams.south }] },
```

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: all tests PASS (6 new), and the crossing report shows `0 problems`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: notes example feature — scoped repo, attachments, audit, crossing cases

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
