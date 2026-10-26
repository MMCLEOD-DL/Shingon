import { test, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { readdir } from 'node:fs/promises';
import { createTestApp, call } from './helpers/testApp.js';
import { seedDemo } from '../src/seed/demo.js';
import { receiptPng } from '../src/seed/image.js';
import { ensureInstance } from '../src/instance.js';
import { sweepStrayObjects } from '../src/files/repo.js';
import { LocalDiskStorage } from '../src/files/storage.js';

const NOW = new Date('2026-11-01T12:00:00Z');

test('seeding fills a preview with invented data, once', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  const s = await seedDemo(t.db, t.config, { now: NOW });
  expect(s.counts).toEqual({ teams: 2, people: 10, notes: 32, files: 16 });
  expect(s.text.split('\n')[0]).toBe('Demo data added: 2 teams, 10 people, 32 notes, 16 attached photos.');
  const emails = (await t.db.execute(sql`select email from users`)).rows.map((r) => String(r.email));
  expect(emails.every((e) => e.endsWith('@demo.test'))).toBe(true);
  const again = await seedDemo(t.db, t.config, { now: NOW });
  expect(again.alreadySeeded).toBe(true);
  expect(again.text).toBe('Demo data is already in place. Use --reset to start again.');
  await t.close();
});

test('the same seed gives the same people', async () => {
  const a = await createTestApp({ instanceMode: 'demo' }), b = await createTestApp({ instanceMode: 'demo' });
  const sa = await seedDemo(a.db, a.config, { now: NOW }), sb = await seedDemo(b.db, b.config, { now: NOW });
  expect(sa.signIns).toEqual(sb.signIns);
  const titles = async (t: typeof a) => (await t.db.execute(sql`select n.title from notes n join users u on u.id = n.owner_id order by u.email, n.created_at`)).rows.map((r) => r.title);
  expect(await titles(a)).toEqual(await titles(b));
  await a.close(); await b.close();
});

test('every listed person can sign in with the demo password; the invited one is not listed', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  const s = await seedDemo(t.db, t.config, { now: NOW });
  expect(s.signIns).toHaveLength(9);
  for (const p of s.signIns) {
    const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: p.email, password: s.password });
    expect(r.status, p.email).toBe(200);
  }
  expect(s.text).toContain('Sign in with any of these (password: demo-password-1):\n  admin@demo.test (admin)\n  ops.manager@demo.test (manager, Operations)');
  await t.close();
});

test('people follow the same rules as the app, and the invited one has no password', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  await seedDemo(t.db, t.config, { now: NOW });
  const rows = (await t.db.execute(sql`select u.email, u.role, u.team_id, u.password_hash from users u`)).rows;
  expect(rows.filter((r) => r.role !== 'admin').every((r) => r.team_id !== null)).toBe(true);
  expect(rows.filter((r) => r.role === 'manager')).toHaveLength(2);
  expect(rows.filter((r) => r.password_hash === null)).toHaveLength(1);
  const teams = (await t.db.execute(sql`select name from teams order by name`)).rows.map((r) => r.name);
  expect(teams).toEqual(['Operations', 'Sales']);
  await t.close();
});

test('every photo has a row, an owner, a note, and a stored object; the sweep leaves them all alone', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  await seedDemo(t.db, t.config, { now: NOW });
  const f = (await t.db.execute(sql`select f.storage_key, f.owner_id, f.attached_type, f.attached_id, f.content_type, n.owner_id as note_owner, n.attachment_file_id, n.created_at from files f join notes n on n.id = f.attached_id`)).rows;
  expect(f).toHaveLength(16);
  for (const r of f) {
    expect(r.attached_type).toBe('note');
    expect(r.owner_id).toBe(r.note_owner);
    expect(r.content_type).toBe('image/png');
  }
  const notesWith = (await t.db.execute(sql`select count(*)::int as n from notes where attachment_file_id is not null`)).rows[0]!.n;
  expect(notesWith).toBe(16);
  const dates = (await t.db.execute(sql`select min(created_at) as lo, max(created_at) as hi from notes`)).rows[0]!;
  expect(new Date(String(dates.lo)).getTime()).toBeGreaterThanOrEqual(NOW.getTime() - 60 * 86400_000);
  expect(new Date(String(dates.hi)).getTime()).toBeLessThanOrEqual(NOW.getTime());
  const storage = new LocalDiskStorage(t.config.uploadDir);
  const removed = await sweepStrayObjects(t.db, storage, new Date(Date.now() + 86400_000 * 2));
  expect(removed).toBe(0);
  const onDisk: string[] = [];
  for await (const o of storage.list()) onDisk.push(o.key);
  expect(onDisk.sort()).toEqual(f.map((r) => String(r.storage_key)).sort());
  // The audit log shows what the app would have written.
  const actions = (await t.db.execute(sql`select action, count(*)::int as n from audit_log group by action`)).rows;
  const by = Object.fromEntries(actions.map((r) => [String(r.action), Number(r.n)]));
  expect(by['note.created']).toBe(32);
  expect(by['file.uploaded']).toBe(16);
  expect(by['team.created']).toBe(2);
  expect(by['seed.demo']).toBe(1);
  await t.close();
});

test('production refuses, and reset is demo-only', async () => {
  const t = await createTestApp({ instanceMode: 'production' });
  await expect(seedDemo(t.db, t.config)).rejects.toThrow('Demo data can only be added to a demo or test app, never a live one.');
  expect((await t.db.execute(sql`select count(*)::int as n from users`)).rows[0]!.n).toBe(0);
  await t.close();

  const x = await createTestApp({ instanceMode: 'test' });
  await expect(seedDemo(x.db, x.config, { reset: true })).rejects.toThrow('only allowed in a demo app');
  await x.close();
});

test('a live database refuses to be seeded even when started as demo config', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  await ensureInstance(t.db, 'production');
  await expect(seedDemo(t.db, t.config, { now: NOW })).rejects.toThrow('This database belongs to a live app (production).');
  expect((await t.db.execute(sql`select count(*)::int as n from users`)).rows[0]!.n).toBe(0);
  await t.close();
});

test('once seeded, the database can never be promoted, not even after a reset', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  await seedDemo(t.db, t.config, { now: NOW });
  await expect(ensureInstance(t.db, 'production')).rejects.toThrow('This database holds demo data. Start the live app on a fresh database.');
  await seedDemo(t.db, t.config, { now: NOW, reset: true });
  await expect(ensureInstance(t.db, 'production')).rejects.toThrow('This database holds demo data.');
  expect((await t.db.execute(sql`select mode, seeded_at from instance_settings`)).rows[0]!.seeded_at).not.toBeNull();
  await t.close();
});

test('reset wipes and re-seeds to the same data, and removes the old photo objects', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  const first = await seedDemo(t.db, t.config, { now: NOW });
  const before = (await t.db.execute(sql`select storage_key from files`)).rows.map((r) => String(r.storage_key));
  const second = await seedDemo(t.db, t.config, { now: NOW, reset: true });
  expect(second.alreadySeeded).toBe(false);
  expect(second.counts).toEqual(first.counts);
  expect(second.signIns).toEqual(first.signIns);
  expect((await t.db.execute(sql`select count(*)::int as n from users`)).rows[0]!.n).toBe(10);
  expect((await t.db.execute(sql`select count(*)::int as n from audit_log where action = 'seed.demo'`)).rows[0]!.n).toBe(1);
  const keys = (await t.db.execute(sql`select storage_key from files`)).rows.map((r) => String(r.storage_key));
  const storage = new LocalDiskStorage(t.config.uploadDir);
  const onDisk: string[] = [];
  for await (const o of storage.list()) onDisk.push(o.key);
  expect(onDisk.sort()).toEqual(keys.sort());
  expect(before.some((k) => onDisk.includes(k))).toBe(false);
  await t.close();
});

test('a failed seed leaves no rows and no stored objects, and the database stays unseeded', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  // A clashing user makes the people seeder fail part-way.
  await t.db.execute(sql`insert into users (email, name, role) values ('admin@demo.test', 'Squatter', 'admin')`);
  await expect(seedDemo(t.db, t.config, { now: NOW })).rejects.toThrow();
  expect((await t.db.execute(sql`select count(*)::int as n from teams`)).rows[0]!.n).toBe(0);
  expect((await t.db.execute(sql`select seeded_at from instance_settings`)).rows.every((r) => r.seeded_at === null)).toBe(true);
  expect(await readdir(t.config.uploadDir)).toEqual([]);
  await t.close();
});

test('the receipt picture is a valid PNG and is the same every time', () => {
  const a = receiptPng(['Shop', 'Item 1.00']);
  expect(a.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  expect(a.readUInt32BE(16)).toBe(360);
  expect(a.readUInt32BE(20)).toBe(560);
  expect(receiptPng(['Shop', 'Item 1.00']).equals(a)).toBe(true);
});
