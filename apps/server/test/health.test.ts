import { test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/testApp.js';
import { runReadinessChecks, readinessStatus, type Check } from '../src/health/checks.js';
import type { Db } from '../src/db/client.js';
import type { Storage } from '../src/files/storage.js';

const TOKEN = 'h'.repeat(32);
let t: Awaited<ReturnType<typeof createTestApp>>;
const checksOf = (r: { json: () => unknown }): Record<string, Check> => Object.fromEntries((r.json() as { checks: Check[] }).checks.map((c) => [c.name, c]));
beforeAll(async () => { t = await createTestApp({ healthToken: TOKEN }); });
afterAll(async () => { await t.close(); });

test('without the token only the status is shown', async () => {
  const r = await t.app.inject({ method: 'GET', url: '/readyz' });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ status: 'degraded' });         // no backup yet
  const wrong = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': 'nope' } });
  expect(wrong.json()).toEqual({ status: 'degraded' });
});

test('with the token, each check explains itself', async () => {
  await t.db.execute(sql`insert into email_outbox (to_address, template, data, created_at, next_attempt_at) values ('a@hf.test', 'password-changed', '{}', now() - interval '22 minutes', now())`);
  const r = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': TOKEN } });
  const byName = checksOf(r);
  expect(Object.keys(byName)).toEqual(['database', 'storage', 'migrations', 'email', 'backups', 'restore-test']);
  expect(byName.database!.ok).toBe(true);
  expect(byName.migrations!.ok).toBe(true);
  expect(byName.email).toMatchObject({ ok: false, detail: '1 email is waiting to be sent (the oldest for 22 minutes).' });
  expect(byName.backups).toMatchObject({ ok: false, detail: 'No backup has succeeded yet.' });
});

test('fresh backup and passing restore test turn those checks green', async () => {
  await t.db.execute(sql`insert into ops_runs (kind, ok, detail) values ('backup', true, 'x'), ('restore-test', true, 'y')`);
  await t.db.execute(sql`update email_outbox set status = 'sent'`);
  const r = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': TOKEN } });
  expect(r.json().status).toBe('ok');
});

// ── Beyond the brief's three: failed runs, stale runs, failed mail, the database down, and no rate limit.

test('a failed backup or restore test after the last success is a problem, and so is a stale one', async () => {
  const at = (h: number) => sql`now() - make_interval(hours => ${h})`;
  await t.db.execute(sql`delete from ops_runs`);
  await t.db.execute(sql`insert into ops_runs (kind, ok, detail, at) values ('backup', true, 'old', ${at(31)}), ('backup', false, 'Another backup or restore is running right now, so this backup did not start. Try again when it has finished.', ${at(1)})`);
  await t.db.execute(sql`insert into ops_runs (kind, ok, detail, at) values ('restore-test', true, 'fine', ${at(48)}), ('restore-test', false, 'Table notes has 32 rows in the backup record but 0 after restoring.', ${at(2)})`);
  const r = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': TOKEN } });
  const byName = checksOf(r);
  expect(byName.backups).toMatchObject({ ok: false, detail: 'The last backup failed: Another backup or restore is running right now, so this backup did not start. Try again when it has finished. The last successful backup was 31 hours ago.' });
  expect(byName['restore-test']).toMatchObject({ ok: false, detail: 'The last restore test failed: Table notes has 32 rows in the backup record but 0 after restoring.' });

  await t.db.execute(sql`delete from ops_runs`);
  await t.db.execute(sql`insert into ops_runs (kind, ok, detail, at) values ('backup', true, 'x', ${at(27)}), ('restore-test', true, 'y', ${at(9 * 24)})`);
  const r2 = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': TOKEN } });
  const b2 = checksOf(r2);
  expect(b2.backups).toMatchObject({ ok: false, detail: 'The last successful backup was 27 hours ago.' });
  expect(b2['restore-test']).toMatchObject({ ok: false, detail: 'No restore test has passed in the last 8 days.' });
  await t.db.execute(sql`delete from ops_runs`);
});

test('mail that could not be sent in the last day is reported, with plural wording for a backlog', async () => {
  await t.db.execute(sql`delete from email_outbox`);
  await t.db.execute(sql`insert into email_outbox (to_address, template, data, created_at, next_attempt_at) values
    ('a@hf.test', 'invite', '{}', now() - interval '40 minutes', now()), ('b@hf.test', 'invite', '{}', now() - interval '20 minutes', now())`);
  await t.db.execute(sql`insert into email_outbox (to_address, template, data, status, created_at, next_attempt_at) values
    ('c@hf.test', 'invite', '{}', 'failed', now() - interval '3 hours', now() - interval '1 hour'),
    ('d@hf.test', 'invite', '{}', 'failed', now() - interval '3 days', now() - interval '2 days')`);
  const checks = await runReadinessChecks({ db: t.db, storage: { check: () => Promise.resolve() }, now: () => new Date() });
  expect(checks.find((c) => c.name === 'email')).toEqual({ name: 'email', ok: false, detail: '2 emails are waiting to be sent (the oldest for 40 minutes). 1 email could not be sent in the last day.' });
  await t.db.execute(sql`delete from email_outbox`);
});

test('only a database failure makes the app "down"; anything else is "degraded"', async () => {
  const ok = (name: string) => ({ name, ok: true, detail: '' });
  expect(readinessStatus([ok('database'), ok('storage')])).toBe('ok');
  expect(readinessStatus([ok('database'), { name: 'storage', ok: false, detail: 'x' }])).toBe('degraded');
  expect(readinessStatus([{ name: 'database', ok: false, detail: 'x' }, ok('storage')])).toBe('down');

  const deadDb = { execute: () => Promise.reject(new Error('connect ECONNREFUSED postgres://app:dbsecret@db:5432/app')) } as unknown as Db;
  const brokenStorage = { check: () => Promise.reject(new Error('EACCES')) } as unknown as Storage;
  const checks = await runReadinessChecks({ db: deadDb, storage: brokenStorage, now: () => new Date() });
  expect(checks.find((c) => c.name === 'database')).toEqual({ name: 'database', ok: false, detail: 'The database is not answering.' });
  expect(checks.find((c) => c.name === 'storage')).toEqual({ name: 'storage', ok: false, detail: 'Uploaded files cannot be saved (storage is not writable).' });
  expect(JSON.stringify(checks)).not.toContain('dbsecret');
});

test('a database that hangs is reported within the time limits, not waited on for ever', async () => {
  const hung = { execute: () => new Promise(() => undefined) } as unknown as Db;
  const started = Date.now();
  const checks = await runReadinessChecks({ db: hung, storage: { check: () => Promise.resolve() }, now: () => new Date() });
  expect(Date.now() - started).toBeLessThan(3500);
  expect(checks.map((c) => c.name)).toEqual(['database', 'storage', 'migrations', 'email', 'backups', 'restore-test']);
  expect(checks[0]).toEqual({ name: 'database', ok: false, detail: 'The database is not answering.' });
  expect(checks[1]!.ok).toBe(true);
});

test('the health routes are never rate limited, so the monitor and outside watchers always get an answer', async () => {
  for (let i = 0; i < 150; i++) {
    const [h, r] = await Promise.all([
      t.app.inject({ method: 'GET', url: '/healthz', remoteAddress: '172.18.0.1' }),
      t.app.inject({ method: 'GET', url: '/readyz', remoteAddress: '172.18.0.1' }),
    ]);
    expect(h.statusCode).toBe(200);
    expect(r.statusCode).not.toBe(429);
  }
});

test('/healthz is bare liveness and /readyz is declared public with its reason', async () => {
  const r = await t.app.inject({ method: 'GET', url: '/healthz', headers: { 'x-health-token': TOKEN } });
  expect(r.json()).toEqual({ status: 'ok' });
  expect(t.app.hf.routes.find((x) => x.url === '/healthz')?.access).toEqual({ public: 'liveness for Docker and the monitor' });
  expect(t.app.hf.routes.find((x) => x.url === '/readyz')?.access).toEqual({ public: 'readiness; details only with the health token' });
});
