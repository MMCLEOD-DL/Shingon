import { test, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import { makeUser } from './helpers/factories.js';
import { createSession, loadSession, revokeSessions, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS } from '../src/auth/sessions.js';
import { users, sessions } from '../src/db/schema/index.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

test('the token is never stored; only its hash is', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const { token } = await createSession(t.db, u.id, {});
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const rows = await t.db.select().from(sessions).where(eq(sessions.userId, u.id));
  expect(rows[0]!.id).not.toContain(token);
  expect(rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
});

test('idle and absolute expiry', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const t0 = new Date('2026-11-01T09:00:00Z');
  const { token } = await createSession(t.db, u.id, {}, t0);
  expect(await loadSession(t.db, token, new Date(t0.getTime() + SESSION_IDLE_MS - 1000))).not.toBeNull();
  // the load above slid last_seen; 29 days of daily use is fine, day 30 is not
  let now = t0.getTime();
  for (let d = 1; d < 30; d++) { now = t0.getTime() + d * 86400e3; expect(await loadSession(t.db, token, new Date(now))).not.toBeNull(); }
  expect(await loadSession(t.db, token, new Date(t0.getTime() + SESSION_ABSOLUTE_MS + 1))).toBeNull();
  const { token: t2 } = await createSession(t.db, u.id, {}, t0);
  expect(await loadSession(t.db, t2, new Date(t0.getTime() + SESSION_IDLE_MS + 1))).toBeNull();
});

test('a disabled user has no session, even with a token issued before', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const { token } = await createSession(t.db, u.id, {});
  await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
  expect(await loadSession(t.db, token)).toBeNull();
});

test('a role change is seen on the next load', async () => {
  const u = await makeUser(t.db, { role: 'manager' });
  const { token } = await createSession(t.db, u.id, {});
  await t.db.update(users).set({ role: 'member' }).where(eq(users.id, u.id));
  expect((await loadSession(t.db, token))!.actor.role).toBe('member');
});

test('revokeSessions can keep the current one', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const a = await createSession(t.db, u.id, {});
  const b = await createSession(t.db, u.id, {});
  const keep = (await loadSession(t.db, a.token))!.sessionId;
  expect(await revokeSessions(t.db, u.id, { exceptSessionId: keep })).toBe(1);
  expect(await loadSession(t.db, a.token)).not.toBeNull();
  expect(await loadSession(t.db, b.token)).toBeNull();
});
