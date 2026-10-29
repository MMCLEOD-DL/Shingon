import { sql } from 'drizzle-orm';
import type { Db, Tx } from './client.js';

/** The database's memory of its own mode and of ever holding demo data. A wipe must never forget either. */
const KEPT = new Set(['instance_settings']);

/**
 * Empties every table except `instance_settings` in one transaction (a savepoint when given a transaction).
 * Refuses on a database that has ever been live. The audit log refuses TRUNCATE unless the purge flag is set for the transaction,
 * so the flag is switched on only for the truncate and off again straight after.
 */
export async function wipeAllData(db: Db | Tx): Promise<void> {
  await db.transaction(async (tx) => {
    const stored = await tx.execute<{ mode: string }>(sql`select mode from instance_settings where id = 1 for share`);
    if (stored.rows[0]?.mode === 'production') throw new Error('Data cannot be wiped from a live (production) database.');
    const tables = await tx.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public' order by tablename`);
    const list = tables.rows.filter((r) => !KEPT.has(r.tablename) && !r.tablename.startsWith('__drizzle')).map((r) => `"${r.tablename}"`).join(', ');
    if (!list) return;
    await tx.execute(sql`set local hf.audit_purge = 'on'`);
    await tx.execute(sql.raw(`truncate ${list} restart identity cascade`));
    await tx.execute(sql`set local hf.audit_purge = 'off'`);
  });
}
