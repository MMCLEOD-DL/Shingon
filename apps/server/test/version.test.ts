import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createTestApp } from './helpers/testApp.js';
import { hasHealthToken } from '../src/http/healthToken.js';

const TOKEN = 'v'.repeat(32);
const root = (f: string): { version: string } => JSON.parse(readFileSync(new URL(`../../../${f}`, import.meta.url), 'utf8')) as { version: string };

test('/api/version tells a stranger only the app version', async () => {
  const t = await createTestApp({ appVersion: '3.4.5', commit: 'abc1234', healthToken: TOKEN });
  expect((await t.app.inject({ method: 'GET', url: '/api/version' })).json()).toEqual({ app: '3.4.5' });
  expect((await t.app.inject({ method: 'GET', url: '/api/version', headers: { 'x-health-token': 'nope' } })).json()).toEqual({ app: '3.4.5' });
  await t.close();
});

test('with the health token it adds foundation and commit; foundation.json matches package.json', async () => {
  const t = await createTestApp({ appVersion: '3.4.5', commit: 'abc1234', healthToken: TOKEN });
  const r = await t.app.inject({ method: 'GET', url: '/api/version', headers: { 'x-health-token': TOKEN } });
  expect(r.json()).toEqual({ app: '3.4.5', foundation: root('foundation.json').version, commit: 'abc1234' });
  expect(root('foundation.json').version).toBe(root('package.json').version);
  await t.close();
});

test('with no HEALTH_TOKEN configured, nobody gets the details, not even with an empty or any header', async () => {
  const t = await createTestApp({ appVersion: '3.4.5', commit: 'abc1234' });
  for (const headers of [{}, { 'x-health-token': '' }, { 'x-health-token': 'anything' }]) {
    expect((await t.app.inject({ method: 'GET', url: '/api/version', headers })).json()).toEqual({ app: '3.4.5' });
  }
  await t.close();
});

test('hasHealthToken: exact match only; unset, empty, missing, repeated and different-length values never match', () => {
  const req = (v: unknown) => ({ headers: { 'x-health-token': v } as Record<string, string | string[] | undefined> });
  expect(hasHealthToken(req(TOKEN), { healthToken: TOKEN })).toBe(true);
  expect(hasHealthToken(req(TOKEN + 'x'), { healthToken: TOKEN })).toBe(false);
  expect(hasHealthToken(req(TOKEN.slice(1)), { healthToken: TOKEN })).toBe(false);
  expect(hasHealthToken(req([TOKEN, TOKEN] as unknown), { healthToken: TOKEN })).toBe(false);
  expect(hasHealthToken(req(undefined), { healthToken: TOKEN })).toBe(false);
  expect(hasHealthToken(req(''), { healthToken: TOKEN })).toBe(false);
  expect(hasHealthToken(req(''), { healthToken: '' })).toBe(false);
  expect(hasHealthToken(req(''), {})).toBe(false);
  expect(hasHealthToken(req(undefined), {})).toBe(false);
  expect(hasHealthToken(req('x'), { healthToken: undefined })).toBe(false);
});
