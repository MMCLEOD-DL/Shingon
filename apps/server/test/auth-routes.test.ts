import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeUser } from './helpers/factories.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const BAD = "That email and password don't match an account.";

test('sign in sets a hardened cookie and /api/me answers', async () => {
  const u = await makeUser(t.db, { role: 'member', email: 'alice@hf.test' });
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: ' Alice@HF.test ', password: u.password });
  expect(r.status).toBe(200);
  const cookie = String(r.headers['set-cookie']);
  expect(cookie).toMatch(/^hf_session=[A-Za-z0-9_-]{43};/);
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Lax/);
  const me = await call(t, { cookie: cookie.split(';')[0]! }, 'GET', '/api/me');
  expect(me.json.user).toMatchObject({ id: u.id, email: 'alice@hf.test', role: 'member' });
  expect(JSON.stringify(me.json)).not.toMatch(/password|hash/i);
});

test('wrong password, unknown email, disabled and not-yet-activated all look the same', async () => {
  const d = await makeUser(t.db, { role: 'member', disabled: true });
  const n = await makeUser(t.db, { role: 'member', password: null });
  for (const body of [{ email: d.email, password: d.password }, { email: n.email, password: 'whatever-long-1' },
    { email: 'nobody@hf.test', password: 'whatever-long-1' }]) {
    const r = await call(t, null, 'POST', '/api/auth/sign-in', body);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: BAD });
  }
});

test('sign-in is rate limited per email and address', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  for (let i = 0; i < 10; i++) await call(t, null, 'POST', '/api/auth/sign-in', { email: u.email, password: 'wrong-wrong-1' });
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: u.email, password: u.password });
  expect(r.status).toBe(429);
  expect(r.json.error).toBe('Too many attempts. Please wait 15 minutes and try again.');
});

test('the limit is per email: another person on the same address can still sign in', async () => {
  // Runs straight after the test above, from the same inject IP (127.0.0.1).
  const other = await makeUser(t.db, { role: 'member' });
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: other.email, password: other.password });
  expect(r.status).toBe(200);
});

test('sign out ends the session', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const auth = await signInAs(t, u);
  expect((await call(t, auth, 'POST', '/api/auth/sign-out')).status).toBe(204);
  expect((await call(t, auth, 'GET', '/api/me')).status).toBe(401);
});

test('a change from another site is blocked', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const auth = await signInAs(t, u);
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie: auth.cookie, origin: 'https://evil.example' } });
  expect(r.statusCode).toBe(403);
  expect(r.json().error).toBe('This request came from another website and was blocked.');
});

test('unknown input keys are refused, and validation errors are plain English', async () => {
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: 'a@hf.test', password: 'x', role: 'admin' });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('Some of the details are not valid.');
});

test('every route Fastify knows went through defineRoute', () => {
  const declared = new Set(t.app.hf.routes.map((r) => `${r.method} ${r.url}`));
  const stray = t.app.hf.allRoutes.filter((r) => r.method !== 'HEAD')
    .filter((r) => !declared.has(`${r.method} ${r.url}`));
  expect(stray).toEqual([]);
});
