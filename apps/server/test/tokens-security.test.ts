import { test, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { processOutbox } from '../src/email/index.js';
import { auditLog, userTokens, users } from '../src/db/schema/index.js';
import { consumeToken, issueToken } from '../src/auth/tokens.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
const site = { appName: 'Highland App', appOrigin: 'http://hf.test' };
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const tokenFrom = async (re: RegExp) => {
  await processOutbox(t.db, t.mail, site);
  return re.exec(t.mail.sent.at(-1)!.text)![1]!;
};

test('tokens are stored only as hashes, and audit rows never hold them', async () => {
  const u = await makeUser(t.db, { role: 'admin', email: 'hash@hf.test' });
  await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'hash@hf.test' });
  const token = await tokenFrom(/reset-password#([A-Za-z0-9_-]{43})/);
  const rows = await t.db.select().from(userTokens).where(eq(userTokens.userId, u.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
  expect(rows[0]!.id).not.toBe(token);
  const audits = JSON.stringify(await t.db.select().from(auditLog));
  expect(audits).not.toContain(token);
});

test('a weak password does not burn the reset link; a disabled account cannot use one', async () => {
  const u = await makeUser(t.db, { role: 'admin', email: 'weak@hf.test' });
  await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'weak@hf.test' });
  const token = await tokenFrom(/reset-password#([A-Za-z0-9_-]{43})/);
  const weak = await call(t, null, 'POST', '/api/auth/reset-password', { token, password: 'short' });
  expect([weak.status, weak.json.error]).toEqual([400, 'Use at least 10 characters.']);
  await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
  const r = await call(t, null, 'POST', '/api/auth/reset-password', { token, password: 'a good long password' });
  expect(r.json.error).toBe('This reset link has expired or has already been used. Ask for a new one.');
  // Disabled accounts also get no mail.
  const before = t.mail.sent.length;
  await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'weak@hf.test' });
  await processOutbox(t.db, t.mail, site);
  expect(t.mail.sent.length).toBe(before);
});

test('an un-activated user gets no reset mail and cannot reset into an account', async () => {
  await makeUser(t.db, { role: 'admin', email: 'pending@hf.test', password: null });
  const before = t.mail.sent.length;
  const r = await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'pending@hf.test' });
  expect(r.status).toBe(202);
  await processOutbox(t.db, t.mail, site);
  expect(t.mail.sent.length).toBe(before);
});

test('the reset request is audited for known and unknown addresses alike', async () => {
  await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'nobody-here@hf.test' });
  const rows = await t.db.select().from(auditLog).where(eq(auditLog.action, 'auth.password_reset_requested'));
  expect(rows.some((r) => (r.details as { email?: string }).email === 'nobody-here@hf.test')).toBe(true);
});

test('forgot-password is limited to 5 an hour per address and email, and the limit is per email', async () => {
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'limit@hf.test' })).status);
  expect(codes).toEqual([202, 202, 202, 202, 202, 429]);
  expect((await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'other@hf.test' })).status).toBe(202);
});

test('a token can be consumed exactly once even when used at the same moment', async () => {
  const u = await makeUser(t.db, { role: 'admin' });
  const token = await t.db.transaction((tx) => issueToken(tx, u.id, 'reset'));
  const results = await Promise.all([1, 2, 3, 4].map(() => consumeToken(t.db, token, 'reset')));
  expect(results.filter((r) => r !== null)).toHaveLength(1);
  // A reset token is not an invite token.
  const other = await t.db.transaction((tx) => issueToken(tx, u.id, 'reset'));
  expect(await consumeToken(t.db, other, 'invite')).toBeNull();
});

test('invites: team rule, unknown team, anonymous, and a newer invite replaces the older link', async () => {
  const admin = await makeUser(t.db, { role: 'admin', name: 'Ada' });
  const auth = await signInAs(t, admin);
  expect((await call(t, null, 'POST', '/api/users/invite', { email: 'a@hf.test', name: 'A', role: 'admin', teamId: null })).status).toBe(401);
  const noTeam = await call(t, auth, 'POST', '/api/users/invite', { email: 'a@hf.test', name: 'A', role: 'member', teamId: null });
  expect([noTeam.status, noTeam.json.error]).toEqual([400, 'Managers and members must belong to a team.']);
  const ghost = await call(t, auth, 'POST', '/api/users/invite', { email: 'a@hf.test', name: 'A', role: 'member', teamId: '00000000-0000-4000-8000-000000000000' });
  expect(ghost.status).toBe(400);
  expect((await t.db.select().from(users).where(eq(users.email, 'a@hf.test')))).toHaveLength(0);
  const N = await makeTeam(t.db, 'Invite team');
  const mass = await call(t, auth, 'POST', '/api/users/invite', { email: 'a@hf.test', name: 'A', role: 'member', teamId: N.id, passwordHash: 'x' });
  expect(mass.status).toBe(400);
  const ok = await call(t, auth, 'POST', '/api/users/invite', { email: 'Resend@HF.test', name: 'Re', role: 'member', teamId: N.id });
  expect(ok.status).toBe(201);
  const first = await tokenFrom(/accept-invite#([A-Za-z0-9_-]{43})/);
  const id = String(ok.json.user.id);
  expect((await call(t, auth, 'POST', `/api/users/${id}/resend-invite`)).status).toBe(204);
  const second = await tokenFrom(/accept-invite#([A-Za-z0-9_-]{43})/);
  expect(second).not.toBe(first);
  expect((await call(t, null, 'POST', '/api/auth/accept-invite', { token: first, password: 'a good long password' })).status).toBe(400);
  const weak = await call(t, null, 'POST', '/api/auth/accept-invite', { token: second, password: 'short' });
  expect([weak.status, weak.json.error]).toEqual([400, 'Use at least 10 characters.']);
  expect((await call(t, null, 'POST', '/api/auth/accept-invite', { token: second, password: 'a good long password' })).status).toBe(200);
  const done = await call(t, auth, 'POST', `/api/users/${id}/resend-invite`);
  expect([done.status, done.json.error]).toEqual([409, 'This person has already set their password.']);
  expect((await call(t, auth, 'POST', '/api/users/00000000-0000-4000-8000-000000000000/resend-invite')).status).toBe(404);
  const m = await makeUser(t.db, { role: 'member', teamId: N.id });
  expect((await call(t, await signInAs(t, m), 'POST', `/api/users/${id}/resend-invite`)).status).toBe(403);
});

test('an invite for a disabled account is refused', async () => {
  const admin = await makeUser(t.db, { role: 'admin' });
  const N = await makeTeam(t.db, 'Disabled team');
  const r = await call(t, await signInAs(t, admin), 'POST', '/api/users/invite', { email: 'off@hf.test', name: 'Off', role: 'member', teamId: N.id });
  const token = await tokenFrom(/accept-invite#([A-Za-z0-9_-]{43})/);
  await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, String(r.json.user.id)));
  expect((await call(t, null, 'POST', '/api/auth/accept-invite', { token, password: 'a good long password' })).status).toBe(400);
  const [row] = await t.db.select({ p: users.passwordHash }).from(users).where(eq(users.id, String(r.json.user.id)));
  expect(row!.p).toBeNull();
});
