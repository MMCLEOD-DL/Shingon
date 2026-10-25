# Task 8: Role-crossing harness & coverage gate

This is the quality bar's hard line made executable (spec §2.1): "log in as each role and attempt to read, edit and list other users' and other roles' data. A failure blocks shipping."

The harness has four parts:
- **A fixed world** of actors and resources, each resource carrying a unique canary string.
- **A table of crossing cases**, one or more per route.
- **An independent oracle, for both halves of the rule.** Visibility is written out by hand in `oracle.ts` and does **not** reuse `canSee`/`canEdit`. Which roles may call each route is written out by hand in `EXPECTED_ROLES` (`cases.ts`) and does **not** reuse `PERMISSIONS`, `can()` or the permission a route declares. So a route declared with too broad a permission, or a `PERMISSIONS` entry that grants too much, cannot hide itself: the harness expects 403 where the app answers 200, and it also says in plain English that the declared permission and the table disagree.
- **A coverage gate:** a new route without a case fails the suite.

It writes `reports/crossing.json` for the council (Phases 2 and 6), and `reports/crossing.md` in plain English for the operator.

**Files:**
- Create: `apps/server/test/crossing/{world,oracle,harness,cases,report}.ts`, `apps/server/test/crossing/resources/{index,users}.ts`
- Create: `apps/server/test/crossing/crossing.test.ts`, `apps/server/test/crossing/harness-self-test.test.ts`
- Modify: `apps/server/test/helpers/testApp.ts`. `createTestApp` gains the option `beforeReady?: (app: FastifyInstance) => void | Promise<void>`, called after `buildApp` and before `app.ready()`.

**Interfaces:**
- Consumes: `createTestApp`, `createSession` (Task 3), `ROLES`/`can`/`PERMISSIONS` (Task 4), `app.hf.routes` and `app.hf.allRoutes` (Task 3), the audit purge flag (Task 5).
- Produces (later tasks extend these and change nothing else):

```ts
// world.ts
export const ACTORS = ['anon', 'admin', 'northManager', 'northAlice', 'northBob', 'southManager', 'southCarol', 'disabledDave'] as const;
export type ActorKey = typeof ACTORS[number];
export interface WorldActor { key: ActorKey; id: string | null; role: Role | null; teamId: string | null; cookie: string | null; signedIn: boolean }
export interface WorldResource { type: string; key: string; id: string; ownerId: string | null; teamId: string | null; canary: string; table: string }
export interface World { t: TestApp; actors: Record<ActorKey, WorldActor>; resources: Record<string, WorldResource[]>; reset(): Promise<void> }
export const IDS: { teams: { north: string; south: string }; users: Record<Exclude<ActorKey, 'anon'> | 'pendingPat', string> };
export async function buildWorld(t: TestApp): Promise<World>;
// resources/index.ts — later tasks append a seeder here
export type ResourceSeeder = (t: TestApp, ids: typeof IDS) => Promise<WorldResource[]>;
export const RESOURCE_SEEDERS: ResourceSeeder[];      // Task 8: [seedUsersAndTeams]; Task 9 adds files; Task 10 adds notes
// oracle.ts — the policy written out independently of src/access/scope.ts
export function sees(a: WorldActor, r: WorldResource): boolean;
// cases.ts
type Route = `${'GET' | 'POST' | 'PATCH' | 'DELETE'} ${string}`;
// Hand-written: which roles may call each non-public route at all. Never derived from PERMISSIONS.
export const EXPECTED_ROLES: Record<Route, readonly Role[]>;
export interface ItemCase   { kind: 'item';   route: Route; resource: string; visible?: (a: WorldActor, r: WorldResource) => boolean; allowed?: (a: WorldActor, r: WorldResource) => boolean; body?: (r: WorldResource) => unknown; okStatus?: number | ((r: WorldResource, a: WorldActor) => number); mutates?: boolean }
export interface ListCase   { kind: 'list';   route: Route; resource: string; visible?: (a: WorldActor, r: WorldResource) => boolean; query?: string }
export interface ActionCase { kind: 'action'; route: Route; body?: (w: World) => unknown; okStatus?: number; mutates?: boolean; forbiddenFields?: Record<string, unknown>[] }
export type CrossingCase = ItemCase | ListCase | ActionCase;
export const CASES: CrossingCase[];
// harness.ts
export interface CrossingFailure { route: Route; actor: ActorKey | null; resource?: string; kind: 'status' | 'leak' | 'missing' | 'changed' | 'mass-assignment' | 'permission'; sentence: string }
export function uncoveredRoutes(app: FastifyInstance, cases: CrossingCase[], expected?: Record<string, readonly Role[]>): string[];   // plain-English lines; expected defaults to EXPECTED_ROLES
export async function runCrossing(world: World, cases: CrossingCase[], expected?: Record<string, readonly Role[]>): Promise<{ checks: number; failures: CrossingFailure[] }>;
export async function dbFingerprint(t: TestApp): Promise<Record<string, string>>;   // table -> 'count:md5'; see check 4
// report.ts
export async function writeCrossingReport(r: { routes: number; checks: number; failures: CrossingFailure[] }, dir?: string): Promise<void>;
```

**The world** (fixed UUIDs, so failures are reproducible):
- Teams: `north` and `south`. Each team's name contains its canary, e.g. `North CANARY-team-north`.
- Users:
  - `admin`, with no team;
  - `northManager`, `northAlice` and `northBob` in north;
  - `southManager` and `southCarol` in south;
  - `disabledDave`, a north member who is disabled but holds a session issued before he was disabled;
  - `pendingPat`, a north member invited but not activated. Pat is a resource only, never an actor.
- Each user's `name` contains `CANARY-user-<key>`.
- The actor `anon` has no cookie. Only `disabledDave` and `anon` have `signedIn: false`.
- Every non-anon actor's password is `'correct horse battery'`.

**The oracle** (`sees`). It mirrors the spec's policy, written out by hand:
- type `team`: admin, or `a.teamId === r.id`.
- type `user`: admin; or a manager with `r.teamId === a.teamId`; or `r.id === a.id`.
- any other type (notes, files and every client resource): admin; or a manager with `r.teamId === a.teamId`; or `r.ownerId === a.id`.

**Expected status** for a request:
1. `!a.signedIn` → 401.
2. `!EXPECTED_ROLES[route].includes(a.role)` → 403. The roles come from the hand-written table, **not** from `can()` or the permission the route declares.
3. For an item case: `!(c.visible ?? sees)(a, r)` → 404; then `c.allowed && !c.allowed(a, r)` → 403.
4. Otherwise `okStatus`. The default is 201 for POST, 204 for DELETE and 200 for anything else.

**Checks on every response:**
1. **Status.** It must match the expected status exactly.
2. **Leak.** The body must not contain the canary of **any** world resource, of any type, for which `sees(a, r)` is false.
3. **List completeness.** For list cases with a 200 response, the body must contain the canary of every resource of that type that is visible.
4. **Unchanged after denial.** For every mutating case (item **and** action) where the expected status is not 2xx:
   - item cases: `md5(row_to_json(t)::text)` of the target row, read straight from `r.table`, must be identical before and after;
   - every case: `dbFingerprint(t)` before and after must be identical. This catches a handler that writes before it refuses, and a create route whose item rule throws after the insert. For each table in `pg_tables WHERE schemaname = 'public'`, it runs `select count(*) || ':' || coalesce(md5(string_agg(row_to_json(x)::text, '' order by row_to_json(x)::text)), '') from <table> x`. Ordering by the row text (not `ctid`) keeps the value stable when nothing changed.
   - Two tables are left out, by name, with the reason in a comment: `sessions` (the session layer deletes a dead session on sight, e.g. `disabledDave`'s, on every request, by design) and `audit_log` (a refused attempt may be audited, by design). `email_outbox` stays in: a refused invite must not queue mail.
   - The failure names the tables that changed: `southCarol's POST /api/teams was refused, but the database changed anyway (teams).`
5. **Mass assignment.** For `forbiddenFields`, every permitted actor sends `body` merged with each forbidden field. The answer must be 400, and the actor's own row must be unchanged.

After any **allowed** mutating request, the harness calls `world.reset()`.

**Failure sentences** (exact forms, which the report and the tests rely on):
- status: `northAlice got 200 from GET /api/users/:id for southCarol (user); expected 404.`
- leak: `northAlice could see southCarol's user data (CANARY-user-southCarol) in the answer from GET /api/users.`
- missing: `northManager's list from GET /api/users left out northBob (user), which they are allowed to see.`
- changed: `southCarol's PATCH /api/users/:id was refused, but northAlice (user) changed anyway.`
- changed (whole database): `southCarol's POST /api/teams was refused, but the database changed anyway (teams).`
- mass-assignment: `northAlice could send "role" to PATCH /api/me; it should have been refused.`
- permission (one per route, `actor: null`): `PATCH /api/users/:id lets admin, manager and member in (permission self:manage), but the crossing table says only admin should. Fix the route's permission or PERMISSIONS; if the rule really changed, update EXPECTED_ROLES in test/crossing/cases.ts.`

- [ ] **Step 1: Write the self-test first (proves the harness catches leaks)**

`apps/server/test/crossing/harness-self-test.test.ts`:

```ts
import { test, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp } from '../helpers/testApp.js';
import { defineRoute } from '../../src/http/route.js';
import { forbidden } from '../../src/http/errors.js';
import { users, teams } from '../../src/db/schema/index.js';
import { buildWorld, IDS } from './world.js';
import { runCrossing, uncoveredRoutes } from './harness.js';
import type { CrossingCase } from './cases.js';

const t = await createTestApp({
  beforeReady: (app) => {
    // A deliberately broken route: any signed-in user can read ANY user by id.
    defineRoute(app, { method: 'GET', url: '/api/leaky/:id', access: { permission: 'self:manage' },
      handler: async (req: any, _r, { db }) => ({ user: (await db.select().from(users).where(eq(users.id, req.params.id)))[0] ?? null }) });
    // Declared too broadly (self:manage), and writes before it refuses non-admins.
    defineRoute(app, { method: 'POST', url: '/api/sneaky', access: { permission: 'self:manage' },
      handler: async (_req, _r, { db, actor }) => {
        if (actor!.role !== 'admin') { await db.insert(teams).values({ name: `sneaky-${actor!.id}` }); throw forbidden(); }
        return { ok: true };
      } });
    // Registered outside /api and outside defineRoute (the lint rule covers apps/server/src only, not test files).
    app.get('/download/:id', async () => 'bytes');
  },
});
afterAll(async () => { await t.close(); });

test('a route with no case is reported in plain English', () => {
  expect(uncoveredRoutes(t.app, [])).toContain('GET /api/leaky/:id has no role-crossing check. Add one to test/crossing/cases.ts.');
});

test('the harness catches a leak, a wrong status and the canary', async () => {
  const world = await buildWorld(t);
  const cases: CrossingCase[] = [{ kind: 'item', route: 'GET /api/leaky/:id', resource: 'user' }];
  const { failures } = await runCrossing(world, cases, { 'GET /api/leaky/:id': ['admin', 'manager', 'member'] });
  const s = failures.map((f) => f.sentence);
  expect(s).toContain('northAlice got 200 from GET /api/leaky/:id for southCarol (user); expected 404.');
  expect(s).toContain("northAlice could see southCarol's user data (CANARY-user-southCarol) in the answer from GET /api/leaky/:id.");
  expect(failures.some((f) => f.actor === 'disabledDave')).toBe(false); // disabled is rejected by the session layer
  expect(IDS.users.southCarol).toMatch(/^[0-9a-f-]{36}$/);
});

test('a route whose declared permission is broader than the table is caught, and so is a write before a refusal', async () => {
  const world = await buildWorld(t);
  const cases: CrossingCase[] = [{ kind: 'action', route: 'POST /api/sneaky', body: () => ({}), okStatus: 200, mutates: true }];
  const { failures } = await runCrossing(world, cases, { 'POST /api/sneaky': ['admin'] });
  const s = failures.map((f) => f.sentence);
  expect(s).toContain('POST /api/sneaky lets admin, manager and member in (permission self:manage), but the crossing table says only admin should. Fix the route\'s permission or PERMISSIONS; if the rule really changed, update EXPECTED_ROLES in test/crossing/cases.ts.');
  expect(s).toContain("northAlice's POST /api/sneaky was refused, but the database changed anyway (teams).");
});

test('a route registered without defineRoute is reported, wherever it lives', () => {
  expect(uncoveredRoutes(t.app, [])).toContain('GET /download/:id was registered without defineRoute. Every route must declare its permission.');
});
```

(In the sneaky case every signed-in actor except admin gets 403, as the table expects, so the failures are the `permission` sentence and one `changed` sentence per refused actor.)

- [ ] **Step 2: Write the real gate**

`apps/server/test/crossing/crossing.test.ts`:

```ts
import { test, expect, afterAll } from 'vitest';
import { createTestApp } from '../helpers/testApp.js';
import { buildWorld } from './world.js';
import { CASES } from './cases.js';
import { runCrossing, uncoveredRoutes } from './harness.js';
import { writeCrossingReport } from './report.js';

const t = await createTestApp();
afterAll(async () => { await t.close(); });

test('every non-public route has at least one role-crossing case', () => {
  expect(uncoveredRoutes(t.app, CASES)).toEqual([]);
});

test('no role can read, list or change data it is not entitled to', async () => {
  const world = await buildWorld(t);
  const r = await runCrossing(world, CASES);
  await writeCrossingReport({ routes: t.app.hf.routes.length, ...r });
  expect(r.checks).toBeGreaterThan(200);
  expect(r.failures.map((f) => f.sentence)).toEqual([]);
});

test('public GET routes leak nothing to an anonymous visitor', async () => {
  const world = await buildWorld(t);
  const canaries = Object.values(world.resources).flat().map((r) => r.canary);
  for (const r of t.app.hf.routes.filter((r) => 'public' in r.access && r.method === 'GET' && !r.url.includes(':'))) {
    const res = await t.app.inject({ method: 'GET', url: r.url });
    for (const c of canaries) expect(res.body, `${r.url} leaked ${c}`).not.toContain(c);
  }
});
```

`cases.ts` starts with the routes that exist after Task 7. The ids come from `IDS`. `EXPECTED_ROLES` is typed out by hand from the spec's policy and the route list in Tasks 3–7, never copied from `PERMISSIONS` in code:

```ts
const ALL = ['admin', 'manager', 'member'] as const;
export const EXPECTED_ROLES: Record<Route, readonly Role[]> = {
  'GET /api/me': ALL,
  'PATCH /api/me': ALL,
  'POST /api/me/password': ALL,
  'POST /api/auth/sign-out': ALL,
  'GET /api/users': ['admin', 'manager'],
  'GET /api/users/:id': ['admin', 'manager'],
  'PATCH /api/users/:id': ['admin'],
  'POST /api/users/:id/resend-invite': ['admin'],
  'POST /api/users/invite': ['admin'],
  'GET /api/teams': ['admin', 'manager'],
  'POST /api/teams': ['admin'],
  'GET /api/audit': ['admin'],
};
```

```ts
const own = (a: WorldActor, r: WorldResource) => a.id === r.id;
export const CASES: CrossingCase[] = [
  { kind: 'action', route: 'GET /api/me', okStatus: 200 },
  { kind: 'action', route: 'PATCH /api/me', body: () => ({ name: 'Renamed' }), mutates: true,
    forbiddenFields: [{ role: 'admin' }, { teamId: IDS.teams.south }, { email: 'x@hf.test' }, { disabled: false }] },
  { kind: 'action', route: 'POST /api/me/password', body: () => ({ currentPassword: 'correct horse battery', newPassword: 'another long passphrase' }), okStatus: 204, mutates: true },
  { kind: 'action', route: 'POST /api/auth/sign-out', okStatus: 204, mutates: true },
  { kind: 'list', route: 'GET /api/users', resource: 'user' },
  { kind: 'item', route: 'GET /api/users/:id', resource: 'user' },
  { kind: 'item', route: 'PATCH /api/users/:id', resource: 'user', body: () => ({ name: 'Renamed' }), mutates: true },
  { kind: 'item', route: 'PATCH /api/users/:id', resource: 'user', body: () => ({ role: 'member', teamId: IDS.teams.north }), mutates: true,
    okStatus: (r, a) => (own(a, r) ? 409 : 200) },   // an admin may not change their own role (Task 4)
  { kind: 'item', route: 'POST /api/users/:id/resend-invite', resource: 'user', mutates: true,
    okStatus: (r) => (r.key === 'pendingPat' ? 204 : 409) },
  { kind: 'action', route: 'POST /api/users/invite', body: () => ({ email: 'invited@hf.test', name: 'Invited', role: 'member', teamId: IDS.teams.north }), mutates: true },
  { kind: 'list', route: 'GET /api/teams', resource: 'team' },
  { kind: 'action', route: 'POST /api/teams', body: () => ({ name: 'East' }), mutates: true },
  { kind: 'action', route: 'GET /api/audit', okStatus: 200 },
];
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run --project apps/server test/crossing`
Expected: FAIL. The `./world.js` module is missing.

- [ ] **Step 4: Implement `world.ts` and `resources/users.ts`**

- `buildWorld` calls `reset()` once and returns the world.
- `reset()`:
  - In one transaction: `SET LOCAL hf.audit_purge = 'on'`, then `TRUNCATE <every table in schema public except none> RESTART IDENTITY CASCADE`. The table list comes from `pg_tables WHERE schemaname = 'public'`.
  - Then it runs each `RESOURCE_SEEDERS` entry. `seedUsersAndTeams` inserts the teams and users with fixed ids, hashed passwords (hash once and reuse the string), and Pat with `password_hash = null`.
  - It creates a session per actor with `createSession` and fills in `cookie`.
  - For Dave, it creates the session **first** and then sets `disabled_at`.
  - It fills `resources` by type.

- [ ] **Step 5: Implement `oracle.ts`, `harness.ts` and `report.ts`**

- `uncoveredRoutes`:
  - every entry of `app.hf.routes` with `access.permission` must match some case route string (`${method} ${url}`);
  - every entry of `app.hf.routes` with `access.permission` must have an `EXPECTED_ROLES` entry, otherwise `<METHOD> <url> has no entry in EXPECTED_ROLES. Say which roles may call it in test/crossing/cases.ts.`;
  - **every** route in `app.hf.allRoutes`, wherever it lives (not only `/api/`), must be in `app.hf.routes`, except `HEAD` routes and the explicit allow-list `app.hf.staticRoutes` (the built web app's files, recorded by Task 11; empty until then). Otherwise it gets the line `<METHOD> <url> was registered without defineRoute. Every route must declare its permission.` So a `/download/:id` added through a plugin, or under any variable name the lint selector does not know, still fails the gate.
  - Add `staticRoutes: { method: string; url: string }[]` (initially `[]`) to the `app.hf` decoration in `app.ts` now; only Task 11's static block appends to it.
- `runCrossing`:
  - for each case, for each actor in `ACTORS`, and for each resource of the case's type (item cases) or once (list and action cases):
    - for a mutating case, take the row snapshot (item cases) and `dbFingerprint` **only** when the expected status is not 2xx, to keep the run fast;
    - `inject` with `origin: t.config.appOrigin` and the actor's cookie, substituting `:id`;
    - run checks 1–5 and push the failures;
    - `reset()` after an allowed mutation.
  - before the loop, for each route **named by the cases passed in** that has a permission, compare `PERMISSIONS[permission]` with `expected[route]` as sets, and push one `permission` failure for each route where they differ. A case whose route has no `expected` entry throws `<route> has no entry in EXPECTED_ROLES.` (the coverage test reports the same thing in plain English);
  - role lists in sentences are joined as `a`, `a and b`, `a, b and c`;
  - `checks` counts the individual assertions made.
- `report.ts`:
  - writes `crossing.json` as `{ generatedAt, routes, checks, failures }`;
  - writes `crossing.md`, starting `# Role-crossing check` and then `**<routes> routes, <checks> checks, <n> problems.**`. With no problems, the next line is `No role could reach data it should not.`; otherwise each failure sentence follows as a bullet.

- [ ] **Step 6: Verify**

Run: `npm run verify && cat apps/server/reports/crossing.md`
Expected: all tests PASS (7 new). The report reads `… 0 problems.` and `No role could reach data it should not.`

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "test: role-crossing harness with independent oracle, canaries, coverage gate and report

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Rule for every later task that adds a route:**
- add its case(s) to `CASES`, its roles to `EXPECTED_ROLES` (typed by hand), and, for a new resource type, a seeder to `RESOURCE_SEEDERS` with canaries;
- the crossing suite must stay at 0 problems.

Tasks 9, 10, 16 and 19 add routes and each carry this as a step.
