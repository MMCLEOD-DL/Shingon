import { test, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeUser } from './helpers/factories.js';
import { users, sessions } from '../src/db/schema/index.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

test('a disabled user gets 401 on the very next request', async () => {
  const u = await makeUser(t.db, { role: 'admin' });
  const auth = await signInAs(t, u);
  expect((await call(t, auth, 'GET', '/api/me')).status).toBe(200);
  await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
  const r = await call(t, auth, 'GET', '/api/me');
  expect(r.status).toBe(401);
  expect(r.json).toEqual({ error: 'Please sign in.' });
});

test('a stranger gets 401 on a protected route whatever they send', async () => {
  expect((await call(t, null, 'POST', '/api/auth/sign-out', { junk: true })).status).toBe(401);
  expect((await call(t, null, 'GET', '/api/me')).status).toBe(401);
});

test('a forged or malformed cookie is not a session', async () => {
  for (const cookie of ['hf_session=nope', `hf_session=${'A'.repeat(43)}`]) {
    expect((await call(t, { cookie }, 'GET', '/api/me')).status).toBe(401);
  }
});

test('responses never carry the password or its hash, and the cookie is not stored as-is', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: u.email, password: u.password });
  expect(r.status).toBe(200);
  expect(r.text).not.toContain(u.password);
  expect(r.text).not.toMatch(/scrypt|hash/i);
  const token = String(r.headers['set-cookie']).split(';')[0]!.split('=')[1]!;
  const rows = await t.db.select().from(sessions).where(eq(sessions.userId, u.id));
  expect(rows).toHaveLength(1);
  expect(JSON.stringify(rows)).not.toContain(token);
});

test('a sign-in request with a malformed body is 400, not a server error', async () => {
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: 5 });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('Some of the details are not valid.');
});
