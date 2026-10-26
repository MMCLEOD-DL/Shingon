import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { connect, pgEnv } from './pg.js';
import type { OpsDeps } from './runs.js';

/**
 * One lock for everything that touches the work folder or replaces a database: backups, restore tests, restores and
 * (Task 20) rollbacks. It is a Postgres advisory lock held on a connection to the `postgres` maintenance database, not the
 * app's: a restore drops the app database WITH (FORCE), which would end a session there and silently release the lock.
 * The key is derived from the app database's name, so two deployments (or parallel test databases) on one server never clash.
 * The lock is re-entrant within one run: the safety backup inside a restore runs under the restore's lock.
 */
export class OpsBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpsBusyError';
  }
}

const CLASS_ID = 0x48460001;
const held = new AsyncLocalStorage<true>();

/** FNV-1a, folded into a signed 32-bit integer for pg_try_advisory_lock(int, int). */
export function lockKey(databaseName: string): number {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(databaseName, 'utf8')) {
    h ^= ch;
    h = Math.imul(h, 0x01000193);
  }
  return h | 0;
}

/** True when the current run already holds the ops lock. */
export const holdsOpsLock = (): boolean => held.getStore() === true;

/**
 * Runs `fn` while holding the ops lock. Waits up to `waitMs` for it (checking every second); if another run still holds it,
 * throws OpsBusyError with `busyMessage`. If this run already holds it, `fn` simply runs.
 */
export async function withOpsLock<T>(deps: Pick<OpsDeps, 'cfg'>, opts: { waitMs: number; busyMessage: string }, fn: () => Promise<T>): Promise<T> {
  if (holdsOpsLock()) return fn();
  const key = lockKey(pgEnv(deps.cfg.databaseUrl).PGDATABASE);
  let c: pg.Client;
  try {
    c = await connect(deps.cfg.databaseUrl, 'postgres');
  } catch {
    throw new OpsBusyError('The database could not be reached, so ops could not make sure nothing else is running. Check that the database is running.');
  }
  try {
    const deadline = Date.now() + opts.waitMs;
    for (;;) {
      const r = await c.query<{ ok: boolean }>('select pg_try_advisory_lock($1, $2) as ok', [CLASS_ID, key]);
      if (r.rows[0]?.ok === true) break;
      if (Date.now() >= deadline) throw new OpsBusyError(opts.busyMessage);
      await new Promise((res) => setTimeout(res, Math.min(1000, Math.max(50, deadline - Date.now()))));
    }
    try {
      return await held.run(true, fn);
    } finally {
      await c.query('select pg_advisory_unlock($1, $2)', [CLASS_ID, key]).catch(() => undefined);
    }
  } finally {
    // Ending the session releases the lock even if the unlock above failed.
    await c.end().catch(() => undefined);
  }
}
