import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call } from './helpers/testApp.js';
import { bootstrapAdmin } from '../src/auth/bootstrap-admin.js';
import { auditLog } from '../src/db/schema/index.js';

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
