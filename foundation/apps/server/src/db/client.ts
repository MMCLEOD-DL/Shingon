import pg from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export function createDb(url: string): { db: Db; pool: pg.Pool; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  // An idle client can fail (for example when Postgres restarts). Without a listener that would crash the app;
  // with one, the pool simply discards the client and makes a new one when needed.
  pool.on('error', () => {
    console.error('The database connection dropped while idle. The app will reconnect on the next request.');
  });
  const db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}

export async function runMigrations(db: Db): Promise<void> {
  // The same relative path works from src/ (tsx) and dist/, both one level below the workspace root.
  await migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) });
}
