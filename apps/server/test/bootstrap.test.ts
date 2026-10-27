import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeUser } from './helpers/factories.js';
import { bootstrapAdmin, NOT_LOCKED_OUT, recoverAdmin } from '../src/auth/bootstrap-admin.js';
import { auditLog, userTokens, users } from '../src/db/schema/index.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });
const tok = (l: string) => l.split('#')[1]!;

test('a lost first-admin link can be re-issued for the same email until someone activates', async () => {
  const a = await bootstrapAdmin(t.db, t.config, { email: 'first@hf.test', name: 'First' });
  await expect(bootstrapAdmin(t.db, t.config, { email: 'other@hf.test', name: 'O' })).rejects.toThrow('An admin already exists.');
  const b = await bootstrapAdmin(t.db, t.config, { email: ' First@HF.test ', name: 'First' });
  expect(tok(b.link)).not.toBe(tok(a.link));
  expect((await call(t, null, 'POST', '/api/auth/accept-invite', { token: tok(a.link), password: 'first password 1' })).status).toBe(400);
  expect((await call(t, null, 'POST', '/api/auth/accept-invite', { token: tok(b.link), password: 'first password 1' })).status).toBe(200);
  await expect(bootstrapAdmin(t.db, t.config, { email: 'first@hf.test', name: 'First' })).rejects.toThrow('An admin already exists. Use the app to invite more people.');
  const rows = JSON.stringify(await t.db.select().from(auditLog));
  expect(rows).not.toContain(tok(a.link));
  expect(rows).not.toContain(tok(b.link));
});

describe('bootstrap-admin --recover: getting back in when no admin can sign in', () => {
  const withApp = async (fn: (a: Awaited<ReturnType<typeof createTestApp>>) => Promise<void>) => {
    const a = await createTestApp();
    try { await fn(a); } finally { await a.close(); }
  };
  const auditRows = (a: { db: typeof t.db }) => a.db.select().from(auditLog).orderBy(auditLog.id);

  test('refused, with nothing changed, while any admin is switched on and has a password', async () => {
    await withApp(async (a) => {
      await makeUser(a.db, { role: 'admin', email: 'active@hf.test' });
      const off = await makeUser(a.db, { role: 'admin', email: 'off@hf.test', disabled: true });
      await expect(recoverAdmin(a.db, a.config, { email: 'off@hf.test' })).rejects.toThrow(NOT_LOCKED_OUT);
      const [row] = await a.db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, off.id));
      expect(row!.disabledAt).not.toBeNull();
      expect(await auditRows(a)).toEqual([]);
      expect(await a.db.select().from(userTokens)).toEqual([]);
    });
  });

  test('a switched-off admin with a password is switched back on, old sessions end, and a reset link lets them in', async () => {
    await withApp(async (a) => {
      const admin = await makeUser(a.db, { role: 'admin', email: 'boss@hf.test' });
      const member = await makeUser(a.db, { role: 'member', email: 'staff@hf.test' });
      const old = await signInAs(a, admin);
      await a.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, admin.id));
      // never for someone who is not an admin, and never for an unknown address
      await expect(recoverAdmin(a.db, a.config, { email: member.email })).rejects.toThrow("That email address is not an admin's account, so nothing was changed.");
      await expect(recoverAdmin(a.db, a.config, { email: 'nobody@hf.test' })).rejects.toThrow("not an admin's account");
      await expect(recoverAdmin(a.db, a.config, { email: 'not an email' })).rejects.toThrow('That email address does not look right.');

      const r = await recoverAdmin(a.db, a.config, { email: ' Boss@HF.test ' });
      expect(r.kind).toBe('reset');
      expect(r.link).toMatch(/^http:\/\/hf\.test\/reset-password#/);
      const [row] = await a.db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, admin.id));
      expect(row!.disabledAt).toBeNull();
      // a session from before the lockout does not come back to life with the account
      expect((await call(a, old, 'GET', '/api/me')).status).toBe(401);
      expect((await call(a, null, 'POST', '/api/auth/reset-password', { token: tok(r.link), password: 'brand new password 9' })).status).toBe(204);
      expect((await call(a, null, 'POST', '/api/auth/sign-in', { email: 'boss@hf.test', password: 'brand new password 9' })).status).toBe(200);
      // once an admin can sign in again, recovery is closed
      await expect(recoverAdmin(a.db, a.config, { email: 'boss@hf.test' })).rejects.toThrow(NOT_LOCKED_OUT);

      const rows = await auditRows(a);
      expect(rows.slice(0, 2).map((x) => [x.action, x.actorId, x.targetId, x.details])).toEqual([
        ['user.enabled', null, admin.id, { via: 'bootstrap-admin --recover' }],
        ['auth.password_reset_requested', null, admin.id, { email: 'boss@hf.test', via: 'bootstrap-admin --recover' }],
      ]);
      expect(JSON.stringify(rows)).not.toContain(tok(r.link));
    });
  });

  test('an admin who never set a password (switched off or not) gets an invite link instead', async () => {
    await withApp(async (a) => {
      const admin = await makeUser(a.db, { role: 'admin', email: 'new@hf.test', password: null, disabled: true });
      const r = await recoverAdmin(a.db, a.config, { email: 'new@hf.test' });
      expect(r.kind).toBe('invite');
      expect(r.link).toMatch(/^http:\/\/hf\.test\/accept-invite#/);
      expect((await call(a, null, 'POST', '/api/auth/accept-invite', { token: tok(r.link), password: 'first password 22' })).status).toBe(200);
      expect((await auditRows(a)).slice(0, 2).map((x) => [x.action, x.targetId])).toEqual([['user.enabled', admin.id], ['user.invited', admin.id]]);
    });
  });

  test('with no admin at all it points to the ordinary first-admin command', async () => {
    await withApp(async (a) => {
      await expect(recoverAdmin(a.db, a.config, { email: 'x@hf.test' })).rejects.toThrow('There is no admin yet, so there is nothing to recover.');
    });
  });
});

test('the command line: --recover prints the link on standard output, and refuses plainly otherwise', async () => {
  const a = await createTestApp();
  try {
    const admin = await makeUser(a.db, { role: 'admin', email: 'cli@hf.test', disabled: true });
    const cli = fileURLToPath(new URL('../src/auth/bootstrap-admin.ts', import.meta.url));
    const env = { PATH: process.env['PATH'] ?? '', INSTANCE_MODE: 'test', APP_ORIGIN: 'http://hf.test', DATABASE_URL: a.config.databaseUrl, UPLOAD_DIR: a.storageDir, EMAIL_TRANSPORT: 'memory', EMAIL_FROM: 'app@hf.test' };
    const run = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
    const usage = run(['--recover', '--email', 'cli@hf.test', '--name', 'X']);
    expect(usage.status).toBe(1);
    expect(usage.stderr).toContain('bootstrap-admin --recover --email <email address of an existing admin>');
    const ok = run(['--recover', '--email', 'cli@hf.test']);
    expect(ok.stderr).toBe('');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^The admin account is switched on again\. Open this link within 1 hour to set a new password .*:\nhttp:\/\/hf\.test\/reset-password#\S+\n$/);
    const [row] = await a.db.select({ disabledAt: users.disabledAt }).from(users).where(eq(users.id, admin.id));
    expect(row!.disabledAt).toBeNull();
    // now that an admin is switched on with a password, the same command is refused
    const again = run(['--recover', '--email', 'cli@hf.test']);
    expect(again.status).toBe(1);
    expect(again.stderr.trim()).toBe(NOT_LOCKED_OUT);
  } finally {
    await a.close();
  }
}, 120_000);
