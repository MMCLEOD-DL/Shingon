import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let N: { id: string }, S: { id: string };
let admin: { id: string }, mN: { id: string }, alice: { id: string }, carol: { id: string };
beforeAll(async () => {
  t = await createTestApp();
  N = await makeTeam(t.db, 'North'); S = await makeTeam(t.db, 'South');
  admin = await makeUser(t.db, { role: 'admin', name: 'Ada' });
  mN = await makeUser(t.db, { role: 'manager', teamId: N.id, name: 'Nina' });
  alice = await makeUser(t.db, { role: 'member', teamId: N.id, name: 'Alice' });
  carol = await makeUser(t.db, { role: 'member', teamId: S.id, name: 'Carol' });
});
afterAll(async () => { await t.close(); });

test('admin lists everyone; a manager lists only their team; a member may not list', async () => {
  const all = await call(t, await signInAs(t, admin), 'GET', '/api/users');
  expect((all.json.users as { name: string }[]).map((u) => u.name)).toEqual(['Ada', 'Alice', 'Carol', 'Nina']);
  const team = await call(t, await signInAs(t, mN), 'GET', '/api/users');
  expect((team.json.users as { name: string }[]).map((u) => u.name)).toEqual(['Alice', 'Nina']);
  expect((await call(t, await signInAs(t, alice), 'GET', '/api/users')).status).toBe(403);
});

test('a manager asking for another team\'s user gets 404, not 403', async () => {
  expect((await call(t, await signInAs(t, mN), 'GET', `/api/users/${carol.id}`)).status).toBe(404);
});

test('an admin cannot demote or disable themselves', async () => {
  const r = await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${admin.id}`, { role: 'member' });
  expect(r.status).toBe(409);
  expect(r.json.error).toBe("You can't change your own role or disable your own account. Ask another admin.");
});

test('demoting a manager takes effect on their very next request', async () => {
  const m = await makeUser(t.db, { role: 'manager', teamId: N.id });
  const mAuth = await signInAs(t, m);
  expect((await call(t, mAuth, 'GET', '/api/users')).status).toBe(200);
  await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${m.id}`, { role: 'member' });
  expect((await call(t, mAuth, 'GET', '/api/users')).status).toBe(403);
});

test('disabling signs the user out everywhere', async () => {
  const u = await makeUser(t.db, { role: 'member', teamId: N.id });
  const uAuth = await signInAs(t, u);
  await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${u.id}`, { disabled: true });
  expect((await call(t, uAuth, 'GET', '/api/me')).status).toBe(401);
});

test('members and managers need a team', async () => {
  const r = await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${alice.id}`, { teamId: null });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('Managers and members must belong to a team.');
});

test('self-promotion through /api/me is refused and changes nothing', async () => {
  const auth = await signInAs(t, alice);
  const r = await call(t, auth, 'PATCH', '/api/me', { name: 'Alice', role: 'admin' });
  expect(r.status).toBe(400);
  expect((await call(t, auth, 'GET', '/api/me')).json.user.role).toBe('member');
});

test('teams: a manager sees only their own; duplicates are explained', async () => {
  expect((await call(t, await signInAs(t, mN), 'GET', '/api/teams')).json.teams).toEqual([{ id: N.id, name: 'North' }]);
  const dup = await call(t, await signInAs(t, admin), 'POST', '/api/teams', { name: 'North' });
  expect(dup.status).toBe(409);
  expect(dup.json.error).toBe('There is already a team called "North".');
});

test('status oracle: anonymous 401, member 403 on manage, manager 403 on manage, unknown user 404', async () => {
  expect((await call(t, null, 'PATCH', `/api/users/${alice.id}`, { role: 'admin' })).status).toBe(401);
  expect((await call(t, null, 'GET', '/api/users')).status).toBe(401);
  expect((await call(t, await signInAs(t, alice), 'PATCH', `/api/users/${carol.id}`, { name: 'x' })).status).toBe(403);
  expect((await call(t, await signInAs(t, mN), 'PATCH', `/api/users/${alice.id}`, { role: 'admin' })).status).toBe(403);
  expect((await call(t, await signInAs(t, mN), 'POST', '/api/teams', { name: 'Z' })).status).toBe(403);
  expect((await call(t, await signInAs(t, admin), 'PATCH', '/api/users/00000000-0000-4000-8000-000000000000', { name: 'x' })).status).toBe(404);
});

test('an unknown team is refused; a disabled user can be re-enabled; responses carry no password hash', async () => {
  const a = await signInAs(t, admin);
  const u = await makeUser(t.db, { role: 'member', teamId: N.id });
  const bad = await call(t, a, 'PATCH', `/api/users/${u.id}`, { teamId: '00000000-0000-4000-8000-000000000000' });
  expect(bad.status).toBe(400);
  expect(bad.json.error).toBe("That team doesn't exist.");
  const off = await call(t, a, 'PATCH', `/api/users/${u.id}`, { disabled: true });
  expect(off.json.user.disabled).toBe(true);
  const on = await call(t, a, 'PATCH', `/api/users/${u.id}`, { disabled: false });
  expect(on.json.user.disabled).toBe(false);
  expect(on.text).not.toMatch(/password|scrypt/i);
});

test('/api/me renames the caller', async () => {
  const u = await makeUser(t.db, { role: 'member', teamId: S.id, name: 'Old' });
  const r = await call(t, await signInAs(t, u), 'PATCH', '/api/me', { name: '  New  ' });
  expect(r.json.user.name).toBe('New');
});

test('the self-rule also blocks an admin disabling themselves', async () => {
  const r = await call(t, await signInAs(t, admin), 'PATCH', `/api/users/${admin.id}`, { disabled: true });
  expect(r.status).toBe(409);
});

test('a teamless member can be disabled (emergency revoke); setting a member role with no team is refused', async () => {
  const a = await signInAs(t, admin);
  const u = await makeUser(t.db, { role: 'member', teamId: null });
  const uAuth = await signInAs(t, u);
  const off = await call(t, a, 'PATCH', `/api/users/${u.id}`, { disabled: true });
  expect(off.status).toBe(200);
  expect((await call(t, uAuth, 'GET', '/api/me')).status).toBe(401);
  const bad = await call(t, a, 'PATCH', `/api/users/${u.id}`, { role: 'member', teamId: null });
  expect(bad.status).toBe(400);
});
