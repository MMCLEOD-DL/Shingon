import { randomBytes } from 'node:crypto';
import { cp, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { describeRepo, slug } from './config.js';
import { BackupError, firstLine, resticEnv, resticProblem, runBackup, TIMEOUTS, workFiles } from './backup.js';
import { OpsBusyError, withOpsLock } from './opsLock.js';
import { checkRestoredFiles, compareManifest, countTables, type Manifest } from './manifest.js';
import { connect, DB_IDENT, pgEnv } from './pg.js';
import { recordRun, scrub, type OpsDeps } from './runs.js';

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

export const stamp = (d: Date): string => `${d.toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}_${randomBytes(3).toString('hex')}`;

export const ukDate = (d: Date): string =>
  new Intl.DateTimeFormat('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Europe/London' }).format(d);

/** Each `--tag a,b` matches snapshots with both tags; several are alternatives. Everything but `safety`. */
export const LATEST_TAGS = ['--tag', 'hf,scheduled', '--tag', 'hf,manual', '--tag', 'hf,pre-update'];

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

async function exists(p: string): Promise<boolean> {
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
  try {
    snap = await withOpsLock(
      deps,
      { waitMs: LOCK_WAIT.restoreTest, busyMessage: 'Another backup or restore was still running after 10 minutes, so the restore test could not start.' },
      () => verifyLocked(deps, problems),
    );
  } catch (e) {
    problems.push(e instanceof RestoreError || e instanceof OpsBusyError ? e.message : `The restore test could not finish: ${firstLine(scrub(deps, e instanceof Error ? e.message : String(e)))}.`);
  }
  const ok = problems.length === 0;
  await recordRun(deps, 'restore-test', ok,
    ok && snap !== null ? `Restore test passed: backup ${snap.short} from ${ukDate(snap.time)} restored completely.` : problems.join(' '),
    snap?.id);
  return { ok, problems };
}

/** The restore test proper, under the ops lock. Adds what it finds to `problems`; throws RestoreError when it cannot go on. */
async function verifyLocked(deps: OpsDeps, problems: string[]): Promise<SnapshotInfo | null> {
  const { cfg } = deps;
  const ts = stamp(deps.now());
  const target = path.join(cfg.workDir, `verify-${ts}`);
  const scratch = `hf_restore_test_${ts}`;
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

type SavedRun = { kind: string; ok: boolean; detail: string; snapshot_id: string | null; at: string } & Record<string, unknown>;

/**
 * Puts the database from a backup into `targetDb` (used by `ops restore` and by an update's rollback). The backup is first
 * restored into a new `<targetDb>_incoming` database; only when that has fully worked is the old database dropped and the
 * new one renamed into its place. So nothing a failed migration created survives, and a restore that fails leaves the live
 * database exactly as it was. Runs under the ops lock. When `targetDb` is ops' own database, the ops log entries newer than
 * the backup are kept.
 */
export async function restoreDatabase(deps: OpsDeps, snapshotId: string, targetDb: string, opts: { lockWaitMs?: number } = {}): Promise<void> {
  const incoming = `${targetDb}_incoming`;
  if (!DB_IDENT.test(targetDb) || !DB_IDENT.test(incoming)) throw new RestoreError('That is not a database name ops can restore into (use lower-case letters, numbers and _ only, at most 54 characters).');
  if (!/^[0-9a-f]{8,64}$/.test(snapshotId)) throw new RestoreError('That is not a backup id (8 to 64 letters a-f and numbers).');
  try {
    await withOpsLock(deps, { waitMs: opts.lockWaitMs ?? LOCK_WAIT.restore, busyMessage: `Another backup or restore is running, so the database was not restored. ${STOP_BOTH}` }, () => restoreDatabaseLocked(deps, snapshotId, targetDb, incoming));
  } catch (e) {
    if (e instanceof OpsBusyError) throw new RestoreError(e.message);
    throw e;
  }
}

async function restoreDatabaseLocked(deps: OpsDeps, snapshotId: string, targetDb: string, incoming: string): Promise<void> {
  const { cfg } = deps;
  const target = path.join(cfg.workDir, `restore-${stamp(deps.now())}`);
  const dumpPath = workFiles(cfg.workDir).dump;
  const dump = path.join(target, dumpPath);
  let incomingMade = false;
  try {
    const r = await deps.run.run('restic', ['restore', snapshotId, '--target', target, '--include', dumpPath], { env: resticEnv(cfg), timeoutMs: TIMEOUTS.resticRestore });
    if (r.code !== 0) throw new RestoreError(resticProblem(deps, r, TIMEOUTS.resticRestore, `Backup ${snapshotId.slice(0, 8)} could not be fetched`));
    // Prove the dump is there and readable before anything else.
    const list = await deps.run.run('pg_restore', ['--list', dump], { env: pgEnv(cfg.databaseUrl), timeoutMs: TIMEOUTS.pgRestore });
    if (list.code !== 0) throw new RestoreError(`Backup ${snapshotId.slice(0, 8)} does not hold a readable database, so nothing has been changed.`);

    try {
      await withMaintenance(deps, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${incoming}" WITH (FORCE)`);
        await c.query(`CREATE DATABASE "${incoming}"`);
      });
      incomingMade = true;
    } catch {
      throw new RestoreError("A database to restore into could not be made, so nothing has been changed. Check that the database is running and that ops' database user may create databases.");
    }
    const pr = await deps.run.run('pg_restore', ['--no-owner', '--exit-on-error', '--single-transaction', `--dbname=${incoming}`, dump], { env: pgEnv(cfg.databaseUrl), timeoutMs: TIMEOUTS.pgRestore });
    if (pr.code !== 0) throw new RestoreError('The saved database could not be put back. The live database has not been changed.');

    const own = pgEnv(cfg.databaseUrl).PGDATABASE === targetDb;
    const saved: SavedRun[] = own
      ? await deps.db.execute<SavedRun>(sql`select kind, ok, detail, snapshot_id, at::text as at from ops_runs order by id`).then((x) => x.rows, () => [])
      : [];

    // The swap: DROP … WITH (FORCE) ends every session on the old database (the app is stopped), then the new one takes its name.
    try {
      await withMaintenance(deps, async (c) => {
        await c.query(`DROP DATABASE IF EXISTS "${targetDb}" WITH (FORCE)`);
        await c.query(`ALTER DATABASE "${incoming}" RENAME TO "${targetDb}"`);
      });
      incomingMade = false;
    } catch {
      throw new RestoreError(`The restored database could not be swapped into place. It is kept as ${incoming}; check the database and rename it to ${targetDb} by hand.`);
    }

    if (own && saved.length > 0) {
      try {
        const max = (await deps.db.execute<{ m: string | null }>(sql`select max(at)::text as m from ops_runs`)).rows[0]?.m ?? null;
        for (const s of saved) {
          if (max !== null && new Date(s.at) <= new Date(max)) continue;
          await deps.db.execute(sql`insert into ops_runs (kind, ok, detail, snapshot_id, at) values (${s.kind}, ${s.ok}, ${s.detail}, ${s.snapshot_id}, ${s.at}::timestamptz)`);
        }
      } catch {
        deps.log('The ops log entries since that backup could not be copied back. Nothing else is affected.');
      }
    }
  } catch (e) {
    // A failed restore never leaves a half-made database behind (unless the swap itself failed: then it is the only copy).
    if (incomingMade && !(e instanceof RestoreError && e.message.startsWith('The restored database could not be swapped'))) {
      await withMaintenance(deps, (c) => c.query(`DROP DATABASE IF EXISTS "${incoming}" WITH (FORCE)`)).catch(() => undefined);
    }
    throw e;
  } finally {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
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
export async function restoreLive(deps: OpsDeps, which: string, opts: { lockWaitMs?: number; appCheckTimeoutMs?: number } = {}): Promise<{ snapshotId: string }> {
  const { cfg } = deps;
  const app = await appState(cfg.appInternalUrl, opts.appCheckTimeoutMs ?? 3000);
  if (app === 'running') throw new RestoreError(`The app is still running, so nothing has been changed. ${STOP_BOTH}`);
  if (app === 'unclear') throw new RestoreError(`The app may still be running (it did not answer clearly), so nothing has been changed. ${STOP_BOTH}`);
  try {
    return await withOpsLock(deps, { waitMs: opts.lockWaitMs ?? LOCK_WAIT.restore, busyMessage: `Another backup or restore is running, so nothing has been changed. ${STOP_BOTH}` }, () => restoreLiveLocked(deps, which));
  } catch (e) {
    if (e instanceof OpsBusyError) throw new RestoreError(e.message);
    throw e;
  }
}

/** The whole restore, safety backup included, under one hold of the ops lock. */
async function restoreLiveLocked(deps: OpsDeps, which: string): Promise<{ snapshotId: string }> {
  const { cfg } = deps;
  let snap: { id: string; short: string; time?: Date };
  try {
    // Chosen before the safety backup, or "latest" would mean the safety backup itself.
    if (which === 'latest') {
      const s = await latestSnapshot(deps);
      if (s === null) throw new RestoreError('There are no backups to restore.');
      snap = s;
    } else {
      if (!/^[0-9a-f]{8,64}$/.test(which)) throw new RestoreError('Give a backup id (8 to 64 letters a-f and numbers) or latest.');
      snap = { id: which, short: which.slice(0, 8) };
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

  const staging = path.join(cfg.workDir, `restore-uploads-${stamp(deps.now())}`);
  try {
    deps.log(`Fetching backup ${snap.short} from ${describeRepo(cfg.backup.repository)}.`);
    const r = await deps.run.run('restic', ['restore', snap.id, '--target', staging, '--include', cfg.uploadsDir], { env: resticEnv(cfg), timeoutMs: TIMEOUTS.resticRestore });
    if (r.code !== 0) throw new RestoreError(resticProblem(deps, r, TIMEOUTS.resticRestore, `Backup ${snap.short} could not be fetched`));
    const stagedUploads = path.join(staging, cfg.uploadsDir);
    if (!(await exists(stagedUploads))) throw new RestoreError(`Backup ${snap.short} does not contain the uploads folder, so nothing has been changed.`);

    deps.log('Putting the database back.');
    await restoreDatabase(deps, snap.id, pgEnv(cfg.databaseUrl).PGDATABASE);

    deps.log('Putting the uploaded files back.');
    for (const entry of await readdir(cfg.uploadsDir)) await rm(path.join(cfg.uploadsDir, entry), { recursive: true, force: true });
    await cp(stagedUploads, cfg.uploadsDir, { recursive: true, preserveTimestamps: true });
    const own = await deps.run.run('chown', ['-R', APP_UID_GID, cfg.uploadsDir], { timeoutMs: TIMEOUTS.chown });
    if (own.code !== 0) throw new RestoreError('The uploaded files were put back, but the app may not be able to save new ones: their owner could not be set.');

    const when = snap.time !== undefined ? ` from ${ukDate(snap.time)}` : '';
    await recordRun(deps, 'restore', true, `Backup ${snap.short}${when} was put back: the database and the uploaded files. Safety backup ${safety} holds the data from before.`, snap.id);
    return { snapshotId: snap.id };
  } catch (e) {
    const why = e instanceof RestoreError ? e.message : `The restore failed: ${firstLine(scrub(deps, e instanceof Error ? e.message : String(e)))}.`;
    const msg = `${why} The data as it was before this restore is in safety backup ${safety}: restore that id (not latest) to go back.`;
    await recordRun(deps, 'restore', false, msg, snap.id);
    throw new RestoreError(msg, true);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
