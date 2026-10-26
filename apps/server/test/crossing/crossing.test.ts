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
