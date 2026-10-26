import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@hf/server/db/schema';
import type { Db } from '@hf/server/db';
import { type OpsConfig } from './config.js';
import { runBackup, LOCAL_WARNING } from './backup.js';
import { verifyLatestRestore } from './restore.js';
import { recordRun, scrub, type OpsDeps } from './runs.js';
import { execRunner } from './runner.js';
import { startScheduler, type Job } from './scheduler.js';

export const AUDIT_PURGE_SCHEDULE = '15 3 * * *';

/** Everything an ops command needs, with a pool that survives the database being dropped and recreated under it. */
export function createOpsDeps(cfg: OpsConfig, log: (line: string) => void = (l) => { console.log(l); }): { deps: OpsDeps; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4, connectionTimeoutMillis: 30_000 });
  // A restore drops the database WITH (FORCE), which ends the pool's idle connections. Without this listener that would
  // crash the daemon; with it, the pool discards them and opens fresh ones on the next query.
  pool.on('error', () => { log('A database connection dropped while idle (for example during a restore). Ops will reconnect when it next needs the database.'); });
  const db = drizzle(pool, { schema }) as Db;
  return { deps: { cfg, run: execRunner, db, now: () => new Date(), log }, close: () => pool.end() };
}

export async function purgeAuditLog(deps: OpsDeps): Promise<number> {
  const days = deps.cfg.auditRetentionDays;
  try {
    const r = await deps.db.execute<{ n: string }>(sql`select audit_purge_before(now() - make_interval(days => ${days})) as n`);
    const n = Number(r.rows[0]?.n ?? 0);
    await recordRun(deps, 'audit-purge', true, `Audit log tidied: ${String(n)} ${n === 1 ? 'entry' : 'entries'} older than ${String(days)} days removed.`);
    return n;
  } catch {
    const msg = 'The audit log could not be tidied. Check that the database is running and up to date.';
    await recordRun(deps, 'audit-purge', false, msg);
    throw new Error(msg);
  }
}

export function daemonJobs(deps: OpsDeps): Job[] {
  return [
    { name: 'backup', cron: deps.cfg.backup.schedule, run: async () => { await runBackup(deps, 'scheduled'); } },
    {
      name: 'restore-test',
      cron: deps.cfg.backup.restoreTestSchedule,
      run: async () => {
        const r = await verifyLatestRestore(deps);
        if (!r.ok) throw new Error(`The restore test failed. ${r.problems.join(' ')}`);
      },
    },
    { name: 'audit-purge', cron: AUDIT_PURGE_SCHEDULE, run: async () => { await purgeAuditLog(deps); } },
  ];
}

/** `ops daemon`: the long-running scheduler. Resolves when asked to stop (SIGTERM from `docker compose stop`, or SIGINT). */
export async function runDaemon(deps: OpsDeps, close: () => Promise<void>): Promise<void> {
  const { cfg } = deps;
  deps.log(`Ops is running for ${cfg.client}. Backups: "${cfg.backup.schedule}"; restore tests: "${cfg.backup.restoreTestSchedule}"; audit-log tidy-up: "${AUDIT_PURGE_SCHEDULE}" (UK time).`);
  if (cfg.backup.allowLocal) deps.log(`BACKUP_ALLOW_LOCAL is true. ${LOCAL_WARNING}`);
  // Task 19 routes these to the alert channel; until then they go to the log.
  const scheduler = startScheduler(daemonJobs(deps), async (name, err) => {
    deps.log(`The scheduled ${name} did not work: ${scrub(deps, err.message)}`);
    return Promise.resolve();
  });
  await new Promise<void>((resolve) => {
    const stop = (): void => { resolve(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  scheduler.stop();
  deps.log('Ops is stopping.');
  await close().catch(() => undefined);
}
