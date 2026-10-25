# Task 4: Roles, permissions, scoping & user admin API

Spec §2.1 makes access control "a hard line". This task puts the whole permission model in one shared file, and makes visibility a single helper that every repository query uses. It also adds the user and team admin API, which is the first real data a role can over-reach on.

**Files:**
- Modify: `packages/shared/src/access.ts` (full `PERMISSIONS`)
- Create: `packages/shared/src/schemas.ts` (users, teams and me input schemas)
- Create: `apps/server/src/access/scope.ts`, `apps/server/src/users/{repo,routes}.ts`
- Modify: `apps/server/src/app.ts` (register the users routes)
- Test: `packages/shared/test/access.test.ts`, `apps/server/test/scope.test.ts`, `apps/server/test/users-routes.test.ts`

**Interfaces:**
- Consumes: `defineRoute`, `Actor`, the error helpers, the test helpers and factories (Task 3).
- Produces:
  - `PERMISSIONS`, `Permission`, `can`, `visibleTo`, `canSee`, `canEdit` (index Shared Interfaces).
  - `@hf/shared` exports:
    - `UserView = { id, email, name, role, teamId, teamName: string | null, disabled: boolean, activated: boolean }`
    - `TeamView = { id, name }`
    - `UpdateUserInput = z.strictObject({ name: z.string().trim().min(1).max(100).optional(), role: z.enum(ROLES).optional(), teamId: z.uuid().nullable().optional(), disabled: z.boolean().optional() })`
    - `UpdateMeInput = z.strictObject({ name: z.string().trim().min(1).max(100) })`
    - `CreateTeamInput = z.strictObject({ name: z.string().trim().min(1).max(80) })`
  - Routes (the permission is in brackets):
    - `GET /api/users` [`users:list`]: admin sees everyone; a manager sees their own team. Sorted by name.
    - `GET /api/users/:id` [`users:list`]: same visibility; outside it → 404.
    - `PATCH /api/users/:id` [`users:manage`], body `UpdateUserInput`.
    - `GET /api/teams` [`teams:list`]: admin sees all; a manager sees their own team.
    - `POST /api/teams` [`teams:manage`], body `CreateTeamInput` → 201 `{ team }`; a duplicate name → 409 `There is already a team called "<name>".`
    - `PATCH /api/me` [`self:manage`], body `UpdateMeInput` → `{ user }`.

`PERMISSIONS` (complete for the foundation; a client app adds its own keys):

```ts
export const PERMISSIONS = {
  'self:manage':  ['admin', 'manager', 'member'],
  'users:list':   ['admin', 'manager'],
  'users:manage': ['admin'],
  'teams:list':   ['admin', 'manager'],
  'teams:manage': ['admin'],
  'audit:read':   ['admin'],
  'files:upload': ['admin', 'manager', 'member'],
  'files:read':   ['admin', 'manager', 'member'],
  'notes:create': ['admin', 'manager', 'member'],
  'notes:read':   ['admin', 'manager', 'member'],
  'notes:update': ['admin', 'manager', 'member'],
  'notes:delete': ['admin', 'manager', 'member'],
} as const satisfies Record<string, readonly Role[]>;
```

`PATCH /api/users/:id` rules, checked in this order after the permission and visibility checks:
1. If the target is the actor and the body has `role` or `disabled`: 409 `You can't change your own role or disable your own account. Ask another admin.` This guarantees there is always at least one working admin.
2. If the resulting role is `manager` or `member` and the resulting `teamId` is null: 400 `Managers and members must belong to a team.`
3. If `teamId` names no existing team: 400 `That team doesn't exist.`
4. `disabled: true` sets `disabled_at = now()` and calls `revokeSessions(target)`. `disabled: false` clears `disabled_at`.
5. The response is `{ user: UserView }`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/access.test.ts`:

```ts
import { test, expect } from 'vitest';
import { PERMISSIONS, ROLES, can } from '../src/access.js';

test('only admins manage users, teams and read the audit log', () => {
  for (const p of ['users:manage', 'teams:manage', 'audit:read'] as const) {
    expect(ROLES.filter((r) => can(r, p))).toEqual(['admin']);
  }
});
test('every permission names known roles only', () => {
  for (const roles of Object.values(PERMISSIONS)) for (const r of roles) expect(ROLES).toContain(r);
});
test('unknown roles get nothing', () => {
  expect(can('owner' as never, 'self:manage')).toBe(false);
});
```

`apps/server/test/scope.test.ts`:

```ts
import { test, expect } from 'vitest';
import { canSee, canEdit } from '../src/access/scope.js';

const A = (role: 'admin' | 'manager' | 'member', id: string, teamId: string | null) => ({ id, role, teamId, email: '', name: '' });
const admin = A('admin', 'u0', null), mN = A('manager', 'u1', 'N'), alice = A('member', 'u2', 'N'), mS = A('manager', 'u3', 'S');
const aliceRow = { ownerId: 'u2', teamId: 'N' };

test('visibility: admin all, manager team, member own', () => {
  expect([admin, mN, alice, mS].map((a) => canSee(a, aliceRow))).toEqual([true, true, true, false]);
  expect(canSee(A('member', 'u9', 'N'), aliceRow)).toBe(false);
  expect(canSee(mN, { ownerId: 'u0', teamId: null })).toBe(false);
});
test('edit: owner or admin only; managers view but do not edit', () => {
  expect([admin, mN, alice, mS].map((a) => canEdit(a, aliceRow))).toEqual([true, false, true, false]);
});
```

`apps/server/test/users-routes.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let N: { id: string }, S: { id: string };
let admin: any, mN: any, alice: any, carol: any;
beforeAll(async () => {
  t = await createTestApp();
  N = await makeTeam(t.db, 'North'); S = await makeTeam(t.db, 'South');
  admin = await makeUser(t.db, { role: 'admin', name: 'Ada' });
  mN = await makeUser(t.db, { role: 'manager', teamId: N.id, name: 'Nina' });
  alice = await makeUser(t.db, { role: 'member', teamId: N.id, name: 'Alice' });
  carol = await makeUser(t.db, { role: 'member', teamId: S.id, name: 'Carol' });
});
afterAll(async () => { await t.close(); });

test('admin lists everyone; a manager lists only their team; a member may not list', async () => {
  const all = await call(t, await signInAs(t, admin), 'GET', '/api/users');
  expect(all.json.users.map((u: any) => u.name)).toEqual(['Ada', 'Alice', 'Carol', 'Nina']);
  const team = await call(t, await signInAs(t, mN), 'GET', '/api/users');
  expect(team.json.users.map((u: any) => u.name)).toEqual(['Alice', 'Nina']);
  expect((await call(t, await signInAs(t, alice), 'GET', '/api/users')).status).toBe(403);
});

test('a manager asking for another team\'s user gets 404, not 403', async () => {
  expect((await call(t, await signInAs(t, mN), 'GET', `/api/users/${carol.id}`)).status).toBe(404);
});

test('an admin cannot demote or disable themselves', async () => {
  const r = await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${admin.id}`, { role: 'member' });
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("You can't change your own role or disable your own account. Ask another admin.");
});

test('demoting a manager takes effect on their very next request', async () => {
  const m = await makeUser(t.db, { role: 'manager', teamId: N.id });
  const mAuth = await signInAs(t, m);
  expect((await call(t, mAuth, 'GET', '/api/users')).status).toBe(200);
  await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${m.id}`, { role: 'member' });
  expect((await call(t, mAuth, 'GET', '/api/users')).status).toBe(403);
});

test('disabling signs the user out everywhere', async () => {
  const u = await makeUser(t.db, { role: 'member', teamId: N.id });
  const uAuth = await signInAs(t, u);
  await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${u.id}`, { disabled: true });
  expect((await call(t, uAuth, 'GET', '/api/me')).status).toBe(401);
});

test('members and managers need a team', async () => {
  const r = await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${alice.id}`, { teamId: null });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('Managers and members must belong to a team.');
});

test('self-promotion through /api/me is refused and changes nothing', async () => {
  const auth = await signInAs(t, alice);
  const r = await call(t, auth, 'PATCH', '/api/me', { name: 'Alice', role: 'admin' });
  expect(r.status).toBe(400);
  expect((await call(t, auth, 'GET', '/api/me')).json.user.role).toBe('member');
});

test('teams: a manager sees only their own; duplicates are explained', async () => {
  expect((await call(t, await signInAs(t, mN), 'GET', '/api/teams')).json.teams).toEqual([{ id: N.id, name: 'North' }]);
  const dup = await call(t, await signInAs(t, admin), 'POST', '/api/teams', { name: 'North' });
  expect(dup.status).toBe(409);
  expect(dup.json.error).toBe('There is already a team called "North".');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project packages/shared --project apps/server`
Expected: FAIL. `canSee` and the users routes do not exist, and `PERMISSIONS` lacks keys.

- [ ] **Step 3: Implement**

- `scope.ts`:
  - `visibleTo(actor, { owner, team })` returns:
    - `undefined` for admin;
    - `or(eq(team, actor.teamId), eq(owner, actor.id))` for a manager with a team;
    - `eq(owner, actor.id)` for a member, or for a manager without a team.
  - `canSee` and `canEdit` are the same rules in plain TypeScript, for rows already loaded.
  - The file header comment says: **every repository function that returns client rows takes `actor` first and applies `visibleTo`.**
- `users/repo.ts`:
  - `listUsers(db, actor)` and `getUser(db, actor, id)` use `visibleTo(actor, { owner: users.id, team: users.teamId })`, so a user row's "owner" is the user themself.
  - `getUser` returns null outside visibility, and the route turns that into `notFound()`.
  - `toUserView` never includes `passwordHash`.
- `users/routes.ts`: the routes and rules listed above. A `unique_violation` (`23505`) on the teams name maps to the 409.

- [ ] **Step 4: Verify**

Run: `npm run verify`
Expected: all tests PASS (13 new).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: permission table, visibility scoping, users/teams/me API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
