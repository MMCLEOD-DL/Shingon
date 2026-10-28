import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import * as schema from '@hf/server/db/schema';
import type { Db } from '@hf/server/db';
import { type OpsConfig } from './config.js';
import { runBackup, LOCAL_WARNING, BackupError, firstLine } from './backup.js';
import { scratchPrefix, verifyLatestRestore } from './restore.js';
import { withOpsLock, OpsBusyError, opsLockHeld } from './opsLock.js';
import { connect, pgEnv } from './pg.js';
import { outstandingUpdate, recordRun, scrub, type OpsDeps } from './runs.js';
import { execRunner } from './runner.js';
import { startScheduler, type Job, type ScheduleFn } from './scheduler.js';
import { alertSecrets, channelFromConfig, logChannel, redactAlert, redactingChannel, type AlertChannel } from './alerts.js';
import { Monitor } from './monitor.js';
import { monitorChecks } from './checks.js';
import { readRecord, recordIsLeftover, UPDATE_RECORD } from './journal.js';
import { appJobs, type AppJob } from '@hf/server/jobs';
import { AppJobError, scheduleAppJobs } from './appJobs.js';

export const AUDIT_PURGE_SCHEDULE = '15 3 * * *';
export const SCHEDULED_BACKUP_LOCK_WAIT = 60 * 60e3;
/** The monitor checks every minute. It is its own croner job, so a backup waiting for the ops lock never holds it up. */
export const MONITOR_SCHEDULE = '* * * * *';

/** Ops' own job names as the operator reads them in an alert. An app job is named by its own label (AppJobError). */
const JOB_LABEL: Record<string, string> = { backup: 'backup', 'restore-test': 'restore test', 'audit-purge': 'audit-log tidy-up', monitor: 'health check' };

/**
 * The scheduled restore test. A failed test sends its alert at once, although nothing threw: `verifyLatestRestore` has
 * already logged and recorded it. `deps.verify` replaces `verifyLatestRestore` in tests.
 */
export function restoreTestJob(deps: OpsDeps & { verify?: (d: OpsDeps) => Promise<{ ok: boolean; problems: string[] }> }, channel: AlertChannel, client: string): () => Promise<void> {
  return async () => {
    const r = await (deps.verify ?? verifyLatestRestore)(deps);
    if (r.ok) return;
    try {
      await channel.send(`[${client}] Problem: the restore test failed. ${r.problems.join(' ')}`);
    } catch (e) {
      deps.log(`The alert about the failed restore test could not be sent: ${e instanceof Error ? e.message : 'unknown problem'}`);
    }
  };
}

const pauseText = (snapshot?: string): string =>
  `Backups are paused because an update could not be undone${snapshot !== undefined ? `: backup ${snapshot.slice(0, 8)} holds the data from before it and must be kept as it is` : ''}. `
  + 'Nothing is backed up or tidied away meanwhile. See the runbook, section "Recovering from a failed update"; when the box is recovered, run: docker compose run --rm updater update --mark-recovered';

/**
 * Why scheduled backups (and with them every prune) must not run now, or null: an update record left in /state by an update
 * that stopped part-way, or a recorded update whose undo failed and that has not been marked as recovered. Either way the
 * pre-update backup the alert names must not be pruned or pushed out (Task 20 review).
 */
export async function backupPause(deps: OpsDeps): Promise<string | null> {
  const stateDir = path.dirname(deps.cfg.workDir);
  const rec = await readRecord(path.join(stateDir, UPDATE_RECORD)).catch(() => null);
  // A running update (its lock's holder is alive) is not a leftover: then the backup simply waits for the ops lock.
  if (rec !== null && (await recordIsLeftover(rec, stateDir, deps.now(), () => opsLockHeld(deps)))) return pauseText(rec.snapshot);
  return urgentPause(deps);
}

/** The ops-log half of the pause: a recorded failed undo not yet marked recovered. Fails closed. */
async function urgentPause(deps: OpsDeps): Promise<string | null> {
  let urgent: Awaited<ReturnType<typeof outstandingUpdate>>;
  try {
    urgent = await outstandingUpdate(deps.db);
  } catch {
    // Fail closed: without the ops log there is no knowing whether a failed update's backup must be kept.
    return 'Backups are paused for now because the ops log in the database could not be read to check for an update that could not be undone (is the database running?). Nothing is backed up or tidied away until it can be read.';
  }
  return urgent !== null ? pauseText(urgent.snapshotId) : null;
}

/**
 * Asked by a scheduled backup right before its prune, while it holds the ops lock. An updater writes its record only while
 * holding that lock, so no update can be running now: any record present is left behind, whatever its step or age, and the
 * snapshot it names must not be pruned (Task 20 review round 3).
 */
export async function prunePause(deps: OpsDeps): Promise<string | null> {
  const rec = await readRecord(path.join(path.dirname(deps.cfg.workDir), UPDATE_RECORD)).catch(() => null);
  if (rec !== null) return pauseText(rec.snapshot);
  return urgentPause(deps);
}

/**
 * `ops backup`: refused while backups are paused, unless forced, because its snapshot would become "latest" in place of
 * the backup a failed update's alert names (which stays safe either way: manual backups never prune).
 */
export async function manualBackup(deps: OpsDeps, opts: { force: boolean; lockWaitMs: number }): Promise<{ ok: boolean; message?: string }> {
  const paused = await backupPause(deps);
  if (paused !== null && !opts.force) {
    return { ok: false, message: `${paused} A manual backup now would become "latest" in place of the backup the alert names, so it was not taken. To take one anyway, run: docker compose run --rm ops backup --force` };
  }
  await runBackup(deps, 'manual', { lockWaitMs: opts.lockWaitMs });
  return { ok: true };
}

/** The scheduled backup: skipped (recorded as busy, alerted) while backups are paused; otherwise the usual backup and prune. */
export function scheduledBackupJob(deps: OpsDeps, channel: AlertChannel): () => Promise<void> {
  return async () => {
    const paused = await backupPause(deps);
    if (paused !== null) {
      await recordRun(deps, 'backup', false, paused, undefined, { busy: true });
      await channel.send(`[${deps.cfg.client}] ${paused}`).catch((e: unknown) => { deps.log(`The alert about the paused backups could not be sent: ${e instanceof Error ? e.message : 'unknown problem'}`); });
      return;
    }
    await runBackup(deps, 'scheduled', { lockWaitMs: SCHEDULED_BACKUP_LOCK_WAIT, prunePause: () => prunePause(deps) });
  };
}

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

/**
 * The daemon's scheduled jobs. Each is its own croner job with `protect`, so a job never overlaps itself (a run still going
 * when the next is due makes that next one skip) and one job waiting or running long never delays another: the monitor
 * keeps ticking while a backup waits up to an hour for the ops lock.
 */
export function daemonJobs(deps: OpsDeps, channel: AlertChannel = logChannel(deps.log), monitor?: Monitor): Job[] {
  const jobs: Job[] = [
    // Waits up to an hour for a restore test or restore to finish rather than skipping the night's backup.
    { name: 'backup', cron: deps.cfg.backup.schedule, run: scheduledBackupJob(deps, channel) },
    { name: 'restore-test', cron: deps.cfg.backup.restoreTestSchedule, run: restoreTestJob(deps, channel, deps.cfg.client) },
    { name: 'audit-purge', cron: AUDIT_PURGE_SCHEDULE, run: async () => { await purgeAuditLog(deps); } },
  ];
  if (monitor !== undefined) jobs.push({ name: 'monitor', cron: MONITOR_SCHEDULE, run: () => monitor.tick() });
  return jobs;
}

/**
 * What the daemon does when a scheduled job fails: log it (unless it was already logged and recorded) and, with a monitor,
 * alert at once with no two-strike rule. The message is plain English with secrets removed.
 */
export function onJobFailure(deps: OpsDeps, monitor?: Monitor): (name: string, err: Error) => Promise<void> {
  return async (name, err) => {
    if (err instanceof AppJobError) {
      // An app job: its label, and the failure's first line with secrets removed (already cleaned when it was recorded).
      const line = scrub(deps, err.message);
      deps.log(`The scheduled job "${err.label}" did not work: ${line}`);
      if (monitor !== undefined) await monitor.jobFailed(`job "${err.label}"`, line);
      return;
    }
    const reported = (err as { reported?: unknown }).reported === true;
    if (!reported) deps.log(`The scheduled ${name} did not work: ${scrub(deps, err.message)}`);
    if (monitor === undefined) return;
    const plain = reported || err instanceof BackupError
      ? scrub(deps, err.message)
      : `It stopped because of an unexpected problem: ${firstLine(scrub(deps, err.message))}.`;
    await monitor.jobFailed(JOB_LABEL[name] ?? name, plain);
  };
}

/** The alert channel and monitor the daemon runs with: every alert, check detail and heartbeat message has secrets removed. */
export function buildMonitor(deps: OpsDeps): { channel: AlertChannel; monitor: Monitor } {
  const { cfg } = deps;
  const secrets = alertSecrets(cfg);
  const channel = redactingChannel(channelFromConfig(cfg, deps.log), secrets);
  const monitor = new Monitor({
    checks: async () => (await monitorChecks({ ...deps, opsLockHeld: () => opsLockHeld(deps) })).map((c) => ({ ...c, detail: redactAlert(c.detail, secrets) })),
    channel,
    client: cfg.client,
    ...(cfg.heartbeatUrl !== undefined ? { heartbeatUrl: cfg.heartbeatUrl } : {}),
    log: deps.log,
  });
  return { channel, monitor };
}

const LEFTOVER_FOLDER = /^(verify|restore|restore-uploads)-/;

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
      // A temp file of an update record whose write was cut short (Task 20).
      const stateDir = path.dirname(deps.cfg.workDir);
      let stateEntries: string[] = [];
      try { stateEntries = await readdir(stateDir); } catch { /* no state folder yet */ }
      for (const name of stateEntries) {
        if (!/^\.update-in-progress\.json\.tmp-/.test(name)) continue;
        const full = path.join(stateDir, name);
        const age = (await stat(full).catch(() => null))?.mtime.getTime() ?? Infinity;
        if (age < cutoff) {
          await rm(full, { force: true });
          removed.push(`file ${name}`);
        }
      }
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
        // Only this deployment's own scratch databases: another deployment on the same server may be mid restore test.
        const prefix = scratchPrefix(appDb);
        const scratchDb = new RegExp(`^${prefix}(\\d{14})_[0-9a-f]+$`);
        const dbs = (await c.query<{ datname: string }>(`select datname from pg_database where starts_with(datname, $3) or datname = any($1) or datname = $2`, [copies, appDb, prefix])).rows.map((r) => r.datname);
        for (const datname of dbs) {
          const m = scratchDb.exec(datname);
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

export interface DaemonOptions {
  /** Replaces croner (tests fire the timers by hand). */
  schedule?: ScheduleFn;
  /** Replaces the app's registered jobs (tests). */
  appJobs?: AppJob[];
  /** Replaces the alert channel and monitor built from the settings (tests). */
  alerting?: { channel: AlertChannel; monitor: Monitor };
  appJobTimeLimitMs?: number;
}

/**
 * Starts the daemon's work: tidies leftovers, starts every scheduled job (backups, restore tests, the audit-log tidy-up,
 * the monitor and the app's jobs), and only then begins the app jobs' start-up work (reporting runs cut short and catching
 * up), without waiting for it: a hung app job must never stop backups or the monitor. `startUp` settles when that is done.
 */
export async function startDaemon(deps: OpsDeps, opts: DaemonOptions = {}): Promise<{ stop: () => void; startUp: Promise<void> }> {
  const { cfg } = deps;
  const { channel, monitor } = opts.alerting ?? buildMonitor(deps);
  const where = [cfg.alerts.matrix ? 'Matrix' : '', cfg.alerts.webhookUrl !== undefined ? 'the alert webhook' : ''].filter(Boolean).join(' and ') || 'the ops log only';
  deps.log(`Health checks run every minute; alerts go to ${where}${cfg.heartbeatUrl !== undefined ? ', with a heartbeat to the outside watcher' : ''}.`);
  await sweepLeftovers(deps);
  const onFailure = onJobFailure(deps, monitor);
  const app = scheduleAppJobs(deps, opts.appJobs ?? appJobs(), onFailure, opts.appJobTimeLimitMs !== undefined ? { timeLimitMs: opts.appJobTimeLimitMs } : {});
  const scheduler = startScheduler([...daemonJobs(deps, channel, monitor), ...app.jobs], onFailure, opts.schedule);
  const startUp = app.startUp().catch((e: unknown) => {
    deps.log(`The app's scheduled jobs could not be checked at start: ${firstLine(scrub(deps, e instanceof Error ? e.message : String(e)))}.`);
  });
  return { stop: () => { scheduler.stop(); }, startUp };
}

/** `ops daemon`: the long-running scheduler. Resolves when asked to stop (SIGTERM from `docker compose stop`, or SIGINT). */
export async function runDaemon(deps: OpsDeps, close: () => Promise<void>): Promise<void> {
  const { cfg } = deps;
  // Listening for the stop signal before anything else starts, so a stop during start-up is never missed.
  const stopped = new Promise<void>((resolve) => {
    const stop = (): void => { resolve(); };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
  deps.log(`Ops is running for ${cfg.client}. Backups: "${cfg.backup.schedule}"; restore tests: "${cfg.backup.restoreTestSchedule}"; audit-log tidy-up: "${AUDIT_PURGE_SCHEDULE}" (UK time).`);
  if (cfg.backup.allowLocal) deps.log(`BACKUP_ALLOW_LOCAL is true. ${LOCAL_WARNING}`);
  for (const w of cfg.warnings) deps.log(`Warning: ${w}`);
  const left = await readRecord(path.join(path.dirname(cfg.workDir), UPDATE_RECORD)).catch(() => null);
  if (left !== null && (await recordIsLeftover(left, path.dirname(cfg.workDir), deps.now(), () => opsLockHeld(deps)))) {
    deps.log(`Warning: an update from ${left.from} to ${left.to} stopped part-way (step: ${left.step}). Backups are paused and the health check raises a critical alert until it is sorted out.`);
  }
  const daemon = await startDaemon(deps);
  await stopped;
  daemon.stop();
  deps.log('Ops is stopping.');
  await close().catch(() => undefined);
}
