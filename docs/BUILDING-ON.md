# Building a client app on the foundation

This guide is for whoever builds the next client app: a person, or the factory. The foundation already has accounts, roles and teams, files, email, an activity log, backups, monitoring and safe updates. A client app adds its own features on top, following the **notes** feature as the worked example, and leaves the foundation's own parts alone so that later foundation fixes can be merged in cleanly.

## Starting a client app

1. Clone the foundation **at a release tag** into a new repository for the client, never from a branch:

   ```bash
   git clone --branch v0.2.0 https://<foundation repo> acme-expenses
   cd acme-expenses
   git checkout -b main
   git remote rename origin foundation        # the foundation stays reachable as "foundation", for later merges
   git remote add origin https://<client repo>
   npm ci && npm run verify
   ```

2. **Keep `foundation.json` untouched.** It records which foundation release the app is built from (`/api/version` reports it to the health token holder), and it is how anyone can tell which `[security]` fixes an app has.
3. The `foundation` remote is how fixes arrive later (see "Taking foundation fixes"). Do not delete it.
4. **Rename the app in the root `package.json`** (`"name": "acme-expenses"`, not `highland-foundation`). The release script stamps `foundation.json` only when the name is `highland-foundation`, so an app that keeps the foundation's name would overwrite the record of which foundation it is built from at every release. (The factory does this for you.)
5. The app's own version starts from the foundation's and is raised with `npm run release -- patch|minor|major` like any release. (`npm run release -- first` is only for the foundation's own very first release, v0.1.0: it is refused once any `v*` tag exists, and a clone made at a release tag already has one.)

## Making it theirs

For the look, edit exactly two things and nothing else:
- `apps/web/src/brand.ts`: the app's name and short name.
- The palette in `apps/web/src/theme.ts`: the ten-shade colour list (keep it ten shades, light to dark) and, if needed, `primaryShade`.

Leave the rest of the theme alone: its sizes keep every button and field big enough to tap on a phone, and the system font stack means no web fonts and no font licences. The display name staff see in emails comes from `APP_NAME` in each deployment's `.env`.

## Adding a feature (follow notes)

Copy the notes feature, piece by piece. Every item below is checked by a test or a gate; a feature is not done until all of them are in place.

- [ ] **Shared schema** in `packages/shared/src/schemas.ts`, using `z.strictObject` for every input, so unknown keys (a member sending `role: "admin"` or `ownerId`) are refused with 400.
- [ ] **The update schema is built from a base with no defaults** (`Fields.partial()`), and only the create schema adds defaults. In Zod 4, `.partial()` keeps defaults, so `CreateX.partial()` would make a one-field edit silently reset every other defaulted field. See `NoteFields`, `CreateNoteInput` and `UpdateNoteInput` in `packages/shared/src/schemas.ts`, and the "a partial update changes only the fields sent" test in `apps/server/test/notes.test.ts`.
- [ ] **A table with `owner_id` and `team_id`**: a Drizzle schema file in `apps/server/src/db/schema/` (exported from its `index.ts`, like `notes.ts`), then `npm -w @hf/server run db:generate` to write the migration into `apps/server/drizzle`, and commit both. The owner and team are set from the signed-in actor, never from the request.
- [ ] **An actor-first repository** (`apps/server/src/notes/repo.ts`): every function takes the actor, and every query that returns rows filters with `visibleTo(actor, { owner, team })`. Load the row through `visibleTo` first (not seen means 404), then check `canEdit` (seen but not allowed means 403).
  - **Lists use a cursor, and the cursor is validated** before it reaches the database: decode it, check its exact shape (timestamp and UUID), check the date really exists, and answer 400 "That page link is not valid" otherwise (`decodeCursor`). A bad cursor must never cause a 500.
  - **No-op changes are not audited:** compare each field with the current value and only count real changes; an update that changes nothing writes no audit row and does not touch `updated_at`.
  - **Attaching a file:** use `attachFile`. A file the actor does not own (or cannot edit) is answered **404, on purpose**, the same as a file that does not exist, so nobody can probe other people's file ids.
  - **Discarded files are deleted after the commit,** never inside the transaction: inside it the file is only detached; `removeDiscarded` removes the row and the stored object afterwards. A failed transaction then never loses a photo, and anything left over is collected by the sweep.
- [ ] **Routes with `defineRoute` and a permission** (`apps/server/src/notes/routes.ts`, registered in `apps/server/src/app.ts` next to `registerNoteRoutes`): every route declares `access: { permission: … }` (or `{ public: '<reason>' }`, rarely), with `params`, `query` and `body` schemas, including `z.strictObject({})` for routes that take no query.
- [ ] **Audit in the same transaction** as the change (`audit(tx, …)`), recording field names only, never the text of the record (it may be personal data).
- [ ] **Crossing cases**, written by hand, in `apps/server/test/crossing/cases.ts`:
  - the route's roles **typed by hand** into `EXPECTED_ROLES` (or the route in `EXPECTED_PUBLIC` if it really is public);
  - one case per route (`item`, `list` or `action`), with `forbiddenFields` listing every field a caller must not set (`ownerId`, `teamId`, `id`, `createdAt` and so on);
  - `paginate` on every paginated list, so every page is checked, not just the first;
  - a **resource seeder** in `apps/server/test/crossing/resources/` (added to `RESOURCE_SEEDERS`) that gives each test actor rows carrying their own canary text, so a leak of anyone else's data is caught.
- [ ] **Pages built from house components** (`apps/web/src/ui`: `PageHeader`, `ResponsiveList`, `FormCard`, `EmptyState`, `ConfirmAction`, `FileDropzone`, `ErrorNotice`), in their own folder under `apps/web/src/pages/` (like `pages/notes/`). For every new page:
  - the route element in `apps/web/src/routes.tsx` (like `{ path: '/notes/:id', element: <NoteView /> }`);
  - its path in `APP_PATHS` in `apps/web/src/appPaths.ts`, with `auth` and, if only some roles may open it, `permission`. Nothing checks `routes.tsx` against `APP_PATHS`, so keep the two in step by hand;
  - a **`PAGES` entry** in `apps/web/e2e/pages.ts`, so it is screenshot on desktop and phone and checked for sideways scrolling and small tap targets (the registry test fails while any `APP_PATHS` entry has no `PAGES` entry);
  - a `NAV` entry in `apps/web/src/nav.ts` if it belongs in the menu.
- [ ] **A demo seeder** in `apps/server/src/seed/seeders/` (one file, plus its import line in `seeders/index.ts`), using `ctx.faker` so the same seed gives the same data.

## Numbers people rely on

Spec §2.2: every total, VAT amount and report figure gets a test built from the brief's worked examples **before** the feature counts as done. Write the examples from the client's brief into the test first (for example "3 items at £4.99 with 20% VAT come to £17.96"), watch it fail, then build the feature.

- Store and calculate money as **whole pence in integers**, never as floating-point pounds (`0.1 + 0.2` is not `0.3`). Convert to pounds only for display.
- Write down the rounding rule (per line or per invoice, half up) as a test.
- Dates are stored in UTC and shown in UK time (`Europe/London`); test reports that cross the clock change.

## Permissions

Roles are `admin`, `manager` and `member`. Permissions live in `PERMISSIONS` in `packages/shared/src/access.ts`, each listing the roles that hold it. To add one, add a line such as `'expenses:approve': ['admin', 'manager']` and use it in `defineRoute`. A new role is added to `ROLES` and to every permission it should hold. Client apps extend this table; they do not rewrite the model (admin sees everything, a manager sees their team, a member sees their own rows; only the owner or an admin edits).

The crossing harness's two tables must then be updated **by hand**:
- `apps/server/test/crossing/oracle.ts`: **who can see which rows**, typed out from the policy;
- `EXPECTED_ROLES` in `apps/server/test/crossing/cases.ts`: **which roles may call each route**.

Both are deliberately independent of the app's own `PERMISSIONS` and `can()`: they never import them, so a mistake in the app cannot hide a mistake in the test. If a route's declared permission lets in more roles than `EXPECTED_ROLES` says, the harness fails with a plain sentence naming both, for example "GET /api/expenses lets admin, manager and member in (permission expenses:read), but the crossing table says only admin and manager should." So a too-broad permission cannot pass. A route missing from the tables fails the coverage gate too.

Users are **disabled, never deleted**: the activity log keeps a reference to them (`audit_log.actor_id` cannot point at a removed user). A disabled user's sessions stop working on their next request.

## Optional modules

Four parts of the foundation are switched off until an app asks for them: `ocr` (reading receipts), `pdf-export` and `xlsx-export` (money reports as PDF and spreadsheet files) and `scheduled-jobs` (jobs that run on a timetable). An app switches them on in **`app-profile.json`** at the root of the repository, which also holds the client's data policy:

```json
{ "schema": 1, "modules": ["ocr", "xlsx-export"], "policy": { "outbound": [], "residency": "uk" } }
```

The factory writes this file from the approved brief: Plan 8's `nameApp` at the first build, in the same commit as the BRAND line, and Plan 11 when a change request changes the modules or the policy (Contract 7.5). Do not edit it by hand in a factory-built app. The file is read once, at start-up, by the server, by ops and by the web build: a module that is not listed registers no routes, starts no queue or worker and shows no pages. A missing file means no modules and no outbound services; a malformed one stops the app at start with a plain sentence. The images carry the file (`deploy/Dockerfile` copies it before the web build and into the running image), so a box runs exactly the modules its release was built with. The tests always run with every module on (`HF_ALL_MODULES=1` for the browser tests), so a module's routes are always checked by the crossing harness.

### Reading receipts (`ocr`)

Copy the receipts pages' pattern (`apps/web/src/pages/ocr/`: `ReceiptNew`, `ReceiptCheck` and `ReceiptReadingFields`, with the server side in `apps/server/src/modules/ocr/`):

- **Staff always confirm.** The reading only *proposes* a total, VAT, date and merchant, each with a confidence; fields below 0.85 say "Please check". Nothing is saved as an expense value until a person presses Confirm.
- **Store the confirmed values, never the proposal.** A client expense row takes the values from the confirm step and keeps the reading's id. Nothing reads `proposal` after confirmation: it is what the machine guessed, not what the person agreed.
- **Corrected field names are audited** (names only, never the values), as the confirm route already does.
- **The receipt file belongs to its reading** (attached with the parent type `receipt-reading` in the same transaction, so the orphan sweep keeps it). When your expense row takes over the photo, attach the file to the expense with `attachFile` in the same transaction as the expense, re-pointing it, so the photo follows the expense's rules from then on.
- A reading keeps no recognised text (it is personal data) and is deleted with its file.
- **Memory.** Each reader (`OCR_CONCURRENCY`, default 1) can use about 500 MB while it reads a large photo (up to 25 megapixels), and keeps it. One reader fits a 2 GB box with room to spare; each extra one needs about 500 MB more.

### Money reports (`pdf-export`, `xlsx-export`)

- Build **one** `MoneyReport` with `buildMoneyReport` (from `@hf/shared`) and hand the same object to `renderPdf`, `renderXlsx` and the screen. The exports never calculate: every subtotal and total is worked out once, in whole pence, by `buildMoneyReport`.
- **Pin it with worked examples** like `W1_MARCH` in `packages/shared/test/worked-examples.ts` (totals worked out by hand from the client's brief) before the feature counts as done.
- Serve it with `sendReport(reply, report, 'pdf' | 'xlsx', baseName)` from a `defineRoute` route, with its permission and crossing case like any other route.

### Scheduled jobs (`scheduled-jobs`)

- Declare a job with `registerAppJob` (from `@hf/server/jobs`) in its own file under `apps/server/src/jobs/`, and add one import line for it to `apps/server/src/jobs/index.ts`. Give it a name (kept once live), a label (what the operator reads in alerts and `ops jobs`), a five-part cron schedule in UK time and `catchUp`: `'once'` (run once after the box was off) or `'skip'` (wait for the next due time).
- Switch on `scheduled-jobs` in `app-profile.json`. The **ops** container runs the jobs, never the app, so a job is stopped during an update and never runs twice when the app restarts. Each due time runs at most once, even across ops restarts.
- **A job gets the database and a log only** (`ctx.db`, `ctx.log`, `ctx.dueAt` and `ctx.signal`). Ops has no mail settings and no export code paths of its own: a job that should send an email or a report must **queue the work for the app** (for example, write a row that the app's own code picks up and sends).
- **Jobs must be safe to run once late,** and should be short and idempotent. Ops stops waiting for a run after 30 minutes, records it as failed and alerts, and aborts `ctx.signal`; it cannot stop the job itself, so a long job should check `ctx.signal` (or pass it to anything that takes an `AbortSignal`) and give up cleanly. `ctx.signal` is also aborted when ops begins to stop. A run cut short by an ops stop, or whose outcome could not be written, is never run again; the operator is told once at the next start.
- Catching up has limits: a brand-new `'once'` job whose first due time falls while the box is off loses that run (there is no earlier run to catch up from); after a demo wipe jobs start from now; and a due time that passes while ops is catching up waits for the next live fire.

### Cloud OCR

Reading receipts in the cloud (Azure Document Intelligence) is allowed **only when the brief's data policy lists `azure-document-intelligence`** in `policy.outbound`, and only with a region inside the policy's residency (`uk`: `uksouth` or `ukwest`; `uk-eu`: those or an EU region). The box's `.env` then sets `OCR_ENGINE=azure` and the three `OCR_AZURE_*` settings (see the runbook). If the policy does not allow it, or the region is outside the residency, the app refuses to start with one plain sentence and nothing is ever sent. If the cloud cannot be reached, the receipt is read on the box instead.

## Taking foundation fixes

```bash
git fetch foundation --tags
git merge v0.1.1
```

Before merging, read the foundation's `CHANGELOG.md` for the versions in between. Entries marked `[security]` must be taken promptly. Resolve any conflicts (they should be rare if the foundation's files were left alone), run `npm run verify:full`, and ship the result through the normal change-request path (spec §4.8): a release, then the update path in each deployment's runbook.

## The quality gates

- **`npm run verify`**: lint, type checks, the licence gate and every unit and integration test (including the role-crossing harness). It must pass at every commit.
- **`npm run verify:full`**: `verify` plus the browser tests (Playwright: desktop Chromium, phone Chromium and phone WebKit) with a screenshot of every page. Run it before every release. It needs `TEST_DATABASE_URL` (a PostgreSQL role allowed to create databases) and the browsers (`npx playwright install chromium webkit`; on a fresh Linux machine `--with-deps`).
- **`apps/server/reports/crossing.md`** (with `apps/server/reports/crossing.json`): written by the crossing test, wherever the tests are started from. It says in plain English how many routes and checks ran and lists every failure as a sentence. It is the evidence that no role can see or change what it should not, for the operator and later for the council.
- **`reports/screenshots/manifest.json`** (with the PNGs beside it): every page at desktop and phone width, from the browser tests. Look at the phone pages before a release: they are what staff see, and they must look finished enough to charge for.
- **`docs/LICENCES.md`**: generated from `package-lock.json`, so it is the same on every computer. Regenerate it with `npm run licences:doc` after any package change (it refuses while the licence gate fails); a test fails while it is out of date.
