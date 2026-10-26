import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';
import { assertOffBox, describeRepo, slug } from './config.js';
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

/** Held for the whole backup, so two backups (the daemon and a manual or pre-update one) never share the work folder. */
const BACKUP_LOCK_KEY = 72_340_018;

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

/** The plain-English reason a restic command failed. `generic` starts the message for anything unrecognised. */
export function resticProblem(deps: Pick<OpsDeps, 'cfg'>, r: RunResult, timeoutMs: number, generic: string): string {
  const repo = describeRepo(deps.cfg.backup.repository);
  if (r.timedOut === true) return `The backup destination did not answer within ${duration(timeoutMs)} (${repo}). Check that it is switched on and reachable from this box.`;
  const err = r.stderr;
  if (/repository is already locked|unable to create lock/i.test(err)) return `The backup destination is busy with another backup or check (${repo}). Try again in a few minutes.`;
  if (/unable to open repository|connection refused|no such host|timeout|network is unreachable/i.test(err)) return `The backup destination could not be reached (${repo}).`;
  if (/wrong password|no key found/i.test(err)) return 'The backup password does not match the backup destination.';
  return `${generic}: ${firstLine(scrub(deps, err))}.`;
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

/**
 * One encrypted backup: the database dump, the uploads and a manifest of row counts and file totals taken in the same
 * database snapshot as the dump. Records the outcome in ops_runs; on failure throws BackupError with a plain message.
 */
export async function runBackup(deps: OpsDeps, kind: BackupKind): Promise<{ snapshotId: string }> {
  const { cfg, run } = deps;
  const repo = describeRepo(cfg.backup.repository);
  const env = resticEnv(cfg);
  const files = workFiles(cfg.workDir);
  const local = isLocal(cfg.backup.repository);
  let client: pg.Client | undefined;
  let locked = false;
  try {
    // 1. Never only on this box, unless explicitly allowed for development.
    try {
      assertOffBox(cfg.backup.repository, cfg.backup.allowLocal);
    } catch (e) {
      throw new BackupError((e as Error).message);
    }
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
    try {
      client = await connect(cfg.databaseUrl);
      const got = await client.query<{ ok: boolean }>('select pg_try_advisory_lock($1) as ok', [BACKUP_LOCK_KEY]);
      locked = got.rows[0]?.ok === true;
    } catch {
      throw new BackupError('The database could not be read for the backup.');
    }
    if (!locked) throw new BackupError('Another backup is already running on this box. Try again when it has finished.');
    let snapshot: string;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const id = (await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0]?.id;
      if (id === undefined) throw new Error('no snapshot');
      snapshot = id;
    } catch {
      throw new BackupError('The database could not be read for the backup.');
    }

    // 4. The manifest, inside that snapshot.
    await rm(files.dir, { recursive: true, force: true });
    await mkdir(files.dir, { recursive: true, mode: 0o700 });
    try {
      const manifest = await buildManifest(client, await fetchVersions(deps));
      await writeFile(files.manifest, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    } catch (e) {
      if (e instanceof BackupError) throw e;
      throw new BackupError('The database could not be read for the backup.');
    }

    // 5. The dump, from the same snapshot.
    const dump = await run.run('pg_dump', ['--format=custom', '--no-owner', `--snapshot=${snapshot}`, `--file=${files.dump}`], { env: pgEnv(cfg.databaseUrl), timeoutMs: TIMEOUTS.pgDump });
    if (dump.code !== 0) throw new BackupError('The database could not be read for the backup.');
    await client.query('COMMIT');

    // 6. Encrypt and send.
    const backup = await run.run('restic', ['backup', '--json', '--host', slug(cfg.client), '--tag', 'hf', '--tag', kind, files.dump, files.manifest, cfg.uploadsDir], { env, timeoutMs: TIMEOUTS.resticBackup });
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
      throw new BackupError(`Backup ${snapshotId.slice(0, 8)} was saved, but some files could not be read: ${firstLine(scrub(deps, backup.stderr))}.`);
    }
    if (backup.code !== 0) throw new BackupError(resticProblem(deps, backup, TIMEOUTS.resticBackup, 'The backup failed'));
    if (snapshotId === undefined) throw new BackupError('The backup finished but restic did not report which backup it saved.');

    // 7. Only the daily backup prunes. A pre-update or manual backup never removes anything.
    if (kind === 'scheduled') {
      const forget = await run.run('restic', ['forget', '--tag', 'hf', '--group-by', 'host', '--prune', ...cfg.backup.keep], { env, timeoutMs: TIMEOUTS.resticForget });
      if (forget.code !== 0) {
        throw new BackupError(`Backup ${snapshotId.slice(0, 8)} was saved, but old backups could not be tidied away. ${resticProblem(deps, forget, TIMEOUTS.resticForget, 'The tidy-up failed')}`);
      }
    }

    // 8. Done.
    const bytes = typeof summary?.total_bytes_processed === 'number' ? summary.total_bytes_processed : 0;
    await rm(files.dir, { recursive: true, force: true });
    await recordRun(deps, 'backup', true, `Backup ${snapshotId.slice(0, 8)} saved to ${repo}: ${megabytes(bytes)}.${local ? ` ${LOCAL_WARNING}` : ''}`, snapshotId);
    return { snapshotId };
  } catch (e) {
    const message = e instanceof BackupError ? scrub(deps, e.message) : `The backup failed: ${firstLine(scrub(deps, e instanceof Error ? e.message : String(e)))}.`;
    await recordRun(deps, 'backup', false, message);
    throw new BackupError(message, true);
  } finally {
    if (client !== undefined) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (locked) await client.query('select pg_advisory_unlock($1)', [BACKUP_LOCK_KEY]).catch(() => undefined);
      await client.end().catch(() => undefined);
    }
    // The dump holds the whole database: never leave it lying around after a failure.
    await rm(files.dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
