import { test, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import { ensureInstance } from '../src/instance.js';
import { wipeAllData } from '../src/db/wipe.js';

test('a production database can never be started in demo mode again', async () => {
  const t = await createTestDb();
  await ensureInstance(t.db, 'demo');
  await ensureInstance(t.db, 'production');           // promotion is allowed once
  await expect(ensureInstance(t.db, 'demo')).rejects.toThrow('This database belongs to a live app (production). Start it with INSTANCE_MODE=production.');
  await expect(ensureInstance(t.db, 'test')).rejects.toThrow('This database belongs to a live app (production).');
  await ensureInstance(t.db, 'production');
  await t.close();
});

test('a database that ever held demo data can never go live', async () => {
  const t = await createTestDb();
  await ensureInstance(t.db, 'demo');
  await t.db.execute(sql`update instance_settings set seeded_at = now()`);
  await expect(ensureInstance(t.db, 'production')).rejects.toThrow('This database holds demo data. Start the live app on a fresh database.');
  const mode = (await t.db.execute(sql`select mode from instance_settings`)).rows[0]!.mode;
  expect(mode).toBe('demo');   // the refusal changed nothing
  await t.close();
});

test('a test database that was seeded is refused too, and a first-time promotion is audited', async () => {
  const a = await createTestDb();
  await ensureInstance(a.db, 'test');
  await a.db.execute(sql`update instance_settings set seeded_at = now()`);
  await expect(ensureInstance(a.db, 'production')).rejects.toThrow('This database holds demo data.');
  await a.close();

  const b = await createTestDb();
  await ensureInstance(b.db, 'test');
  await ensureInstance(b.db, 'production');
  const rows = (await b.db.execute(sql`select action, details from audit_log where action = 'instance.promoted'`)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]!.details).toEqual({ from: 'test', to: 'production' });
  await b.close();
});

test('the database itself refuses to go backwards, even for hand-written SQL', async () => {
  const t = await createTestDb();
  await ensureInstance(t.db, 'demo');
  await t.db.execute(sql`update instance_settings set seeded_at = now()`);
  await expect(t.db.execute(sql`update instance_settings set mode = 'production'`)).rejects.toThrow();
  await expect(t.db.execute(sql`update instance_settings set seeded_at = null`)).rejects.toThrow();
  await expect(t.db.execute(sql`delete from instance_settings`)).rejects.toThrow();
  await expect(t.db.execute(sql`truncate instance_settings`)).rejects.toThrow();

  const live = await createTestDb();
  await ensureInstance(live.db, 'production');
  await expect(live.db.execute(sql`update instance_settings set mode = 'demo'`)).rejects.toThrow();
  await live.close();
  await t.close();
});

test('wiping keeps the record of what the database has been, and never touches a live one', async () => {
  const t = await createTestDb();
  await ensureInstance(t.db, 'demo');
  await t.db.execute(sql`update instance_settings set seeded_at = now()`);
  await t.db.execute(sql`insert into teams (name) values ('Temp')`);
  await wipeAllData(t.db);
  expect((await t.db.execute(sql`select count(*)::int as n from teams`)).rows[0]!.n).toBe(0);
  const row = (await t.db.execute(sql`select mode, seeded_at from instance_settings`)).rows[0]!;
  expect(row.mode).toBe('demo');
  expect(row.seeded_at).not.toBeNull();
  // The purge flag is switched off again afterwards.
  await t.db.execute(sql`insert into audit_log (actor_label, action) values ('system', 'seed.demo')`);
  await expect(t.db.execute(sql`delete from audit_log`)).rejects.toThrow();
  await expect(ensureInstance(t.db, 'production')).rejects.toThrow('This database holds demo data.');
  await t.close();

  const live = await createTestDb();
  await ensureInstance(live.db, 'production');
  await live.db.execute(sql`insert into teams (name) values ('Real')`);
  await expect(wipeAllData(live.db)).rejects.toThrow('cannot be wiped from a live');
  expect((await live.db.execute(sql`select count(*)::int as n from teams`)).rows[0]!.n).toBe(1);
  await live.close();
});
