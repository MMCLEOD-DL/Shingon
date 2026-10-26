import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { assertOffBox, describeRepo, slug } from './config.js';
import { OpsBusyError, withOpsLock } from './opsLock.js';
import { buildManifest } from './manifest.js';
import { connect, pgEnv } from './pg.js';
import { recordRun, scrub, type OpsDeps } from './runs.js';
import type { RunResult } from './runner.js';

export class BackupError extends Error {
  /** `reported`: the message has already been logged and recorded, so the CLI need not print it again. */
  constructor(message: string, public readonly reported = false) {
    super(message);
    this.name = 'BackupError';
  }
}

/** "3 MB", or "0.4 MB" for a small backup, so a real backup never reads as nothing at all. */
export const megabytes = (bytes: number): string => {
  const mb = bytes / 1_000_000;
  return `${String(mb >= 10 ? Math.round(mb) : Math.round(mb * 10) / 10)} MB`;
};

export type BackupKind = 'scheduled' | 'pre-update' | 'manual';

/** The real backups of a deployment, everything but safety backups. Each `--tag a,b` needs both tags; several are alternatives. */
export const LATEST_TAGS = ['--tag', 'hf,scheduled', '--tag', 'hf,manual', '--tag', 'hf,pre-update'];

/** Time limits, so a destination that stops answering gives a plain failure instead of a backup that hangs for ever. */
export const TIMEOUTS = {
  resticQuick: 2 * 60e3,      // cat config, init, snapshots
  resticBackup: 6 * 3600e3,
  resticForget: 2 * 3600e3,
  resticRestore: 6 * 3600e3,
  pgDump: 2 * 3600e3,
  pgRestore: 2 * 3600e3,
  chown: 30 * 60e3,
} as const;

/** The fixed work folder. A fixed path keeps every snapshot of this box in one restic group, so `forget` can prune. */
export const workFiles = (workDir: string): { dir: string; dump: string; manifest: string } => {
  const dir = path.join(workDir, 'backup');
  return { dir, dump: path.join(dir, 'db.dump'), manifest: path.join(dir, 'manifest.json') };
};

/** restic's environment: the destination, the password and the cache, plus whichever destination sign-in details are set. */
export function resticEnv(cfg: OpsDeps['cfg']): Record<string, string> {
  return {
    RESTIC_REPOSITORY: cfg.backup.repository,
    RESTIC_PASSWORD: cfg.backup.password,
    // Next to the work folder: /state/restic-cache in production.
    RESTIC_CACHE_DIR: path.join(path.dirname(cfg.workDir), 'restic-cache'),
    ...cfg.backup.backendEnv,
  };
}

export const firstLine = (text: string): string =>
  (text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'no details were given').slice(0, 200).replace(/\.+$/, '');

const duration = (ms: number): string => (ms >= 3600e3 ? `${String(Math.round(ms / 3600e3))} hours` : `${String(Math.round(ms / 60e3))} minutes`);

/**
 * The plain-English reason a restic command failed. `generic` starts the message for anything unrecognised, which then
 * gives only restic's exit code: raw restic output is never put in a message, the ops log or an alert.
 */
export function resticProblem(deps: Pick<OpsDeps, 'cfg'>, r: RunResult, timeoutMs: number, generic: string): string {
  const repo = describeRepo(deps.cfg.backup.repository);
  if (r.timedOut === true) return `The backup destination did not answer within ${duration(timeoutMs)} (${repo}). Check that it is switched on and reachable from this box.`;
  const err = r.stderr;
  if (/repository is already locked|unable to create lock/i.test(err)) return `The backup destination is busy with another backup or check (${repo}). Try again in a few minutes.`;
  if (/wrong password|no key found/i.test(err)) return 'The backup password does not match the backup destination.';
  if (/no space left on device|disk quota exceeded|insufficient storage|\b507\b/i.test(err)) {
    return `There is not enough disk space for the backup, either at the backup destination (${repo}) or in the ops work folder on this box.`;
  }
  if (/unable to open repository|connection refused|no such host|timeout|network is unreachable|connection reset/i.test(err)) return `The backup destination could not be reached (${repo}).`;
  const http = /(?:unexpected HTTP response|server response unexpected|HTTP status|status code)\D{0,20}(\d{3})/i.exec(err);
  const status = http ? Number(http[1]) : undefined;
  if (status === 401 || status === 403) return `The backup destination refused the sign-in details (${repo}). Check the destination's user name and password settings.`;
  if (status !== undefined && status >= 500) return `The backup destination had a fault of its own (HTTP ${String(status)}) (${repo}). Try again later; if it keeps happening, check the destination.`;
  if (status === 416 || /ciphertext verification failed|checksum mismatch|invalid data returned|unexpected EOF|is damaged|blob [0-9a-f]+ not found|pack [0-9a-f]+ not found/i.test(err)) {
    return `${generic}: some of the saved data could not be read back from ${repo}, so the copy there may be damaged.`;
  }
  if (status === 404 || /repository does not exist|Is there a repository at the following location|unable to open config file/i.test(err)) {
    return `There is no backup repository at ${repo}. The address may be wrong, or no backup has been taken yet.`;
  }
  if (status !== undefined) return `The backup destination turned the request down (HTTP ${String(status)}) (${repo}).`;
  return `${generic} (restic stopped with code ${String(r.code)}).`;
}

async function fetchVersions(deps: OpsDeps): Promise<{ app: string; foundation: string }> {
  try {
    const res = await fetch(`${deps.cfg.appInternalUrl}/api/version`, {
      headers: deps.cfg.healthToken !== undefined ? { 'x-health-token': deps.cfg.healthToken } : {},
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { app: 'unknown', foundation: 'unknown' };
    const v = (await res.json()) as { app?: unknown; foundation?: unknown };
    return { app: typeof v.app === 'string' ? v.app : 'unknown', foundation: typeof v.foundation === 'string' ? v.foundation : 'unknown' };
  } catch {
    // A pre-update backup runs while the app is stopped.
    return { app: 'unknown', foundation: 'unknown' };
  }
}

function isLocal(repo: string): boolean {
  try {
    assertOffBox(repo, false);
    return false;
  } catch {
    return true;
  }
}

/** The warning written down with every backup while backups are allowed to stay on this machine (Ruling 5). */
export const LOCAL_WARNING = 'Warning: this backup is kept on this same machine (BACKUP_ALLOW_LOCAL=true). That is for development only.';

const BUSY = 'Another backup or restore is running right now, so this backup did not start. Try again when it has finished.';
const EMPTY = "The database looks empty, so I did not back it up. Check that DATABASE_URL points at the app's database and that its migrations have run.";

export interface BackupOptions {
  /** A safety backup taken just before a restore. Tagged `safety`, and never pruned. */
  safety?: boolean;
  /** How long to wait for another backup or restore to finish (default: do not wait). */
  lockWaitMs?: number;
}

/**
 * One encrypted backup: the database dump, the uploads and a manifest of row counts and file totals taken in the same
 * database snapshot as the dump. Runs under the ops lock, so it never overlaps another backup or a restore. Records the
 * outcome in ops_runs; on failure throws BackupError with a plain message.
 */
export async function runBackup(deps: OpsDeps, kind: BackupKind, opts: BackupOptions = {}): Promise<{ snapshotId: string }> {
  try {
    // 1. Never only on this box, unless explicitly allowed for development.
    try {
      assertOffBox(deps.cfg.backup.repository, deps.cfg.backup.allowLocal);
    } catch (e) {
      throw new BackupError((e as Error).message);
    }
    return await withOpsLock(deps, { waitMs: opts.lockWaitMs ?? 0, busyMessage: BUSY }, () => backupLocked(deps, kind, opts));
  } catch (e) {
    const message = e instanceof BackupError || e instanceof OpsBusyError
      ? scrub(deps, e.message)
      : `The backup failed: ${firstLine(scrub(deps, e instanceof Error ? e.message : String(e)))}.`;
    // A refusal because another run held the lock is marked, so the monitor does not report it as a failed backup.
    await recordRun(deps, 'backup', false, message, undefined, { busy: e instanceof OpsBusyError && !e.unreachable });
    throw new BackupError(message, true);
  }
}

/** Steps 2 to 8, only ever run while holding the ops lock: the work folder belongs to this run alone. */
async function backupLocked(deps: OpsDeps, kind: BackupKind, opts: BackupOptions): Promise<{ snapshotId: string }> {
  const { cfg, run } = deps;
  const repo = describeRepo(cfg.backup.repository);
  const env = resticEnv(cfg);
  const files = workFiles(cfg.workDir);
  const local = isLocal(cfg.backup.repository);
  const host = slug(cfg.client);
  let client: pg.Client | undefined;
  try {
    if (local) deps.log(LOCAL_WARNING);

    // 2. The first backup creates the repository.
    const cat = await run.run('restic', ['cat', 'config'], { env, timeoutMs: TIMEOUTS.resticQuick });
    if (cat.code !== 0) {
      if (cat.timedOut !== true && /unable to open config file|Is there a repository at the following location|repository does not exist/.test(cat.stderr)) {
        const init = await run.run('restic', ['init'], { env, timeoutMs: TIMEOUTS.resticQuick });
        if (init.code !== 0) throw new BackupError(resticProblem(deps, init, TIMEOUTS.resticQuick, 'The backup destination could not be set up'));
        deps.log(`A new backup destination was set up at ${repo}.`);
      } else {
        throw new BackupError(resticProblem(deps, cat, TIMEOUTS.resticQuick, 'The backup failed'));
      }
    }

    // 3. One exported snapshot for both the counts and the dump.
    let snapshot: string;
    try {
      client = await connect(cfg.databaseUrl);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const id = (await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0]?.id;
      if (id === undefined) throw new Error('no snapshot');
      snapshot = id;
    } catch {
      throw new BackupError('The database could not be read for the backup.');
    }

    // 4. The manifest, inside that snapshot. An empty database is refused: its "backup" would pass every restore test.
    await rm(files.dir, { recursive: true, force: true });
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    let manifest;
    try {
      manifest = await buildManifest(client, await fetchVersions(deps), deps.now());
    } catch {
      throw new BackupError('The database could not be read for the backup.');
    }
    if (Object.keys(manifest.tables).length === 0) throw new BackupError(EMPTY);
    await writeFile(files.manifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });

    // 5. The dump, from the same snapshot.
    const dump = await run.run('pg_dump', ['--format=custom', '--no-owner', `--snapshot=${snapshot}`, `--file=${files.dump}`], { env: pgEnv(cfg.databaseUrl), timeoutMs: TIMEOUTS.pgDump });
    if (dump.code !== 0) throw new BackupError('The database could not be read for the backup.');
    await client.query('COMMIT');

    // 6. Encrypt and send.
    // A safety backup is tagged `safety` instead of its kind, so "latest" and the restore test never pick it (see latestSnapshot).
    const tags = ['--tag', 'hf', '--tag', opts.safety === true ? 'safety' : kind];
    const backup = await run.run('restic', ['backup', '--json', '--host', host, ...tags, files.dump, files.manifest, cfg.uploadsDir], { env, timeoutMs: TIMEOUTS.resticBackup });
    let summary: { snapshot_id?: unknown; total_bytes_processed?: unknown } | undefined;
    for (const line of backup.stdout.split('\n')) {
      if (!line.startsWith('{')) continue;
      try {
        const msg = JSON.parse(line) as { message_type?: unknown };
        if (msg.message_type === 'summary') summary = msg as typeof summary;
      } catch { /* a partial status line */ }
    }
    const snapshotId = typeof summary?.snapshot_id === 'string' ? summary.snapshot_id : undefined;
    if (backup.code === 3 && snapshotId !== undefined) {
      throw new BackupError(`Backup ${snapshotId.slice(0, 8)} was saved, but some files could not be read (restic stopped with code 3).`);
    }
    if (backup.code !== 0) throw new BackupError(resticProblem(deps, backup, TIMEOUTS.resticBackup, 'The backup failed'));
    if (snapshotId === undefined) throw new BackupError('The backup finished but restic did not report which backup it saved.');

    // 7. Only the daily backup prunes, and only this box's real backups: the same selection as "latest". Safety backups
    //    are outside the policy altogether, so they never take a daily/weekly/monthly slot from a real backup, and are never pruned.
    if (kind === 'scheduled') {
      const forget = await run.run('restic', ['forget', ...LATEST_TAGS, '--group-by', 'host', '--host', host, '--prune', ...cfg.backup.keep], { env, timeoutMs: TIMEOUTS.resticForget });
      if (forget.code !== 0) {
        throw new BackupError(`Backup ${snapshotId.slice(0, 8)} was saved, but old backups could not be tidied away. ${resticProblem(deps, forget, TIMEOUTS.resticForget, 'The tidy-up failed')}`);
      }
    }

    // 8. Done.
    const bytes = typeof summary?.total_bytes_processed === 'number' ? summary.total_bytes_processed : 0;
    await recordRun(deps, 'backup', true, `Backup ${snapshotId.slice(0, 8)} saved to ${repo}: ${megabytes(bytes)}.${local ? ` ${LOCAL_WARNING}` : ''}`, snapshotId);
    return { snapshotId };
  } finally {
    if (client !== undefined) {
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
    // Safe: this run holds the lock, so the folder is its own. The dump holds the whole database: never leave it lying around.
    await rm(files.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
