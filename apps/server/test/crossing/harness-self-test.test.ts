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
      handler: async (req: any, _r, { db }) => ({ user: (await db.select().from(users).where(eq(users.id, req.params.id as string)))[0] ?? null }) });
    // Declared too broadly (self:manage), and writes before it refuses non-admins.
    defineRoute(app, { method: 'POST', url: '/api/sneaky', access: { permission: 'self:manage' },
      handler: async (_req, _r, { db, actor }) => {
        if (actor!.role !== 'admin') { await db.insert(teams).values({ name: `sneaky-${actor!.id}` }); throw forbidden(); }
        return { ok: true };
      } });
    // Registered outside /api and outside defineRoute (the lint rule covers apps/server/src only, not test files).
    app.get('/download/:id', () => Promise.resolve('bytes'));
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
