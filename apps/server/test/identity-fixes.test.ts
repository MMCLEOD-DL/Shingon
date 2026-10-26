import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeUser } from './helpers/factories.js';
import { defineRoute } from '../src/http/route.js';
import { loadConfig, ConfigError } from '../src/config.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  t = await createTestApp({
    beforeReady: (app) => {
      defineRoute(app, {
        method: 'POST', url: '/api/test/locked', access: { permission: 'nobody:holds-this' as never },
        handler: () => Promise.resolve({ ok: true }),
      });
    },
  });
});
afterAll(async () => { await t.close(); });

const post = (url: string, headers: Record<string, string>, payload: string | Buffer) =>
  t.app.inject({ method: 'POST', url, headers: { origin: t.config.appOrigin, ...headers }, payload });

test('Ruling 2: a stranger gets 401 before the body is read, whatever it is', async () => {
  expect((await post('/api/auth/sign-out', { 'content-type': 'application/json' }, '{bad')).statusCode).toBe(401);
  expect((await post('/api/auth/sign-out', { 'content-type': 'application/xml' }, '<a/>')).statusCode).toBe(401);
  expect((await post('/api/auth/sign-out', { 'content-type': 'application/json' }, Buffer.alloc(2 * 1024 * 1024, 97))).statusCode).toBe(401);
});

test('Ruling 2: signed in but not allowed gets 403 before the body is read', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const auth = await signInAs(t, u);
  const r = await post('/api/test/locked', { 'content-type': 'application/json', cookie: auth.cookie }, '{bad');
  expect(r.statusCode).toBe(403);
  expect((await post('/api/test/locked', { 'content-type': 'application/json' }, '{bad')).statusCode).toBe(401);
});

test('a client cannot dodge the email limit by rotating X-Forwarded-For', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  let last = 0;
  for (let i = 0; i < 12; i++) {
    const r = await t.app.inject({
      method: 'POST', url: '/api/auth/sign-in',
      headers: { origin: t.config.appOrigin, 'x-forwarded-for': `10.0.${String(i)}.7, 203.0.113.5` },
      payload: { email: u.email, password: 'wrong-wrong-1' },
    });
    last = r.statusCode;
  }
  expect(last).toBe(429);
});

test('one address is capped across different emails', async () => {
  let last = 0;
  for (let i = 0; i < 51; i++) {
    const r = await t.app.inject({
      method: 'POST', url: '/api/auth/sign-in',
      headers: { origin: t.config.appOrigin, 'x-forwarded-for': '198.51.100.9' },
      payload: { email: `nobody-${String(i)}@hf.test`, password: 'wrong-wrong-1' },
    });
    if (i < 50) expect(r.statusCode).toBe(401);
    last = r.statusCode;
  }
  expect(last).toBe(429);
});

test('invalid input does not count towards the limit', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  for (let i = 0; i < 12; i++) {
    const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: u.email, password: 'x', role: 'admin' });
    expect(r.status).toBe(400);
  }
  expect((await call(t, null, 'POST', '/api/auth/sign-in', { email: u.email, password: u.password })).status).toBe(200);
});

test('an unknown 4xx keeps its status with a plain message', async () => {
  const r = await post('/api/auth/sign-in', { 'content-type': 'application/xml' }, '<a/>');
  expect(r.statusCode).toBe(415);
  expect(r.json()).toEqual({ error: 'Some of the details are not valid.' });
});

test('cookie is Path=/ and Secure when configured, and sign-out clears it', async () => {
  const s = await createTestApp({ cookieSecure: true });
  try {
    const u = await makeUser(s.db, { role: 'member' });
    const r = await call(s, null, 'POST', '/api/auth/sign-in', { email: u.email, password: u.password });
    const cookie = String(r.headers['set-cookie']);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(/Secure/);
    const auth = { cookie: cookie.split(';')[0]! };
    const out = await call(s, auth, 'POST', '/api/auth/sign-out');
    expect(out.status).toBe(204);
    const cleared = String(out.headers['set-cookie']);
    expect(cleared).toMatch(/^hf_session=;/);
    expect(cleared).toMatch(/Path=\//);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
  } finally {
    await s.close();
  }
});

test('TRUST_PROXY_HOPS defaults to 1 and bad values get a plain-English error', () => {
  const base = { APP_ORIGIN: 'https://a.example.co.uk', DATABASE_URL: 'postgres://u:p@localhost/db', UPLOAD_DIR: '/d', EMAIL_FROM: 'a@b.co', SMTP_URL: 'smtp://x' };
  expect(loadConfig(base).trustProxyHops).toBe(1);
  expect(loadConfig({ ...base, TRUST_PROXY_HOPS: '0' }).trustProxyHops).toBe(0);
  try {
    loadConfig({ ...base, TRUST_PROXY_HOPS: 'many' });
    expect.unreachable();
  } catch (e) {
    expect((e as ConfigError).problems[0]).toMatch(/^TRUST_PROXY_HOPS must be a whole number between 0 and 10/);
  }
});
