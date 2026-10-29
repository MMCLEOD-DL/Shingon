import { test, expect, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import { createDb } from '../src/db/client.js';

test('createTestDb gives an isolated, migrated database and drops it on close', async () => {
  const a = await createTestDb();
  const b = await createTestDb();
  try {
    expect(a.url).not.toBe(b.url);
    const r = await a.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    expect(r.rows[0]).toHaveProperty('n');
    const name = new URL(a.url).pathname.slice(1);
    await a.close();
    const still = await b.db.execute(sql`select 1 from pg_database where datname = ${name}`);
    expect(still.rows).toHaveLength(0);
  } finally {
    await a.close();
    await b.close();
  }
});

test('a failed migration drops the half-built database and rethrows', async () => {
  let name = '';
  await expect(
    createTestDb({
      migrate: async (db) => {
        const r = await db.execute(sql`select current_database() as n`);
        name = (r.rows[0] as { n: string }).n;
        throw new Error('boom');
      },
    }),
  ).rejects.toThrow('boom');
  expect(name).toMatch(/^hf_test_[0-9a-f]{16}$/);
  const probe = await createTestDb();
  try {
    const r = await probe.db.execute(sql`select 1 from pg_database where datname = ${name}`);
    expect(r.rows).toHaveLength(0);
  } finally {
    await probe.close();
  }
});

test('an idle pool error is logged without crashing or leaking the address', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { pool } = createDb('postgres://user:s3cret@127.0.0.1:1/none');
  try {
    expect(() => pool.emit('error', new Error('connection to postgres://user:s3cret@host lost'))).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).not.toContain('s3cret');
  } finally {
    spy.mockRestore();
    void pool.end();
  }
});
