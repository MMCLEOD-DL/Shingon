import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDb, runMigrations, type Db } from '../../src/db/client.js';

export async function createTestDb(opts: { migrate?: (db: Db) => Promise<void> } = {}): Promise<{ url: string; db: Db; close(): Promise<void> }> {
  const adminUrl = process.env['TEST_DATABASE_URL'];
  if (!adminUrl) {
    throw new Error('TEST_DATABASE_URL is not set. Point it at a Postgres role that may CREATE DATABASE.');
  }
  const name = `hf_test_${randomBytes(8).toString('hex')}`;
  const withAdmin = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect();
    try {
      return await fn(admin);
    } finally {
      await admin.end();
    }
  };
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  const dropDb = () => withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));

  await withAdmin((c) => c.query(`CREATE DATABASE ${name}`));
  // From here on, any failure must drop the database again so nothing is left behind.
  let handle: ReturnType<typeof createDb> | undefined;
  try {
    handle = createDb(url);
    await (opts.migrate ?? runMigrations)(handle.db);
  } catch (e) {
    await handle?.close().catch(() => undefined);
    await dropDb().catch(() => undefined);
    throw e;
  }
  const { db, close: endPool } = handle;
  let closed = false;
  return {
    url,
    db,
    async close() {
      if (closed) return;
      await endPool().catch(() => undefined);
      await dropDb();
      closed = true; // only after a successful drop, so a failed drop can be retried
    },
  };
}
