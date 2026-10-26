import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import type { Storage } from '../files/storage.js';
import { ROLLBACK_FAILED_MARK } from '../db/schema/opsRuns.js';

export interface Check { name: string; ok: boolean; detail: string }
export type Readiness = 'ok' | 'degraded' | 'down';

export interface ReadinessDeps { db: Db; storage: Pick<Storage, 'check'>; now: () => Date }

/** The whole readiness answer comes back within this, even if the database hangs. */
export const READINESS_TIMEOUT_MS = 3000;
const DATABASE_TIMEOUT_MS = 2000;
const MAIL_BACKLOG_MS = 15 * 60e3;
const BACKUP_MAX_AGE_MS = 26 * 3600e3;
const RESTORE_TEST_MAX_AGE_MS = 8 * 86400e3;

const DATABASE_DOWN = 'The database is not answering.';
const STORAGE_DOWN = 'Uploaded files cannot be saved (storage is not writable).';
/** Said by a check that could not finish in time (almost always because the database is slow or down). */
const NO_ANSWER: Record<string, string> = {
  database: DATABASE_DOWN,
  storage: STORAGE_DOWN,
  migrations: 'The database updates could not be checked in time.',
  email: 'The email queue could not be checked in time.',
  backups: 'The backup record could not be checked in time.',
  'restore-test': 'The restore-test record could not be checked in time.',
  update: 'The update record could not be checked in time.',
};

/** Shown while an update's automatic undo has failed (Task 20), until a later update succeeds or the operator marks it recovered. */
export const UPDATE_UNDO_FAILED = 'An update failed and its automatic undo failed too, so this box may not be on the right version or data. See the runbook, section "Recovering from a failed update". When it is sorted out, run: docker compose run --rm updater update --mark-recovered';

const pass = (name: string): Check => ({ name, ok: true, detail: '' });
const fail = (name: string, detail: string): Check => ({ name, ok: false, detail });
const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

let journalEntries: number | undefined;
/** How many migrations this build ships, from drizzle/meta/_journal.json (one level above src/ and dist/, like runMigrations). */
function shippedMigrations(): number {
  if (journalEntries === undefined) {
    const file = fileURLToPath(new URL('../../drizzle/meta/_journal.json', import.meta.url));
    journalEntries = (JSON.parse(readFileSync(file, 'utf8')) as { entries: unknown[] }).entries.length;
  }
  return journalEntries;
}

async function database(db: Db): Promise<Check> {
  await db.execute(sql`select 1`);
  return pass('database');
}

async function storage(s: Pick<Storage, 'check'>): Promise<Check> {
  try {
    await s.check();
    return pass('storage');
  } catch {
    return fail('storage', STORAGE_DOWN);
  }
}

async function migrations(db: Db): Promise<Check> {
  const shipped = shippedMigrations();
  let applied = 0;
  try {
    const r = await db.execute<{ n: string }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
    applied = Number(r.rows[0]?.n ?? 0);
  } catch (e) {
    // No migrations table means none have run; anything else (the database is down) is not a migrations problem.
    const code = (e as { code?: unknown; cause?: { code?: unknown } }).code ?? (e as { cause?: { code?: unknown } }).cause?.code;
    if (code !== '42P01' && code !== '3F000') throw e;
  }
  const missing = shipped - applied;
  return missing > 0 ? fail('migrations', `The database is missing ${String(missing)} ${missing === 1 ? 'update' : 'updates'}.`) : pass('migrations');
}

async function email(db: Db, now: Date): Promise<Check> {
  const backlogBefore = new Date(now.getTime() - MAIL_BACKLOG_MS);
  const dayAgo = new Date(now.getTime() - 86400e3);
  const r = await db.execute<{ pending: number; oldest: Date | string | null; failed: number }>(sql`
    select
      (select count(*)::int from email_outbox where status = 'pending') as pending,
      (select min(created_at) from email_outbox where status = 'pending') as oldest,
      (select count(*)::int from email_outbox where status = 'failed' and next_attempt_at > ${dayAgo.toISOString()}::timestamptz) as failed`);
  const row = r.rows[0];
  const problems: string[] = [];
  const oldest = row?.oldest == null ? null : new Date(row.oldest);
  if (oldest !== null && oldest < backlogBefore) {
    const minutes = Math.floor((now.getTime() - oldest.getTime()) / 60e3);
    const pending = row?.pending ?? 0;
    problems.push(`${pending === 1 ? '1 email is' : `${String(pending)} emails are`} waiting to be sent (the oldest for ${String(minutes)} minutes).`);
  }
  // A mail is marked failed at its last attempt, which is when its next_attempt_at fell due.
  const failed = row?.failed ?? 0;
  if (failed > 0) problems.push(`${plural(failed, 'email', 'emails')} could not be sent in the last day.`);
  return problems.length > 0 ? fail('email', problems.join(' ')) : pass('email');
}

interface Run { at: Date; ok: boolean; detail: string }
async function runs(db: Db, kind: 'backup' | 'restore-test'): Promise<{ latest: Run | null; lastOk: Run | null }> {
  const pick = async (okOnly: boolean): Promise<Run | null> => {
    const r = await db.execute<{ at: Date | string; ok: boolean; detail: string }>(okOnly
      ? sql`select at, ok, detail from ops_runs where kind = ${kind} and ok order by at desc, id desc limit 1`
      // A run that did not start because another held the ops lock is not a failure of its own: the staleness check
      // catches a backup or restore test that never ran.
      : sql`select at, ok, detail from ops_runs where kind = ${kind} and not busy order by at desc, id desc limit 1`);
    const row = r.rows[0];
    return row ? { at: new Date(row.at), ok: row.ok, detail: row.detail } : null;
  };
  const [latest, lastOk] = await Promise.all([pick(false), pick(true)]);
  return { latest, lastOk };
}

async function backups(db: Db, now: Date): Promise<Check> {
  const { latest, lastOk } = await runs(db, 'backup');
  const problems: string[] = [];
  // A real failure after the last success is a problem even while the last success is fresh. Lock-busy refusals are skipped
  // (see runs), and a failure followed by a success no longer counts, because the latest run is then the success.
  if (latest !== null && !latest.ok) problems.push(`The last backup failed: ${latest.detail}`);
  if (lastOk === null) problems.push('No backup has succeeded yet.');
  else if (now.getTime() - lastOk.at.getTime() >= BACKUP_MAX_AGE_MS) {
    problems.push(`The last successful backup was ${String(Math.floor((now.getTime() - lastOk.at.getTime()) / 3600e3))} hours ago.`);
  }
  return problems.length > 0 ? fail('backups', problems.join(' ')) : pass('backups');
}

async function restoreTest(db: Db, now: Date): Promise<Check> {
  const { latest, lastOk } = await runs(db, 'restore-test');
  if (latest !== null && !latest.ok) return fail('restore-test', `The last restore test failed: ${latest.detail}`);
  if (lastOk === null || now.getTime() - lastOk.at.getTime() >= RESTORE_TEST_MAX_AGE_MS) return fail('restore-test', 'No restore test has passed in the last 8 days.');
  return pass('restore-test');
}

async function update(db: Db): Promise<Check> {
  // Lock refusals (busy) are not outcomes; cancelled and rolled-back updates left the box as it was and alerted at the time.
  const r = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from ops_runs
    where kind = 'update' and not ok and not busy and position(${ROLLBACK_FAILED_MARK} in detail) > 0
      and at > coalesce((select max(at) from ops_runs where kind = 'update' and ok), '-infinity'::timestamptz)`);
  return (r.rows[0]?.n ?? 0) > 0 ? fail('update', UPDATE_UNDO_FAILED) : pass('update');
}

/** Resolves with the check, or with its "no answer" failure if it throws or runs past `ms`. Never rejects. */
function bounded(name: string, ms: number, run: () => Promise<Check>): Promise<Check> {
  const noAnswer = fail(name, NO_ANSWER[name] ?? 'This check did not finish in time.');
  return new Promise<Check>((resolve) => {
    const timer = setTimeout(() => { resolve(noAnswer); }, ms);
    run().then(
      (c) => { clearTimeout(timer); resolve(c); },
      () => { clearTimeout(timer); resolve(noAnswer); },
    );
  });
}

/**
 * The app's readiness checks, in a fixed order, run in parallel and all answered within READINESS_TIMEOUT_MS. Details are
 * fixed plain-English sentences (plus ops' own plain records): never an error message, which could hold a database address.
 */
export async function runReadinessChecks(deps: ReadinessDeps): Promise<Check[]> {
  const now = deps.now();
  return Promise.all([
    bounded('database', DATABASE_TIMEOUT_MS, () => database(deps.db)),
    bounded('storage', READINESS_TIMEOUT_MS, () => storage(deps.storage)),
    bounded('migrations', READINESS_TIMEOUT_MS, () => migrations(deps.db)),
    bounded('email', READINESS_TIMEOUT_MS, () => email(deps.db, now)),
    bounded('backups', READINESS_TIMEOUT_MS, () => backups(deps.db, now)),
    bounded('restore-test', READINESS_TIMEOUT_MS, () => restoreTest(deps.db, now)),
    bounded('update', READINESS_TIMEOUT_MS, () => update(deps.db)),
  ]);
}

/** `down` only when the database fails; any other failing check makes it `degraded`. */
export function readinessStatus(checks: Check[]): Readiness {
  if (checks.some((c) => c.name === 'database' && !c.ok)) return 'down';
  return checks.every((c) => c.ok) ? 'ok' : 'degraded';
}

/**
 * Computes readiness at most once every `ttlMs`, and shares one computation among callers that arrive while it runs, so a
 * flood of anonymous /readyz requests costs the database one round of checks per `ttlMs` at most. With `ttlMs` 0 only the
 * in-flight computation is shared. `clock` is a millisecond counter (default: performance.now, which never jumps).
 */
export function readinessCache(compute: () => Promise<Check[]>, ttlMs: number, clock: () => number = () => performance.now()): () => Promise<Check[]> {
  let cached: { at: number; checks: Check[] } | null = null;
  let inflight: Promise<Check[]> | null = null;
  return () => {
    if (cached !== null && clock() - cached.at < ttlMs) return Promise.resolve(cached.checks);
    if (inflight !== null) return inflight;
    const run = compute().then((checks) => {
      cached = { at: clock(), checks };
      return checks;
    }).finally(() => { inflight = null; });
    inflight = run;
    return run;
  };
}
