import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { processOutbox } from '../src/email/index.js';
import { requestPasswordReset, resetPassword, TOKEN_TTL } from '../src/auth/reset.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
const site = { appName: 'Highland App', appOrigin: 'http://hf.test' };
const SAME = { message: "If that email has an account, we've sent a link to reset the password." };
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

async function lastLink() {
  await processOutbox(t.db, t.mail, site);
  const m = t.mail.sent.at(-1)!;
  return /http:\/\/hf\.test\/reset-password#([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;
}

test('known and unknown emails get the same answer; only real accounts get mail', async () => {
  const N = await makeTeam(t.db, 'North');
  await makeUser(t.db, { role: 'member', teamId: N.id, email: 'bob@hf.test' });
  const before = t.mail.sent.length;
  const a = await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'bob@hf.test' });
  const b = await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'ghost@hf.test' });
  expect([a.status, b.status]).toEqual([202, 202]);
  expect(a.json).toEqual(SAME); expect(b.json).toEqual(SAME);
  await processOutbox(t.db, t.mail, site);
  expect(t.mail.sent.slice(before).map((m) => m.to)).toEqual(['bob@hf.test']);
});

test('only the newest link works, once, and a reset signs out every session', async () => {
  const u = await makeUser(t.db, { role: 'admin', email: 'cara@hf.test' });
  const session = await signInAs(t, u);
  await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'cara@hf.test' });
  const first = await lastLink();
  await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'cara@hf.test' });
  const second = await lastLink();
  const stale = await call(t, null, 'POST', '/api/auth/reset-password', { token: first, password: 'brand new password' });
  expect(stale.status).toBe(400);
  expect(stale.json.error).toBe('This reset link has expired or has already been used. Ask for a new one.');
  expect((await call(t, null, 'POST', '/api/auth/reset-password', { token: second, password: 'brand new password' })).status).toBe(204);
  expect((await call(t, null, 'POST', '/api/auth/reset-password', { token: second, password: 'another new password' })).status).toBe(400);
  expect((await call(t, session, 'GET', '/api/me')).status).toBe(401);
  expect((await call(t, null, 'POST', '/api/auth/sign-in', { email: 'cara@hf.test', password: 'brand new password' })).status).toBe(200);
  await processOutbox(t.db, t.mail, site);
  expect(t.mail.sent.at(-1)!.subject).toBe('Your Highland App password was changed');
});

test('a reset link expires after one hour', async () => {
  await makeUser(t.db, { role: 'admin', email: 'dee@hf.test' });
  const t0 = new Date('2026-11-01T10:00:00Z');
  await requestPasswordReset(t.db, 'dee@hf.test', { now: t0, appOrigin: 'http://hf.test' });
  const token = await lastLink();
  await expect(resetPassword(t.db, token, 'brand new password', { now: new Date(t0.getTime() + TOKEN_TTL.reset + 1) }))
    .rejects.toMatchObject({ status: 400 });
});

test('changing your password keeps this session and ends the others', async () => {
  const u = await makeUser(t.db, { role: 'admin' });
  const here = await signInAs(t, u), there = await signInAs(t, u);
  expect((await call(t, here, 'POST', '/api/me/password', { currentPassword: 'nope-nope-nope', newPassword: 'brand new password' })).json.error)
    .toBe('Your current password is not right.');
  expect((await call(t, here, 'POST', '/api/me/password', { currentPassword: u.password, newPassword: 'short' })).json.error)
    .toBe('Use at least 10 characters.');
  expect((await call(t, here, 'POST', '/api/me/password', { currentPassword: u.password, newPassword: 'brand new password' })).status).toBe(204);
  expect((await call(t, here, 'GET', '/api/me')).status).toBe(200);
  expect((await call(t, there, 'GET', '/api/me')).status).toBe(401);
});
