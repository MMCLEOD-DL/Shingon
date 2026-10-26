import { test, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';

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
