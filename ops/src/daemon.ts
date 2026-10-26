import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@hf/server/db/schema';
import type { Db } from '@hf/server/db';
import { type OpsConfig } from './config.js';
import { runBackup, LOCAL_WARNING } from './backup.js';
import { verifyLatestRestore } from './restore.js';
import { withOpsLock, OpsBusyError } from './opsLock.js';
import { connect, pgEnv } from './pg.js';
import { recordRun, scrub, type OpsDeps } from './runs.js';
import { execRunner } from './runner.js';
import { startScheduler, type Job } from './scheduler.js';

export const AUDIT_PURGE_SCHEDULE = '15 3 * * *';
export const SCHEDULED_BACKUP_LOCK_WAIT = 60 * 60e3;

/** Everything an ops command needs, with a pool that survives the database being dropped and recreated under it. */
export function createOpsDeps(cfg: OpsConfig, log: (line: string) => void = (l) => { console.log(l); }): { deps: OpsDeps; pool: pg.Pool; close: () => Promise<void> } {
  const pool = new pg.Pool({ connectionString: cfg.databaseUrl, max: 4, connectionTimeoutMillis: 30_000 });
  // A restore drops the database WITH (FORCE), which ends the pool's idle connections. Without this listener that would
  // crash the daemon; with it, the pool discards them and opens fresh ones on the next query.
  pool.on('error', () => { log('A database connection dropped while idle (for example during a restore). Ops will reconnect when it next needs the database.'); });
  const db = drizzle(pool, { schema }) as Db;
  return { deps: { cfg, run: execRunner, db, now: () => new Date(), log }, pool, close: () => pool.end() };
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
    // Already logged and recorded; marked so the failure hook does not log it again.
    throw Object.assign(new Error(msg), { reported: true });
  }
}

export function daemonJobs(deps: OpsDeps): Job[] {
  return [
    // Waits up to an hour for a restore test or restore to finish rather than skipping the night's backup.
    { name: 'backup', cron: deps.cfg.backup.schedule, run: async () => { await runBackup(deps, 'scheduled', { lockWaitMs: SCHEDULED_BACKUP_LOCK_WAIT }); } },
    {
      name: 'restore-test',
      cron: deps.cfg.backup.restoreTestSchedule,
      run: async () => {
        const r = await verifyLatestRestore(deps);
        // Already logged and recorded by verifyLatestRestore; thrown so the failure hook (Task 19: the alert) sees it.
        if (!r.ok) throw Object.assign(new Error(`The restore test failed. ${r.problems.join(' ')}`), { reported: true });
      },
    },
    { name: 'audit-purge', cron: AUDIT_PURGE_SCHEDULE, run: async () => { await purgeAuditLog(deps); } },
  ];
}

/** What the daemon does when a scheduled job fails. A failure that was already logged and recorded is not logged again. */
export function onJobFailure(deps: OpsDeps): (name: string, err: Error) => Promise<void> {
  return (name, err) => {
    if ((err as { reported?: unknown }).reported !== true) deps.log(`The scheduled ${name} did not work: ${scrub(deps, err.message)}`);
    // Task 19 routes the failure to the alert channel here.
    return Promise.resolve();
  };
}

const LEFTOVER_FOLDER = /^(verify|restore|restore-uploads)-/;
const SCRATCH_DB = /^hf_restore_test_(\d{14})_[0-9a-f]+$/;

function stampTime(ts: string): Date {
  return new Date(`${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`);
}

/**
 * Removes what an interrupted run left behind (a crash or a stop during a restore test or restore): work folders and scratch
 * databases more than `maxAgeMs` old, the backup work folder, and a half-restored `<app db>_incoming` database. Done under
 * the ops lock, so nothing it removes can belong to a run in progress; skipped when another run holds the lock.
 */
export async function sweepLeftovers(deps: OpsDeps, maxAgeMs = 3600e3): Promise<string[]> {
  const removed: string[] = [];
  const cutoff = deps.now().getTime() - maxAgeMs;
  try {
    await withOpsLock(deps, { waitMs: 0, busyMessage: 'busy' }, async () => {
      let entries: string[] = [];
      try { entries = await readdir(deps.cfg.workDir); } catch { /* no work folder yet */ }
      for (const name of entries) {
        const full = path.join(deps.cfg.workDir, name);
        const old = (await stat(full).catch(() => null))?.mtime.getTime() ?? Infinity;
        if (name === 'backup' || (LEFTOVER_FOLDER.test(name) && old < cutoff)) {
          await rm(full, { recursive: true, force: true });
          removed.push(`folder ${name}`);
        }
      }
      const appDb = pgEnv(deps.cfg.databaseUrl).PGDATABASE;
      const copies = [`${appDb}_incoming`, `${appDb}_old`];
      const c = await connect(deps.cfg.databaseUrl, 'postgres');
      try {
        const dbs = (await c.query<{ datname: string }>(`select datname from pg_database where datname like 'hf\\_restore\\_test\\_%' or datname = any($1) or datname = $2`, [copies, appDb])).rows.map((r) => r.datname);
        for (const datname of dbs) {
          const m = SCRATCH_DB.exec(datname);
          if (m?.[1] !== undefined && stampTime(m[1]).getTime() < cutoff) {
            await c.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
            removed.push(`database ${datname}`);
          }
        }
        const left = copies.filter((d) => dbs.includes(d));
        if (dbs.includes(appDb)) {
          // The live database is there, so these are leftovers of an interrupted restore.
          for (const d of left) {
            await c.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
            removed.push(`database ${d}`);
          }
        } else if (left.length > 0) {
          // No live database: these may be the only copies of the data. Never drop them.
          const what = left.map((d) => (d.endsWith('_old') ? `${d} (the data from before an interrupted restore)` : `${d} (a restored copy)`)).join(' and ');
          deps.log(`Warning: the app database ${appDb} is missing, but ${what} still exists. Nothing has been removed. Rename the right one to ${appDb} by hand (ALTER DATABASE … RENAME TO ${appDb}).`);
        }
      } finally {
        await c.end().catch(() => undefined);
      }
    });
  } catch (e) {
    deps.log(e instanceof OpsBusyError && !e.unreachable
      ? 'Leftovers from earlier runs were not checked because another backup or restore is running. Ops checks again at its next start.'
      : 'Leftovers from earlier runs were not checked because the database could not be reached. Ops checks again at its next start.');
    return removed;
  }
  if (removed.length > 0) deps.log(`Removed leftovers of interrupted runs: ${removed.join(', ')}.`);
  return removed;
}

/** `ops daemon`: the long-running scheduler. Resolves when asked to stop (SIGTERM from `docker compose stop`, or SIGINT). */
export async function runDaemon(deps: OpsDeps, close: () => Promise<void>): Promise<void> {
  const { cfg } = deps;
  deps.log(`Ops is running for ${cfg.client}. Backups: "${cfg.backup.schedule}"; restore tests: "${cfg.backup.restoreTestSchedule}"; audit-log tidy-up: "${AUDIT_PURGE_SCHEDULE}" (UK time).`);
  if (cfg.backup.allowLocal) deps.log(`BACKUP_ALLOW_LOCAL is true. ${LOCAL_WARNING}`);
  for (const w of cfg.warnings) deps.log(`Warning: ${w}`);
  await sweepLeftovers(deps);
  const scheduler = startScheduler(daemonJobs(deps), onJobFailure(deps));
  await new Promise<void>((resolve) => {
    const stop = (): void => { resolve(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  scheduler.stop();
  deps.log('Ops is stopping.');
  await close().catch(() => undefined);
}
