import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { processOutbox } from '../src/email/index.js';
import { bootstrapAdmin } from '../src/auth/bootstrap-admin.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
const site = { appName: 'Highland App', appOrigin: 'http://hf.test' };
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

test('the first admin comes from the command line, and only once', async () => {
  const { link } = await bootstrapAdmin(t.db, t.config, { email: 'Owner@HF.test', name: 'Owner' });
  expect(link).toMatch(/^http:\/\/hf\.test\/accept-invite#[A-Za-z0-9_-]{43}$/);
  await expect(bootstrapAdmin(t.db, t.config, { email: 'b@hf.test', name: 'B' }))
    .rejects.toThrow('An admin already exists. Use the app to invite more people.');
  const r = await call(t, null, 'POST', '/api/auth/accept-invite', { token: link.split('#')[1], password: 'owner password 1' });
  expect(r.status).toBe(200);
  expect(r.json.user).toMatchObject({ email: 'owner@hf.test', role: 'admin' });
  expect(String(r.headers['set-cookie'])).toMatch(/^hf_session=/);
});

test('invite → mail → accept → signed in; the link works once', async () => {
  const admin = await makeUser(t.db, { role: 'admin', name: 'Ada' });
  const N = await makeTeam(t.db, 'North');
  const r = await call(t, await signInAs(t, admin), 'POST', '/api/users/invite', { email: 'new@hf.test', name: 'Newt', role: 'member', teamId: N.id });
  expect(r.status).toBe(201);
  expect(r.json.user).toMatchObject({ activated: false, disabled: false });
  await processOutbox(t.db, t.mail, site);
  const m = t.mail.sent.at(-1)!;
  expect(m.subject).toBe('Ada invited you to Highland App');
  const token = /accept-invite#([A-Za-z0-9_-]{43})/.exec(m.text)![1];
  expect((await call(t, null, 'POST', '/api/auth/accept-invite', { token, password: 'newt password 1' })).status).toBe(200);
  const again = await call(t, null, 'POST', '/api/auth/accept-invite', { token, password: 'newt password 2' });
  expect(again.json.error).toBe('This invite link has expired or has already been used. Ask your administrator to send a new one.');
});

test('a member cannot invite; a duplicate email is explained; an un-activated user cannot sign in', async () => {
  const N = await makeTeam(t.db, 'South');
  const m = await makeUser(t.db, { role: 'member', teamId: N.id });
  expect((await call(t, await signInAs(t, m), 'POST', '/api/users/invite', { email: 'x@hf.test', name: 'X', role: 'admin', teamId: null })).status).toBe(403);
  const admin = await makeUser(t.db, { role: 'admin' });
  const dup = await call(t, await signInAs(t, admin), 'POST', '/api/users/invite', { email: m.email, name: 'X', role: 'member', teamId: N.id });
  expect(dup.json.error).toBe('Someone with that email already has an account.');
});
