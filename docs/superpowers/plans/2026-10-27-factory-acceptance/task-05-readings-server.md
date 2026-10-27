# Task 5: Readings on the server

**Repo: `/root/highland-foundation`.**

This task connects the OCR module to the app: a **reading** belongs to an uploaded file, is produced in the background by a small queue, and is then **confirmed or corrected** by a person (spec §2.5; Rulings 1, 5, 6). It follows the notes feature's pattern from `docs/BUILDING-ON.md` point by point: strict schemas, an actor-first repository, `defineRoute`, audit in the same transaction, hand-written crossing cases, and a demo seeder.

**Files:**
- Create: `apps/server/src/db/schema/receiptReadings.ts` (exported from the schema `index.ts`), the generated migration in `apps/server/drizzle/` (`npm -w @hf/server run db:generate`)
- Create: `apps/server/src/modules/ocr/{queue,repo,routes,index}.ts`
- Create: `apps/server/test/crossing/resources/readings.ts`, `apps/server/src/seed/seeders/receipts.ts`, `apps/server/src/seed/receipts/{cafe,taxi}.jpg` (copied from Task 3's `*-photo.jpg`)
- Modify: `packages/shared/src/access.ts` (`readings:read`, `readings:confirm`), `apps/server/src/audit/audit.ts` (`AUDIT_ACTIONS`), `apps/server/src/app.ts` (register when `moduleOn(cfg, 'ocr')`; `deps.ocrEngine`), `apps/server/src/main.ts` (build the engine with `chooseEngine`, start the queue, stop both on close), `apps/server/package.json` (dependency `@hf/ocr`), `apps/server/test/helpers/testApp.ts` (every module on by default; `ocrEngine` override), `apps/server/test/crossing/{cases.ts,resources/index.ts}`, `apps/server/src/seed/seeders/index.ts`, `apps/server/src/e2e-server.ts` (every module on, a fake engine with fixed answers), `CHANGELOG.md`
- Test: `apps/server/test/readings.test.ts`, `apps/server/test/reading-queue.test.ts`, `apps/server/test/modules-optin.test.ts`

**Interfaces:**
- Consumes: `defineRoute`, `visibleTo`, `canSee`, `canEdit`, `audit`, `getVisibleFile`, `Storage` (Plan 6); `moduleOn`, `Config.ocr`, `Config.profile` (Task 1); `ReadingView`, `ConfirmReadingInput`, `correctedFields` (Task 2); `OcrEngine`, `readReceipt`, `UnreadableError` (Task 3); `chooseEngine`, `createAzureReceiptEngine`, `createLocalEngine`, `OcrPolicyError` (Task 4).
- Produces: the three routes, `startReadingQueue`, `ReadingQueue`, `buildApp` dep `ocrEngine` (index). `createTestApp` turns **every module on** unless `profile` is overridden, and adds two things to its result:
  - `t.readings: ReadingQueue` (so tests can `await t.readings.idle()`);
  - `t.fakeOcr`: the default engine (`id 'fake'`, kind `local`). Its `read` returns the lines of a Task 2 text fixture: `taxi.txt` unless the test called `t.fakeOcr.next('<fixture>.txt')` or `t.fakeOcr.fail(error)` for the next read; for `image/heic` it throws the same `UnreadableError` as the local engine. It lives in `apps/server/test/helpers/fakeOcr.ts` and is reused by `e2e-server.ts`.
  - Test helpers `upload(t, user, fixture)`, `readingFor(t, user, textFixture)` (upload, request, wait, return the reading id) and `lastAudit(db, action)` go in `apps/server/test/helpers/readings.ts`.

Table `receipt_readings`:
- `id uuid pk`, `file_id uuid not null unique references files(id) on delete cascade`;
- `owner_id uuid not null references users(id)`, `team_id uuid null` (both copied from the file, never from the request);
- `status text not null check (status in ('pending','read','unreadable','confirmed'))`;
- `engine text null`, `proposal jsonb null`, `problem text null`;
- `confirmed jsonb null`, `corrected text[] not null default '{}'`;
- `created_at`, `updated_at`, `read_at null`, `confirmed_at null`; index on `(status, created_at)`.

Rules:
- `POST /api/files/:id/reading` [`readings:read`], no body (`z.strictObject({})`):
  - the file must be visible **and** editable by the actor, otherwise **404** (Ruling 6);
  - a confirmed reading for that file → **409** `This receipt has already been confirmed.`;
  - otherwise insert, or reset an existing one to `pending` (clearing `proposal`/`problem`), enqueue, audit `reading.requested` (`targetType 'file'`), answer **202** `{ reading }`;
  - rate limit: 60 per 15 minutes per user, as uploads.
- `GET /api/readings/:id` [`readings:read`]: through `visibleTo` (not visible → 404) → 200 `{ reading }`.
- `POST /api/readings/:id/confirm` [`readings:confirm`], body `ConfirmReadingInput`:
  - not visible → 404; visible but not `canEdit` → 403;
  - `pending` → 409 `Still reading this receipt. Try again in a moment.`; `confirmed` → 409 `This receipt has already been confirmed.`;
  - otherwise set `confirmed`, `corrected = correctedFields(proposal, input)`, `status 'confirmed'`, `confirmed_at`; audit `reading.confirmed` with `details: { corrected }` (**field names only**, never values) → 200 `{ reading }`.
- The queue (`startReadingQueue`): on start it loads every `pending` row (oldest first) and processes at most `concurrency` at once. For each: load the row and its file, read the stored bytes (refuse more than `maxBytes`), `engine.read`, `readReceipt(result, today())`, then `status 'read'` with `proposal` and `engine`. An `UnreadableError` gives `status 'unreadable'` with `problem = userMessage`. Any other error gives `unreadable` with `This receipt couldn't be read automatically. Please type the details.` and a log line without any receipt content. A row deleted meanwhile is skipped silently.
- `main.ts`: when `ocr` is on, `chooseEngine(cfg.profile, cfg.ocr, { local: () => createLocalEngine({ workers: cfg.ocr.concurrency, timeoutMs: cfg.ocr.timeoutMs }), azure: createAzureReceiptEngine })`. An `OcrPolicyError` is printed as its problems (one per line) and the process exits 1 before listening, like a `ConfigError`. `today()` is the date in `Europe/London`.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/readings.test.ts` (uses `createTestApp()`, `makeTeam`/`makeUser`, the fake engine; uploads go through `POST /api/files` with Task 3's `taxi-photo.jpg`):

```ts
test('owner asks for a reading, it is read, and the proposal comes back with confidences', async () => {
  const f = await upload(t, alice, 'taxi-photo.jpg');
  const r = await call(t, aliceAuth, 'POST', `/api/files/${f.id}/reading`, {});
  expect(r.status).toBe(202);
  expect(r.json.reading).toMatchObject({ fileId: f.id, status: 'pending', proposal: null });
  await t.readings.idle();
  const g = await call(t, aliceAuth, 'GET', `/api/readings/${r.json.reading.id}`);
  expect(g.json.reading).toMatchObject({ status: 'read', engine: 'fake', proposal: { amountPence: { value: 1240 }, vatPence: { value: 207 }, date: { value: '2026-03-12' } } });
});

test('confirming records which fields staff corrected, and audits names only', async () => {
  const id = await readingFor(t, alice, 'taxi.txt');
  const c = await call(t, aliceAuth, 'POST', `/api/readings/${id}/confirm`, { amountPence: 1240, vatPence: 207, date: '2026-03-12', merchant: 'Northside Taxis Ltd' });
  expect(c.status).toBe(200);
  expect(c.json.reading).toMatchObject({ status: 'confirmed', corrected: ['merchant'], confirmed: { merchant: 'Northside Taxis Ltd' } });
  const a = await lastAudit(t.db, 'reading.confirmed');
  expect(a.details).toEqual({ corrected: ['merchant'] });
  expect(JSON.stringify(a)).not.toContain('Northside');
});

test('a second confirm and a re-read of a confirmed receipt are refused', async () => { /* both 409 with the sentences above */ });
test('confirming while still reading is refused with 409', async () => { /* engine held open by a deferred promise */ });
test('VAT above the total and extra keys are refused with 400 and nothing changes', async () => {
  /* { ..., vatPence: 1300, amountPence: 1240 } -> 400 "The VAT can't be more than the total."; { ..., ownerId } -> 400; row unchanged */
});
test('a manager sees the team reading but cannot confirm it (403); another team gets 404', async () => {});
test('a member cannot ask for a reading of a file they can see but do not own (404)', async () => {});
test('deleting the file deletes its reading', async () => { /* DELETE /api/files/:id -> GET reading 404, no row left */ });
test('a HEIC upload ends as unreadable with the sentence staff see', async () => {
  /* upload tiny.heic; the fake engine delegates HEIC to the real local rule -> status 'unreadable', problem "Photos in HEIC format can't be read automatically. …" */
});
test('an engine crash ends as unreadable with the general sentence and logs no receipt text', async () => {});
test('no proposal ever contains the raw recognised text', async () => {
  /* the stored row's columns hold only proposal/confirmed/corrected/problem; none contains a line of the fixture that is not a field value */
});
```

`apps/server/test/reading-queue.test.ts`:
- `'pending rows left by a restart are read on start, oldest first'`: insert two `pending` rows directly, start a queue with a fake engine that records order → both `read`, in creation order.
- `'never more than the set number at once'`: concurrency 1, three readings, the fake engine records the maximum number in flight → 1.
- `'a reading whose row vanished meanwhile is skipped'`: delete the row while the engine is working → no error, no row re-created.
- `'stop waits for the current reading and starts no more'`.

`apps/server/test/modules-optin.test.ts`:
- `'with ocr off, no reading route exists and no engine is started'`: `createTestApp({ profile: DEFAULT_PROFILE })` → `app.hf.allRoutes` has no `/api/readings` or `/reading` route; `POST /api/files/:id/reading` → 404.
- `'the crossing world runs with every module on'`: the crossing test's app has `profile.modules` equal to `MODULES` (guards Ruling 7).

Crossing (`cases.ts`, typed by hand):
- `EXPECTED_ROLES`: `'POST /api/files/:id/reading': ALL`, `'GET /api/readings/:id': ALL`, `'POST /api/readings/:id/confirm': ALL`.
- `CASES`:
  - item, `POST /api/files/:id/reading`, resource `files`, `visible: (a, r) => a.role === 'admin' || r.ownerId === a.id`, `okStatus: 202`, `mutates: true`, `why: 'asking for a reading needs edit rights on the file; others get 404 as with attachFile'`;
  - item, `GET /api/readings/:id`, resource `readings` (default visibility);
  - item, `POST /api/readings/:id/confirm`, resource `readings`, `allowed: (a, r) => a.role === 'admin' || r.ownerId === a.id`, body a valid confirmation, `mutates: true`, `forbiddenFields: [{ ownerId: '…' }, { teamId: '…' }, { status: 'confirmed' }, { corrected: [] }, { fileId: '…' }]`.
- `resources/readings.ts`: each world actor gets one `read` reading on one of their files, with the canary text as the proposed merchant.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/server/test/readings.test.ts apps/server/test/reading-queue.test.ts apps/server/test/modules-optin.test.ts`
Expected: FAIL (routes and queue missing).

- [ ] **Step 3: Implement** the table, migration, repository (actor first, `visibleTo` on every read), routes, queue and `main.ts` wiring as specified above. The demo seeder (`seeders/receipts.ts`, only when `ocr` is on) gives the first Operations member one `confirmed` reading (cafe photo) and one `read` reading with a low-confidence VAT (taxi photo), with fixed proposals, so the pages in Task 6 have something to show.

- [ ] **Step 4: Run the tests and the crossing gate**

Run: `npx vitest run apps/server` → PASS, including `crossing.test.ts` with the three new routes and `apps/server/reports/crossing.md` reporting 0 problems.
Run: `npm run verify` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ocr): readings on the server — background queue, confirm or correct, audit of corrected field names, crossing cases, demo data

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
