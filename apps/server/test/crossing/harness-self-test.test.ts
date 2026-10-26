import { test, expect, afterAll, vi } from 'vitest';
import { and, asc, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { createTestApp } from '../helpers/testApp.js';
import { defineRoute } from '../../src/http/route.js';
import { HttpError, forbidden } from '../../src/http/errors.js';
import { users, teams, sessions } from '../../src/db/schema/index.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/sessions.js';
import { visibleTo } from '../../src/access/scope.js';
import { buildWorld, IDS } from './world.js';
import { runCrossing, uncoveredRoutes } from './harness.js';
import { EXPECTED_ROLES, type CrossingCase } from './cases.js';

// Injected bug for the disabled-session test: on URLs starting with `acceptDisabledOn`, the session layer
// accepts a disabled user's session instead of refusing it.
const bug = vi.hoisted(() => ({ acceptDisabledOn: null as string | null, url: '' }));
vi.mock('../../src/auth/sessions.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/auth/sessions.js')>();
  const loadSession: typeof orig.loadSession = async (db, token, now) => {
    if (bug.acceptDisabledOn !== null && bug.url.startsWith(bug.acceptDisabledOn)) {
      const { users: u, sessions: s } = await import('../../src/db/schema/index.js');
      const sessionId = orig.hashToken(token);
      const [actor] = await db.select({ id: u.id, email: u.email, name: u.name, role: u.role, teamId: u.teamId })
        .from(s).innerJoin(u, eq(u.id, s.userId)).where(eq(s.id, sessionId));
      if (actor) return { actor, sessionId };
    }
    return orig.loadSession(db, token, now);
  };
  return { ...orig, loadSession };
});

const t = await createTestApp({
  beforeReady: (app) => {
    // A deliberately broken route: any signed-in user can read ANY user by id.
    defineRoute(app, { method: 'GET', url: '/api/leaky/:id', access: { permission: 'self:manage' },
      handler: async (req: any, _r, { db }) => ({ user: (await db.select().from(users).where(eq(users.id, req.params.id as string)))[0] ?? null }) });
    // Declared too broadly (self:manage), and writes before it refuses non-admins.
    defineRoute(app, { method: 'POST', url: '/api/sneaky', access: { permission: 'self:manage' },
      handler: async (_req, _r, { db, actor }) => {
        if (actor!.role !== 'admin') { await db.insert(teams).values({ name: `sneaky-${actor!.id}` }); throw forbidden(); }
        return { ok: true };
      } });
    // Registered outside /api and outside defineRoute (the lint rule covers apps/server/src only, not test files).
    app.get('/download/:id', () => Promise.resolve('bytes'));
    // A HEAD route with no matching GET.
    app.head('/api/head-only', (_req, reply) => reply.send());
    // Signs northAlice in, sets the cookie, and then answers 401.
    defineRoute(app, { method: 'POST', url: '/api/bad-sign-in', access: { public: 'self-test' },
      handler: async (_req, reply, { db }) => {
        const { token } = await createSession(db, IDS.users.northAlice, {});
        void reply.header('set-cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly`);
        throw new HttpError(401, 'Wrong password.');
      } });
    // Its "not found" message names the user it did find.
    defineRoute(app, { method: 'GET', url: '/api/nosy/:id', access: { permission: 'self:manage' },
      handler: async (req: any, _r, { db }) => {
        const [row] = await db.select().from(users).where(eq(users.id, req.params.id as string));
        throw new HttpError(404, `We couldn't find ${row?.email ?? 'that'}.`);
      } });
    // A loose input schema that copies email straight through.
    defineRoute(app, { method: 'PATCH', url: '/api/loose-users/:id', access: { permission: 'users:manage' },
      schema: { body: z.object({ name: z.string().optional(), email: z.string().optional() }) },
      handler: async (req: any, _r, { db }) => {
        const body = req.body as { name?: string; email?: string };
        await db.update(users).set({ ...(body.name ? { name: body.name } : {}), ...(body.email ? { email: body.email } : {}) }).where(eq(users.id, req.params.id as string));
        return { ok: true };
      } });
    // Paginated by id; the first page is scoped, later pages forget the scope.
    defineRoute(app, { method: 'GET', url: '/api/paged-users', access: { permission: 'users:list' },
      schema: { query: z.strictObject({ limit: z.coerce.number().int().min(1).default(50), after: z.uuid().optional() }) },
      handler: async (req: any, _r, { db, actor }) => {
        const q = req.query as { limit: number; after?: string };
        const where = q.after ? gt(users.id, q.after) : visibleTo(actor!, { owner: users.id, team: users.teamId });
        const rows = await db.select({ id: users.id, name: users.name }).from(users).where(where).orderBy(asc(users.id)).limit(q.limit);
        return { users: rows, nextAfter: rows.length === q.limit ? rows[rows.length - 1]!.id : null };
      } });
    // Declared too broadly and changes the database for everyone, answering 200.
    defineRoute(app, { method: 'POST', url: '/api/open-door', access: { permission: 'self:manage' },
      handler: async (_req, _r, { db, actor }) => {
        await db.insert(teams).values({ name: `door-${actor!.id}` });
        return { ok: true };
      } });
  },
});
const realInject = t.app.inject.bind(t.app);
(t.app as unknown as { inject: (o: InjectOptions) => Promise<LightMyRequestResponse> }).inject = (o: InjectOptions) => {
  bug.url = o.url === undefined ? '' : typeof o.url === 'string' ? o.url : JSON.stringify(o.url);
  return realInject(o);
};
afterAll(async () => { await t.close(); });

const sentencesOf = (r: { failures: { sentence: string }[] }) => r.failures.map((f) => f.sentence);

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

// ── Fix round 1 ───────────────────────────────────────────────────────────

test('a session handed out with a refusal is caught (cookie and sessions table)', async () => {
  const world = await buildWorld(t);
  const cases: CrossingCase[] = [{ kind: 'action', route: 'POST /api/bad-sign-in', body: () => ({}), okStatus: 401 }];
  const s = sentencesOf(await runCrossing(world, cases, {}, ['POST /api/bad-sign-in']));
  expect(s).toContain('anon got a session cookie from POST /api/bad-sign-in although the answer was 401.');
  expect(s).toContain("anon's POST /api/bad-sign-in was refused, but the database changed anyway (sessions).");
});

test('a disabled session accepted on just one GET route is caught, even after other routes have refused it', async () => {
  const world = await buildWorld(t);
  // GET /api/me comes first: the session layer deletes Dave's session there, so the harness must re-plant it.
  const cases: CrossingCase[] = [
    { kind: 'action', route: 'GET /api/me', okStatus: 200 },
    { kind: 'list', route: 'GET /api/teams', resource: 'team' },
  ];
  bug.acceptDisabledOn = '/api/teams';
  try {
    const s = sentencesOf(await runCrossing(world, cases, EXPECTED_ROLES));
    expect(s).toEqual(['disabledDave got 403 from GET /api/teams; expected 401.']);
  } finally {
    bug.acceptDisabledOn = null;
  }
});

test("another user's email in an error message is caught", async () => {
  const world = await buildWorld(t);
  const cases: CrossingCase[] = [{ kind: 'item', route: 'GET /api/nosy/:id', resource: 'user', visible: () => false }];
  const s = sentencesOf(await runCrossing(world, cases, { 'GET /api/nosy/:id': ['admin', 'manager', 'member'] }));
  expect(s).toContain("northAlice could see southCarol's user data (CANARY-user-southCarol) in the answer from GET /api/nosy/:id.");
});

test("another resource's id in an answer is caught", async () => {
  const world = await buildWorld(t);
  // The leaky route returns the requested row; its team id is south's, which northManager may not see.
  const cases: CrossingCase[] = [{ kind: 'item', route: 'GET /api/leaky/:id', resource: 'user', visible: () => true }];
  const s = sentencesOf(await runCrossing(world, cases, { 'GET /api/leaky/:id': ['admin', 'manager', 'member'] }));
  expect(s).toContain(`northManager could see south's team id (${IDS.teams.south}) in the answer from GET /api/leaky/:id.`);
});

test('a loose input schema on an item route that copies email through is caught', async () => {
  const world = await buildWorld(t);
  const cases: CrossingCase[] = [{ kind: 'item', route: 'PATCH /api/loose-users/:id', resource: 'user', body: () => ({ name: 'Renamed' }),
    forbiddenFields: [{ email: 'hacked@hf.test' }] }];
  const s = sentencesOf(await runCrossing(world, cases, { 'PATCH /api/loose-users/:id': ['admin'] }));
  expect(s).toContain('admin could send "email" to PATCH /api/loose-users/:id for northAlice (user); it should have been refused.');
  // Each replay is undone, so the world is clean afterwards.
  const [alice] = await t.db.select().from(users).where(eq(users.id, IDS.users.northAlice));
  expect(alice!.email).toBe('canary-user-northalice@hf.test');
});

test('a list that drops its scope on page 2 is caught by following the cursor', async () => {
  const world = await buildWorld(t);
  const cases: CrossingCase[] = [{ kind: 'list', route: 'GET /api/paged-users', resource: 'user',
    paginate: { query: 'limit=2', next: (json: any) => (json.nextAfter ? `limit=2&after=${String(json.nextAfter)}` : null) } }];
  const s = sentencesOf(await runCrossing(world, cases, { 'GET /api/paged-users': ['admin', 'manager'] }));
  expect(s).toContain("northManager could see southManager's user data (CANARY-user-southManager) in the answer from GET /api/paged-users.");
});

test('a case whose resource type has no rows is an error, not zero checks', async () => {
  const world = await buildWorld(t);
  await expect(runCrossing(world, [{ kind: 'item', route: 'GET /api/leaky/:id', resource: 'usr' }], { 'GET /api/leaky/:id': ['admin'] }))
    .rejects.toThrow('GET /api/leaky/:id uses the resource type "usr", but the world has no rows of that type. Check the spelling, or add a seeder to RESOURCE_SEEDERS.');
});

test('changing requests are checked for denial by default; opting out needs a reason', async () => {
  const world = await buildWorld(t);
  // No `mutates` given: a POST is still watched.
  const s = sentencesOf(await runCrossing(world, [{ kind: 'action', route: 'POST /api/sneaky', okStatus: 200 }], { 'POST /api/sneaky': ['admin'] }));
  expect(s).toContain("northAlice's POST /api/sneaky was refused, but the database changed anyway (teams).");
  await expect(runCrossing(world, [{ kind: 'action', route: 'POST /api/sneaky', okStatus: 200, mutates: false }], { 'POST /api/sneaky': ['admin'] }))
    .rejects.toThrow('POST /api/sneaky is marked as changing nothing, but gives no reason. Add why to the case in test/crossing/cases.ts.');
});

test('a change that should have been refused but went through is worded as such', async () => {
  const world = await buildWorld(t);
  const s = sentencesOf(await runCrossing(world, [{ kind: 'action', route: 'POST /api/open-door', okStatus: 200 }], { 'POST /api/open-door': ['admin'] }));
  expect(s).toContain('northAlice got 200 from POST /api/open-door; expected 403.');
  expect(s).toContain("northAlice's POST /api/open-door should have been refused (expected 403), but it went through and changed the database (teams).");
  expect(s.some((x) => x.startsWith("northAlice's POST /api/open-door was refused"))).toBe(false);
});

test('the gate flags unlisted public routes, public-listed permissioned routes, stale entries and bare HEAD routes', () => {
  expect(uncoveredRoutes(t.app, [])).toContain('POST /api/bad-sign-in is open to everyone without signing in, but the crossing table does not list it as public. Give it a permission, or if it really is public, add it to EXPECTED_PUBLIC in test/crossing/cases.ts.');
  expect(uncoveredRoutes(t.app, [], EXPECTED_ROLES, ['GET /api/leaky/:id'])).toContain('GET /api/leaky/:id needs the permission self:manage, but the crossing table lists it as public. Fix the route or EXPECTED_PUBLIC in test/crossing/cases.ts.');
  expect(uncoveredRoutes(t.app, [], { ...EXPECTED_ROLES, 'GET /api/ghost': ['admin'] })).toContain('GET /api/ghost is listed in EXPECTED_ROLES, but no such route exists. Remove it or fix the spelling in test/crossing/cases.ts.');
  expect(uncoveredRoutes(t.app, [], EXPECTED_ROLES, ['POST /api/phantom'])).toContain('POST /api/phantom is listed in EXPECTED_PUBLIC, but no such route exists. Remove it or fix the spelling in test/crossing/cases.ts.');
  expect(uncoveredRoutes(t.app, [{ kind: 'action', route: 'GET /api/nowhere' }])).toContain('A case names GET /api/nowhere, but no such route exists. Remove it or fix the spelling in test/crossing/cases.ts.');
  expect(uncoveredRoutes(t.app, [])).toContain('HEAD /api/head-only was registered without defineRoute. Every route must declare its permission.');
  // A HEAD that Fastify adds for a declared GET is fine.
  expect(uncoveredRoutes(t.app, []).some((l) => l.startsWith('HEAD /api/leaky/:id'))).toBe(false);
});

test('sessions survive between requests only as the harness planted them', async () => {
  // Sanity check for the re-planting: Dave's session row exists after a reset.
  const world = await buildWorld(t);
  const rows = await t.db.select().from(sessions).where(and(eq(sessions.userId, IDS.users.disabledDave)));
  expect(rows).toHaveLength(1);
  expect(world.actors.disabledDave.signedIn).toBe(false);
});
