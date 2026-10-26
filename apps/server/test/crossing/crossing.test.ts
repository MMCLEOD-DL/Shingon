import { test, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestApp } from '../helpers/testApp.js';
import { buildWorld } from './world.js';
import { CASES } from './cases.js';
import { runCrossing, uncoveredRoutes } from './harness.js';
import { writeCrossingReport } from './report.js';

const HEALTH_TOKEN = 'h'.repeat(32);
const t = await createTestApp({ appVersion: '9.8.7', commit: 'deadbeef1234', healthToken: HEALTH_TOKEN });
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
}, 60_000);   // about 10 s alone; the default 20 s was once exceeded while the whole suite ran in parallel

test('public GET routes leak nothing to an anonymous visitor', async () => {
  const world = await buildWorld(t);
  const canaries = Object.values(world.resources).flat().map((r) => r.canary);
  for (const r of t.app.hf.routes.filter((r) => 'public' in r.access && r.method === 'GET' && !r.url.includes(':'))) {
    const res = await t.app.inject({ method: 'GET', url: r.url });
    for (const c of canaries) expect(res.body, `${r.url} leaked ${c}`).not.toContain(c);
  }
});

test('/api/version never shows the foundation version or commit unless the health token is sent', async () => {
  const foundation = JSON.parse(readFileSync(new URL('../../../../foundation.json', import.meta.url), 'utf8')).version as string;
  const world = await buildWorld(t);
  const actors = Object.values(world.actors);
  // No header, an empty one, a wrong one and one of the wrong length: all get the short answer, whoever is signed in.
  for (const token of [undefined, '', 'wrong', HEALTH_TOKEN.slice(1), HEALTH_TOKEN + 'x']) {
    for (const a of actors) {
      const res = await t.app.inject({ method: 'GET', url: '/api/version', headers: { ...(a.cookie ? { cookie: a.cookie } : {}), ...(token === undefined ? {} : { 'x-health-token': token }) } });
      expect(res.json(), `token ${String(token)} as ${a.key}`).toEqual({ app: '9.8.7' });
      expect(res.body).not.toContain('foundation');
      expect(res.body).not.toContain('commit');
      expect(res.body).not.toContain('deadbeef1234');
      expect(res.body).not.toContain(foundation === '9.8.7' ? 'no-such-text' : foundation);
    }
  }
  const full = await t.app.inject({ method: 'GET', url: '/api/version', headers: { 'x-health-token': HEALTH_TOKEN } });
  expect(full.json()).toEqual({ app: '9.8.7', foundation, commit: 'deadbeef1234' });
  expect(full.body).not.toContain(HEALTH_TOKEN);
});

test('/readyz never shows its checks unless the health token is sent', async () => {
  const world = await buildWorld(t);
  const actors = Object.values(world.actors);
  // No header, an empty one, a wrong one, one of the wrong length and one in the wrong header: all get the status alone, whoever is signed in.
  for (const headers of [{}, { 'x-health-token': '' }, { 'x-health-token': 'wrong' }, { 'x-health-token': HEALTH_TOKEN.slice(1) }, { 'x-health-token': HEALTH_TOKEN + 'x' }, { authorization: `Bearer ${HEALTH_TOKEN}` }] as Record<string, string>[]) {
    for (const a of actors) {
      const res = await t.app.inject({ method: 'GET', url: '/readyz', headers: { ...(a.cookie ? { cookie: a.cookie } : {}), ...headers } });
      expect(Object.keys(res.json<object>()), `${JSON.stringify(headers)} as ${a.key}`).toEqual(['status']);
      expect(['ok', 'degraded', 'down']).toContain(res.json<{ status: string }>().status);
      expect(res.body).not.toContain('checks');
      expect(res.body).not.toContain('detail');
    }
  }
  const full = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': HEALTH_TOKEN } });
  expect(full.json<{ checks: unknown[] }>().checks).toHaveLength(7);
  expect(full.body).not.toContain(HEALTH_TOKEN);
});
