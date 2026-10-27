import { randomBytes } from 'node:crypto';
import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { describeRepo, slug } from './config.js';
import { BackupError, firstLine, LATEST_TAGS, resticEnv, resticProblem, runBackup, TIMEOUTS, workFiles } from './backup.js';
import { confirmOpsLock, lockKey, OpsBusyError, withOpsLock } from './opsLock.js';
import { checkRestoredFiles, compareManifest, countTables, type Manifest } from './manifest.js';
import { connect, DB_IDENT, pgEnv } from './pg.js';
import { recordRun, scrub, type OpsDeps } from './runs.js';
import { ukDate } from './time.js';

export class RestoreError extends Error {
  /** `reported`: the message has already been logged and recorded, so the CLI need not print it again. */
  constructor(message: string, public readonly reported = false) {
    super(message);
    this.name = 'RestoreError';
  }
}

/** The uid/gid of `node` in the app image, which must be able to keep writing to the uploads folder after a restore. */
const APP_UID_GID = '1000:1000';

/** Tables every foundation database has. A backup record without them cannot prove that a restore works. */
const CORE_TABLES = ['users', 'files'];

/** How long a restore or restore test waits for a running backup to finish before giving up. */
export const LOCK_WAIT = { restore: 2 * 60e3, restoreTest: 10 * 60e3 } as const;

const STOP_BOTH = 'Stop both the app and ops first (docker compose stop app ops), then run the restore on its own: docker compose run --rm ops restore <backup id | latest> --yes-replace-live-data';

/**
 * The start of every restore-test scratch database name of this deployment: `hf_rt_<lock key in hex>_`. Each deployment
 * (and each parallel test database) on a shared Postgres has its own, so the leftover sweep at start only ever removes its
 * own scratch databases, never another deployment's restore test in progress. A full name is at most 36 characters.
 */
export const scratchPrefix = (appDb: string): string => `hf_rt_${(lockKey(appDb) >>> 0).toString(16).padStart(8, '0')}_`;

export const stamp = (d: Date): string => `${d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`;


export interface SnapshotInfo { id: string; short: string; time: Date }

/** restic prints nanoseconds and an offset; keep milliseconds so every JavaScript engine reads it. */
const parseTime = (t: string): Date => new Date(t.replace(/(\.\d{3})\d+/, '$1'));

/** The newest backup of this deployment, or null when there is none. Throws RestoreError when the destination cannot be read. */
export async function latestSnapshot(deps: OpsDeps): Promise<SnapshotInfo | null> {
  // Only this box's backups (another deployment sharing the destination is never restored here by mistake), and never a
  // safety backup: after a restore, "latest" must still mean the newest real backup, and a safety backup must not hide a
  // missing daily one from the restore test. A safety backup is restored only by naming its id.
  const r = await deps.run.run('restic', ['snapshots', '--json', ...LATEST_TAGS, '--group-by', 'host', '--host', slug(deps.cfg.client), '--latest', '1'], { env: resticEnv(deps.cfg), timeoutMs: TIMEOUTS.resticQuick });
  if (r.code !== 0) throw new RestoreError(resticProblem(deps, r, TIMEOUTS.resticQuick, 'The list of backups could not be read'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout.trim() === '' ? 'null' : r.stdout);
  } catch {
    throw new RestoreError('The list of backups could not be read: restic gave an answer ops does not understand.');
  }
  // With --group-by, restic answers a list of groups, each with its own snapshots.
  const all: { id?: unknown; short_id?: unknown; time?: unknown }[] = [];
  for (const item of Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : []) {
    if (Array.isArray(item['snapshots'])) all.push(...(item['snapshots'] as typeof all));
    else all.push(item);
  }
  let best: SnapshotInfo | null = null;
  for (const s of all) {
    if (typeof s.id !== 'string' || typeof s.time !== 'string') continue;
    const time = parseTime(s.time);
    if (best === null || time > best.time) best = { id: s.id, short: typeof s.short_id === 'string' ? s.short_id : s.id.slice(0, 8), time };
  }
  return best;
}

/**
 * Looks up one backup by its id (or the start of it) and checks it was made by this box: a backup id typed by hand could be
 * another deployment's on a shared destination. Throws RestoreError, before anything is changed, when the backup is not
 * there or (unless `anyHost`) belongs to another box.
 */
export async function snapshotById(deps: OpsDeps, id: string, opts: { anyHost?: boolean } = {}): Promise<SnapshotInfo & { host: string }> {
  const r = await deps.run.run('restic', ['snapshots', '--json', id], { env: resticEnv(deps.cfg), timeoutMs: TIMEOUTS.resticQuick });
  if (r.code !== 0) throw new RestoreError(resticProblem(deps, r, TIMEOUTS.resticQuick, `Backup ${id.slice(0, 8)} could not be looked up`));
  let found: { id?: unknown; short_id?: unknown; time?: unknown; hostname?: unknown } | undefined;
  try {
    const parsed = JSON.parse(r.stdout.trim() === '' ? '[]' : r.stdout) as unknown;
    found = Array.isArray(parsed) ? (parsed as (typeof found)[]).find((x) => typeof x?.id === 'string' && x.id.startsWith(id)) : undefined;
  } catch {
    throw new RestoreError('The list of backups could not be read: restic gave an answer ops does not understand.');
  }
  if (found === undefined || typeof found.id !== 'string') {
    throw new RestoreError(`There is no backup ${id.slice(0, 8)} at ${describeRepo(deps.cfg.backup.repository)}, so nothing has been changed. Check the id (the list of backups is in the runbook, "Backups and restoring").`);
  }
  const host = typeof found.hostname === 'string' ? found.hostname : '';
  const mine = slug(deps.cfg.client);
  if (host !== mine && opts.anyHost !== true) {
    throw new RestoreError(`Backup ${found.id.slice(0, 8)} was made by another box ("${host || 'unknown'}"), not this one ("${mine}"), so nothing has been changed. To put another box's backup on this one on purpose, run the restore again with --any-host.`);
  }
  const short = typeof found.short_id === 'string' ? found.short_id : found.id.slice(0, 8);
  return { id: found.id, short, host, time: typeof found.time === 'string' ? parseTime(found.time) : new Date(Number.NaN) };
}

/** Whether a file or folder exists, or (given a maintenance connection) whether a database of that name exists. */
async function exists(p: string, c?: pg.Client): Promise<boolean> {
  if (c !== undefined) return (await c.query('select 1 from pg_database where datname = $1', [p])).rowCount === 1;
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Runs `fn` on a connection to the maintenance database (same sign-in, PGDATABASE=postgres). */
async function withMaintenance<T>(deps: OpsDeps, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = await connect(deps.cfg.databaseUrl, 'postgres');
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}

/**
 * The scheduled restore test: restores the newest backup into a scratch database and folder and checks them against the
 * backup's manifest. Always cleans up, and always records the outcome (a failure is recorded so the monitor can alert on it).
 */
export async function verifyLatestRestore(deps: OpsDeps): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  let snap: SnapshotInfo | null = null;
  let busy = false;
  try {
    snap = await withOpsLock(
      deps,
      { waitMs: LOCK_WAIT.restoreTest, busyMessage: 'Another backup or restore was still running after 10 minutes, so the restore test could not start.' },
      () => verifyLocked(deps, problems),
    );
  } catch (e) {
    busy = e instanceof OpsBusyError && !e.unreachable;
    problems.push(e instanceof RestoreError || e instanceof OpsBusyError ? e.message : `The restore test could not finish: ${firstLine(scrub(deps, e instanceof Error ? e.message : String(e)))}.`);
  }
  const ok = problems.length === 0;
  await recordRun(deps, 'restore-test', ok,
    ok && snap !== null ? `Restore test passed: backup ${snap.short} from ${ukDate(snap.time)} restored completely.` : problems.join(' '),
    snap?.id, { busy });
  return { ok, problems };
}

/** The restore test proper, under the ops lock. Adds what it finds to `problems`; throws RestoreError when it cannot go on. */
async function verifyLocked(deps: OpsDeps, problems: string[]): Promise<SnapshotInfo | null> {
  const { cfg } = deps;
  const ts = stamp(deps.now());
  const target = path.join(cfg.workDir, `verify-${ts}`);
  const scratch = `${scratchPrefix(pgEnv(cfg.databaseUrl).PGDATABASE)}${ts}`;
  let created = false;
  const snap = await latestSnapshot(deps);
  if (snap === null) {
    problems.push('There are no backups yet.');
    return null;
  }
  try {
    const hours = Math.floor((deps.now().getTime() - snap.time.getTime()) / 3600e3);
    if (hours > 26) problems.push(`The newest backup is ${String(hours)} hours old (expected one every day).`);

    const r = await deps.run.run('restic', ['restore', snap.id, '--target', target], { env: resticEnv(cfg), timeoutMs: TIMEOUTS.resticRestore });
    if (r.code !== 0) throw new RestoreError(resticProblem(deps, r, TIMEOUTS.resticRestore, `Backup ${snap.short} could not be restored`));
    // restic keeps absolute paths under the target.
    const restored = workFiles(path.join(target, cfg.workDir));
    let expected: Manifest;
    try {
      expected = JSON.parse(await readFile(restored.manifest, 'utf8')) as Manifest;
      if (typeof expected.tables !== 'object' || typeof expected.files !== 'object') throw new Error('bad');
    } catch {
      throw new RestoreError(`Backup ${snap.short} has no readable backup record (manifest.json), so it cannot be checked.`);
    }
    // An empty or partial record would let an empty restore "pass".
    const listed = Object.keys(expected.tables);
    if (listed.length === 0 || CORE_TABLES.some((t) => !listed.includes(t))) {
      throw new RestoreError(`The record of backup ${snap.short} lists no tables, or not the ${CORE_TABLES.join(' and ')} tables, so it cannot prove that a restore works.`);
    }
    if (!(await exists(restored.dump))) throw new RestoreError(`Backup ${snap.short} does not contain the database.`);

    try {
      await withMaintenance(deps, (c) => c.query(`CREATE DATABASE "${scratch}"`));
      created = true;
    } catch {
      throw new RestoreError('A scratch database for the restore test could not be made. Check that the database user may create databases.');
    }
    const pr = await deps.run.run('pg_restore', ['--no-owner', '--exit-on-error', `--dbname=${scratch}`, restored.dump], { env: pgEnv(cfg.databaseUrl), timeoutMs: TIMEOUTS.pgRestore });
    if (pr.code !== 0) {
      throw new RestoreError(pr.timedOut === true
        ? `The database in backup ${snap.short} did not finish restoring within ${String(TIMEOUTS.pgRestore / 3600e3)} hours.`
        : `The database in backup ${snap.short} could not be restored (pg_restore stopped with code ${String(pr.code)}).`);
    }
    const c = await connect(cfg.databaseUrl, scratch);
    try {
      const tables = await countTables(c);
      const files = await checkRestoredFiles(c, path.join(target, cfg.uploadsDir));
      problems.push(...compareManifest(expected, { tables, files: { count: files.count, bytes: files.bytes } }), ...files.problems);
    } finally {
      await c.end().catch(() => undefined);
    }
  } catch (e) {
    // Keep the snapshot in the record even when the test could not finish.
    problems.push(e instanceof RestoreError ? e.message : `The restore test could not finish: ${firstLine(scrub(deps, e instanceof Error ? e.message : String(e)))}.`);
  } finally {
    if (created) {
      await withMaintenance(deps, (c) => c.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`))
        .catch(() => { deps.log(`The scratch database ${scratch} could not be removed. Ops removes it at its next start.`); });
    }
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
  return snap;
}

type SavedRun = { kind: string; ok: boolean; detail: string; snapshot_id: string | null; busy: boolean; at: string } & Record<string, unknown>;

/** Test seam only: make one step of the database swap fail, to prove what each failure leaves behind. */
export type SwapFault = 'aside' | 'into-place' | 'into-place-and-back' | 'drop-old';

/**
 * Puts the database from a backup into `targetDb` (used by `ops restore` and by an update's rollback). The backup is first
 * restored into `<targetDb>_incoming`. Only when that has fully worked is the live database renamed aside to `<targetDb>_old`,
 * the new one renamed into place, and the old one dropped, so there is never a moment without a complete database under a
 * known name. Nothing a failed migration created survives, and a restore that fails leaves the live database as it was.
 * Runs under the ops lock, re-checked before any rename or drop. When `targetDb` is ops' own database, the ops log entries
 * newer than the backup are kept.
 */
export async function restoreDatabase(deps: OpsDeps, snapshotId: string, targetDb: string, opts: { lockWaitMs?: number; fault?: SwapFault } = {}): Promise<void> {
  const names = { target: targetDb, incoming: `${targetDb}_incoming`, old: `${targetDb}_old` };
  if (!DB_IDENT.test(targetDb) || !DB_IDENT.test(names.incoming)) throw new RestoreError('That is not a database name ops can restore into (use lower-case letters, numbers and _ only, at most 54 characters).');
  if (!/^[0-9a-f]{8,64}$/.test(snapshotId)) throw new RestoreError('That is not a backup id (8 to 64 letters a-f and numbers).');
  try {
    await withOpsLock(deps, { waitMs: opts.lockWaitMs ?? LOCK_WAIT.restore, busyMessage: `Another backup or restore is running, so the database was not restored. ${STOP_BOTH}` }, () => restoreDatabaseLocked(deps, snapshotId, names, opts.fault));
  } catch (e) {
    if (e instanceof OpsBusyError) throw new RestoreError(e.message);
    throw e;
  }
}

/** Renames a database once nobody is connected to it; new connections are refused first, then existing ones ended. */
async function renameClosed(c: pg.Client, from: string, to: string): Promise<void> {
  await c.query(`ALTER DATABASE "${from}" WITH ALLOW_CONNECTIONS false`);
  try {
    for (let attempt = 0; ; attempt++) {
      await c.query('select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()', [from]);
      try {
        await c.query(`ALTER DATABASE "${from}" RENAME TO "${to}"`);
        return;
      } catch (e) {
        if (attempt >= 20) throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } catch (e) {
    await c.query(`ALTER DATABASE "${from}" WITH ALLOW_CONNECTIONS true`).catch(() => undefined);
    throw e;
  }
}

async function restoreDatabaseLocked(deps: OpsDeps, snapshotId: string, n: { target: string; incoming: string; old: string }, fault: SwapFault | undefined): Promise<void> {
  const { cfg } = deps;
  const folder = path.join(cfg.workDir, `restore-${stamp(deps.now())}`);
  const dumpPath = workFiles(cfg.workDir).dump;
  const dump = path.join(folder, dumpPath);
  const inject = (step: SwapFault): void => { if (fault === step || (step === 'into-place' && fault === 'into-place-and-back')) throw new Error(`injected ${step}`); };
  let incomingMade = false;
  try {
    const r = await deps.run.run('restic', ['restore', snapshotId, '--target', folder, '--include', dumpPath], { env: resticEnv(cfg), timeoutMs: TIMEOUTS.resticRestore });
    if (r.code !== 0) throw new RestoreError(resticProblem(deps, r, TIMEOUTS.resticRestore, `Backup ${snapshotId.slice(0, 8)} could not be fetched`));
    // Prove the dump is there and readable before anything else.
    const list = await deps.run.run('pg_restore', ['--list', dump], { env: pgEnv(cfg.databaseUrl), timeoutMs: TIMEOUTS.pgRestore });
    if (list.code !== 0) throw new RestoreError(`Backup ${snapshotId.slice(0, 8)} does not hold a readable database, so nothing has been changed.`);

    try {
      await withMaintenance(deps, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${n.incoming}" WITH (FORCE)`);
        await c.query(`CREATE DATABASE "${n.incoming}"`);
      });
      incomingMade = true;
    } catch {
      throw new RestoreError("A database to restore into could not be made, so nothing has been changed. Check that the database is running and that ops' database user may create databases.");
    }
    const pr = await deps.run.run('pg_restore', ['--no-owner', '--exit-on-error', '--single-transaction', `--dbname=${n.incoming}`, dump], { env: pgEnv(cfg.databaseUrl), timeoutMs: TIMEOUTS.pgRestore });
    if (pr.code !== 0) throw new RestoreError(`The saved database could not be put back. The live database ${n.target} has not been changed.`);

    const own = pgEnv(cfg.databaseUrl).PGDATABASE === n.target;
    const saved: SavedRun[] = own
      ? await deps.db.execute<SavedRun>(sql`select kind, ok, detail, snapshot_id, busy, at::text as at from ops_runs order by id`).then((x) => x.rows, () => [])
      : [];

    // From here on databases are renamed and dropped: only while this run still holds the lock.
    if (!(await confirmOpsLock())) {
      incomingMade = false;   // keep it: nothing is dropped without the lock
      throw new RestoreError(`The restore stopped before changing anything because ops lost its lock (its database connection dropped). ${n.target} is unchanged; the restored copy is in ${n.incoming}. Run the restore again.`);
    }
    await withMaintenance(deps, async (c) => {
      const hadTarget = await exists(n.target, c);
      if (hadTarget) {
        // A leftover _old next to a live database is stale: the live database is complete.
        await c.query(`DROP DATABASE IF EXISTS "${n.old}" WITH (FORCE)`);
        try {
          inject('aside');
          await renameClosed(c, n.target, n.old);
        } catch {
          throw new RestoreError(`The live database could not be moved aside, so it has not been changed: ${n.target} still holds the data from before the restore. The restored copy has been removed. Check that nothing else is connected to ${n.target}, then run the restore again.`);
        }
      }
      try {
        inject('into-place');
        await c.query(`ALTER DATABASE "${n.incoming}" RENAME TO "${n.target}"`);
        incomingMade = false;
      } catch {
        incomingMade = false;   // the restored copy is kept, and named in the message
        if (!hadTarget) throw new RestoreError(`The restored database could not be put in place. It is kept as ${n.incoming}; rename it to ${n.target} by hand.`);
        try {
          if (fault === 'into-place-and-back') throw new Error('injected back');
          await c.query(`ALTER DATABASE "${n.old}" RENAME TO "${n.target}"`);
          await c.query(`ALTER DATABASE "${n.target}" WITH ALLOW_CONNECTIONS true`);
        } catch {
          throw new RestoreError(`The restored database could not be put in place, and the old one could not be put back. ${n.old} holds the data from before the restore and ${n.incoming} holds the restored copy; rename one of them to ${n.target} by hand.`);
        }
        throw new RestoreError(`The restored database could not be put in place, so the live database was put back as it was: ${n.target} holds the data from before the restore. The restored copy is kept as ${n.incoming}.`);
      }
      if (hadTarget) {
        try {
          inject('drop-old');
          await c.query(`DROP DATABASE IF EXISTS "${n.old}" WITH (FORCE)`);
        } catch {
          deps.log(`The restore worked, but the copy of the database from before it (${n.old}) could not be removed. Remove it by hand when convenient.`);
        }
      }
    });

    if (own && saved.length > 0) {
      try {
        const max = (await deps.db.execute<{ m: string | null }>(sql`select max(at)::text as m from ops_runs`)).rows[0]?.m ?? null;
        for (const s of saved) {
          if (max !== null && new Date(s.at) <= new Date(max)) continue;
          await deps.db.execute(sql`insert into ops_runs (kind, ok, detail, snapshot_id, busy, at) values (${s.kind}, ${s.ok}, ${s.detail}, ${s.snapshot_id}, ${s.busy}, ${s.at}::timestamptz)`);
        }
      } catch {
        deps.log('The ops log entries since that backup could not be copied back. Nothing else is affected.');
      }
    }
  } catch (e) {
    // A restored copy that was never meant to survive is removed; one named in a message is kept.
    if (incomingMade) await withMaintenance(deps, (c) => c.query(`DROP DATABASE IF EXISTS "${n.incoming}" WITH (FORCE)`)).catch(() => undefined);
    throw e;
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Whether the app answers: only a refused connection or an unknown host count as stopped. A timeout is not proof. */
export async function appState(url: string, timeoutMs: number): Promise<'stopped' | 'running' | 'unclear'> {
  try {
    await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(timeoutMs) });
    return 'running';
  } catch (e) {
    const c = (e as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | null)?.cause;
    const codes = [c?.code, ...(c?.errors ?? []).map((x) => x.code)];
    return codes.some((x) => x === 'ECONNREFUSED' || x === 'ENOTFOUND' || x === 'EAI_AGAIN') ? 'stopped' : 'unclear';
  }
}

/**
 * `ops restore`: puts a backup back over the live data. Refuses while the app answers; takes a safety backup first;
 * then restores the database and replaces the uploads folder, which ends up owned by the app's user. Records the outcome.
 */
export interface RestoreLiveOptions {
  lockWaitMs?: number;
  appCheckTimeoutMs?: number;
  /** Test seam: how the app's state is found (default: ask its /healthz). */
  appState?: () => Promise<'stopped' | 'running' | 'unclear'>;
  /** `--any-host`: allow a backup id made by another box (normally refused). */
  anyHost?: boolean;
}

export async function restoreLive(deps: OpsDeps, which: string, opts: RestoreLiveOptions = {}): Promise<{ snapshotId: string }> {
  const { cfg } = deps;
  const check = opts.appState ?? (() => appState(cfg.appInternalUrl, opts.appCheckTimeoutMs ?? 3000));
  const refuseIfRunning = async (): Promise<void> => {
    const app = await check();
    if (app === 'running') throw new RestoreError(`The app is still running, so nothing has been changed. ${STOP_BOTH}`);
    if (app === 'unclear') throw new RestoreError(`The app may still be running (it did not answer clearly), so nothing has been changed. ${STOP_BOTH}`);
  };
  await refuseIfRunning();
  try {
    return await withOpsLock(deps, { waitMs: opts.lockWaitMs ?? LOCK_WAIT.restore, busyMessage: `Another backup or restore is running, so nothing has been changed. ${STOP_BOTH}` }, async () => {
      // Again after the wait for the lock: the app may have been started meanwhile.
      await refuseIfRunning();
      return restoreLiveLocked(deps, which, opts.anyHost === true);
    });
  } catch (e) {
    if (e instanceof OpsBusyError) throw new RestoreError(e.message);
    throw e;
  }
}

/** The whole restore, safety backup included, under one hold of the ops lock. */
async function restoreLiveLocked(deps: OpsDeps, which: string, anyHost: boolean): Promise<{ snapshotId: string }> {
  let snap: { id: string; short: string; time?: Date };
  try {
    // Chosen before the safety backup, or "latest" would mean the safety backup itself.
    if (which === 'latest') {
      const s = await latestSnapshot(deps);
      if (s === null) throw new RestoreError('There are no backups to restore.');
      snap = s;
    } else {
      if (!/^[0-9a-f]{8,64}$/.test(which)) throw new RestoreError('Give a backup id (8 to 64 letters a-f and numbers) or latest.');
      const s = await snapshotById(deps, which, { anyHost });
      if (s.host !== slug(deps.cfg.client)) deps.log(`Backup ${s.short} was made by another box ("${s.host}"); restoring it here because --any-host was given.`);
      snap = Number.isNaN(s.time.getTime()) ? { id: s.id, short: s.short } : s;
    }
  } catch (e) {
    const msg = e instanceof RestoreError ? e.message : 'The backups could not be listed.';
    await recordRun(deps, 'restore', false, msg);
    throw new RestoreError(msg, true);
  }

  deps.log('Taking a safety backup of the current data first.');
  let safety: string;
  try {
    safety = (await runBackup(deps, 'manual', { safety: true })).snapshotId.slice(0, 8);
  } catch (e) {
    const msg = `The safety backup failed, so nothing has been changed. ${e instanceof BackupError ? e.message : ''}`.trim();
    await recordRun(deps, 'restore', false, msg);
    throw new RestoreError(msg, true);
  }
  // After a failed restore, "latest" would be this safety backup, so its id is always spelled out.
  deps.log(`Safety backup ${safety} holds the data as it was before this restore.`);

  try {
    await restoreDataFrom(deps, snap);

    const when = snap.time !== undefined ? ` from ${ukDate(snap.time)}` : '';
    await recordRun(deps, 'restore', true, `Backup ${snap.short}${when} was put back: the database and the uploaded files. Safety backup ${safety} holds the data from before.`, snap.id);
    return { snapshotId: snap.id };
  } catch (e) {
    const why = e instanceof RestoreError ? e.message : `The restore failed: ${firstLine(scrub(deps, e instanceof Error ? e.message : String(e)))}.`;
    const msg = `${why} The data as it was before this restore is in safety backup ${safety}: restore that id (not latest) to go back.`;
    await recordRun(deps, 'restore', false, msg, snap.id);
    throw new RestoreError(msg, true);
  }
}

/**
 * Puts the database and the uploaded files from one backup back: used by `ops restore` (after its safety backup) and by an
 * update's automatic rollback (Task 20), always with the app stopped. The uploads are fetched first, so a backup that cannot
 * be read changes nothing; then the database is swapped in (restoreDatabase); then the uploads folder is replaced and given
 * back to the app's user. Runs under the ops lock (re-entrant: the caller normally holds it already). Throws RestoreError.
 */
export async function restoreDataFrom(deps: OpsDeps, snap: { id: string; short: string }, opts: { lockWaitMs?: number; onStep?: (done: 'database' | 'uploads') => void } = {}): Promise<void> {
  const { cfg } = deps;
  try {
    await withOpsLock(deps, { waitMs: opts.lockWaitMs ?? LOCK_WAIT.restore, busyMessage: `Another backup or restore is running, so nothing has been changed. ${STOP_BOTH}` }, async () => {
      const staging = path.join(cfg.workDir, `restore-uploads-${stamp(deps.now())}`);
      try {
        deps.log(`Fetching backup ${snap.short} from ${describeRepo(cfg.backup.repository)}.`);
        const r = await deps.run.run('restic', ['restore', snap.id, '--target', staging, '--include', cfg.uploadsDir], { env: resticEnv(cfg), timeoutMs: TIMEOUTS.resticRestore });
        if (r.code !== 0) throw new RestoreError(resticProblem(deps, r, TIMEOUTS.resticRestore, `Backup ${snap.short} could not be fetched`));
        const stagedUploads = path.join(staging, cfg.uploadsDir);
        if (!(await exists(stagedUploads))) throw new RestoreError(`Backup ${snap.short} does not contain the uploads folder, so nothing has been changed.`);

        deps.log('Putting the database back.');
        await restoreDatabase(deps, snap.id, pgEnv(cfg.databaseUrl).PGDATABASE);
        opts.onStep?.('database');

        if (!(await confirmOpsLock())) throw new RestoreError('The database was put back, but ops lost its lock before the uploaded files, so they have not been touched. Run the restore again.');
        deps.log('Putting the uploaded files back.');
        for (const entry of await readdir(cfg.uploadsDir)) await rm(path.join(cfg.uploadsDir, entry), { recursive: true, force: true });
        await cp(stagedUploads, cfg.uploadsDir, { recursive: true, preserveTimestamps: true });
        const own = await deps.run.run('chown', ['-R', APP_UID_GID, cfg.uploadsDir], { timeoutMs: TIMEOUTS.chown });
        opts.onStep?.('uploads');
        if (own.code !== 0) throw new RestoreError('The uploaded files were put back, but the app may not be able to save new ones: their owner could not be set.');
      } finally {
        await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  } catch (e) {
    if (e instanceof OpsBusyError) throw new RestoreError(e.message);
    throw e;
  }
}
