import { test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { audit, redactDetails } from '../src/audit/audit.js';

// Drizzle wraps driver errors ("Failed query: ..."); the Postgres message is on .cause.
async function expectDbError(p: Promise<unknown>, re: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).not.toBeNull();
  const cause = (err as { cause?: { message?: string } }).cause;
  expect(cause?.message ?? String(err)).toMatch(re);
}

let t: Awaited<ReturnType<typeof createTestApp>>;
type TestUser = Awaited<ReturnType<typeof makeUser>>;
interface Entry { action: string; actorLabel: string; targetId: string | null; details: unknown }
let admin: TestUser, alice: TestUser;
beforeAll(async () => {
  t = await createTestApp();
  const N = await makeTeam(t.db, 'North');
  admin = await makeUser(t.db, { role: 'admin', email: 'ada@hf.test' });
  alice = await makeUser(t.db, { role: 'member', teamId: N.id, email: 'alice@hf.test' });
});
afterAll(async () => { await t.close(); });

test('sign-in, failed sign-in and admin changes are audited with who and what', async () => {
  await call(t, null, 'POST', '/api/auth/sign-in', { email: 'alice@hf.test', password: 'wrong-wrong-wrong' });
  await call(t, null, 'POST', '/api/auth/sign-in', { email: 'alice@hf.test', password: alice.password });
  const adminAuth = await signInAs(t, admin);
  await call(t, adminAuth, 'PATCH', `/api/users/${alice.id}`, { disabled: true });
  const r = await call(t, adminAuth, 'GET', '/api/audit?limit=10');
  const entries = (r.json as { entries: Entry[] }).entries;
  const rows = entries.map((e) => [e.action, e.actorLabel, e.targetId]);
  expect(rows.slice(0, 3)).toEqual([
    ['user.disabled', 'ada@hf.test', alice.id],
    ['auth.sign_in', 'alice@hf.test', alice.id],
    ['auth.sign_in_failed', 'anonymous', null],
  ]);
  expect(entries[2]!.details).toEqual({ email: 'alice@hf.test' });
});

test('users are disabled, never deleted: a user with audit history cannot be removed', async () => {
  // admin has audit rows from the test above (user.disabled)
  await expectDbError(t.db.execute(sql`delete from users where id = ${admin.id}`), /audit_log_actor_id_users_id_fk/);
});

test('secrets never reach the audit details', () => {
  expect(redactDetails({ password: 'x', newPassword: 'y', token: 't', apiKey: 'k', clientSecret: 's', name: 'ok' }))
    .toEqual({ password: '[redacted]', newPassword: '[redacted]', token: '[redacted]', apiKey: '[redacted]', clientSecret: '[redacted]', name: 'ok' });
});

test('the log cannot be edited or deleted, only purged deliberately', async () => {
  await audit(t.db, { actor: null }, { action: 'seed.demo' });
  await expectDbError(t.db.execute(sql`update audit_log set action = 'x'`), /append-only/);
  await expectDbError(t.db.execute(sql`delete from audit_log`), /append-only/);
  await expectDbError(t.db.execute(sql`truncate audit_log`), /append-only/);
  const purged = await t.db.execute(sql`select audit_purge_before('infinity') as n`);
  expect(Number(purged.rows[0]!.n)).toBeGreaterThan(0);
  await audit(t.db, { actor: null }, { action: 'seed.demo' });
  await expectDbError(t.db.execute(sql`delete from audit_log`), /append-only/); // the purge flag did not leak
});

test('an audit row is rolled back with the change it describes', async () => {
  const before = (await t.db.execute(sql`select count(*)::int n from audit_log`)).rows[0]!.n;
  await expect(t.db.transaction(async (tx) => {
    await audit(tx, { actor: null }, { action: 'team.created', targetId: 'x' });
    throw new Error('boom');
  })).rejects.toThrow('boom');
  expect((await t.db.execute(sql`select count(*)::int n from audit_log`)).rows[0]!.n).toBe(before);
});

test('only admins can read the audit log; paging works', async () => {
  expect((await call(t, await signInAs(t, alice), 'GET', '/api/audit')).status).toBe(401); // alice was disabled above
  // The purge test above emptied the log, so add a second row to have a second page.
  await audit(t.db, { actor: null }, { action: 'seed.demo' });
  const p1 = await call(t, await signInAs(t, admin), 'GET', '/api/audit?limit=1');
  expect(p1.json.entries).toHaveLength(1);
  expect(typeof p1.json.nextBefore).toBe('number');
  const p2 = await call(t, await signInAs(t, admin), 'GET', `/api/audit?limit=1&before=${String(p1.json.nextBefore)}`);
  expect(p2.json.entries).toHaveLength(1);
  expect((p2.json as { entries: { id: number }[] }).entries[0]!.id).toBeLessThan((p1.json as { entries: { id: number }[] }).entries[0]!.id);
  expect(p2.json.nextBefore).toBeNull();
});

test('the paging cursor must be a positive whole number within the exact range: anything else is a plain 400', async () => {
  const a = await signInAs(t, admin);
  for (const bad of ['0', '-1', '1.5', 'abc', '1e300', '9007199254740992']) {
    const r = await call(t, a, 'GET', `/api/audit?before=${bad}`);
    expect(r.status, bad).toBe(400);
  }
  expect((await call(t, a, 'GET', '/api/audit?before=9007199254740991')).status).toBe(200);
});

test('role, team, name, enable, team creation and sign-out are audited; nested secrets are masked', async () => {
  const adminAuth = await signInAs(t, admin);
  const S = await call(t, adminAuth, 'POST', '/api/teams', { name: 'South' });
  const teamId = (S.json as { team: { id: string } }).team.id;
  await call(t, adminAuth, 'PATCH', `/api/users/${alice.id}`, { role: 'manager', teamId, disabled: false });
  await call(t, adminAuth, 'PATCH', '/api/me', { name: 'Ada Lovelace' });
  await call(t, adminAuth, 'POST', '/api/auth/sign-out');
  const r = await call(t, await signInAs(t, admin), 'GET', '/api/audit?limit=10');
  const entries = (r.json as { entries: { action: string; details: Record<string, unknown> }[] }).entries;
  expect(entries.map((e) => e.action).slice(0, 5)).toEqual(['auth.sign_out', 'user.updated', 'user.enabled', 'user.updated', 'team.created']);
  expect(entries[3]!.details).toEqual({ changed: { role: ['member', 'manager'], teamId: [expect.any(String), teamId] } });
  expect(redactDetails({ nested: { password: 'x', ok: 1 } })).toEqual({ nested: { password: '[redacted]', ok: 1 } });
});

test('non-admins get 403 on the audit log', async () => {
  const N = await makeTeam(t.db, 'Audit-403 team');
  const mgr = await makeUser(t.db, { role: 'manager', teamId: N.id });
  const mem = await makeUser(t.db, { role: 'member', teamId: N.id });
  expect((await call(t, await signInAs(t, mgr), 'GET', '/api/audit')).status).toBe(403);
  expect((await call(t, await signInAs(t, mem), 'GET', '/api/audit')).status).toBe(403);
});

test('audit() itself masks secrets in what it stores', async () => {
  await audit(t.db, { actor: null }, { action: 'seed.demo', targetId: 'redact-check', details: { password: 'x', nested: { token: 'y' }, note: 'ok' } });
  const row = (await t.db.execute(sql`select details from audit_log where target_id = 'redact-check'`)).rows[0]!;
  expect(row.details).toEqual({ password: '[redacted]', nested: { token: '[redacted]' }, note: 'ok' });
});

test('a password typed into the email box never reaches the audit row', async () => {
  await call(t, null, 'POST', '/api/auth/sign-in', { email: 'hunter2 secret', password: 'whatever-whatever' });
  const rows = (await t.db.execute(sql`select details::text as d from audit_log where action = 'auth.sign_in_failed' order by id desc limit 1`)).rows;
  expect(rows[0]!.d).not.toContain('hunter2');
  expect(JSON.parse(rows[0]!.d as string)).toEqual({ email: '[not an email address]' });
});
