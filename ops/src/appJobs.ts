/**
 * The app's scheduled jobs (`@hf/server/jobs`), run by the ops daemon and never by the app (Plan 12 Ruling 8): the ops
 * container is stopped during an update, so a job never meets a half-updated database, and an app restart never runs a
 * job twice. Each run is claimed in `job_runs` by (job, due time) first, so a due time runs at most once whoever tries;
 * after the box was off, a `catchUp: 'once'` job runs once for the latest missed due time, not once per missed slot.
 */
import { Cron } from 'croner';
import { desc, eq, and, max } from 'drizzle-orm';
import { moduleOn } from '@hf/shared';
import type { Db } from '@hf/server/db';
import { jobRuns } from '@hf/server/db/schema';
import type { AppJob } from '@hf/server/jobs';
import { alertSecrets, redactAlert } from './alerts.js';
import { scrub, type OpsDeps } from './runs.js';
import type { Job } from './scheduler.js';
import { ukDate } from './time.js';

/** How far `dueSince` walks the schedule: an every-minute job after a week off is capped here, never a hang. */
const WALK_LIMIT = 10_000;
const SUMMARY_MAX = 500;

/** A failed app job, carrying its label so the alert names it as the operator knows it. The message is one clean line. */
export class AppJobError extends Error {
  constructor(public readonly label: string, message: string) {
    super(message);
    this.name = 'AppJobError';
  }
}

const schedule = (cron: string): Cron => new Cron(cron, { paused: true, timezone: 'Europe/London' });

/** The due times after `after` up to and including `now`: the latest one, and how many there were (at most WALK_LIMIT). */
function missedSlots(cron: string, after: Date, now: Date): { latest: Date | null; count: number } {
  const c = schedule(cron);
  let latest: Date | null = null;
  let count = 0;
  let t: Date = after;
  for (;;) {
    const next = c.nextRun(t);
    if (next === null || next.getTime() > now.getTime()) break;
    latest = next;
    count++;
    t = next;
    if (count >= WALK_LIMIT) {
      // Capped: the latest due time is found from the other end instead.
      const prev = c.previousRuns(1, now)[0];
      const atNow = prev !== undefined ? c.nextRun(prev) : null;
      latest = atNow !== null && atNow.getTime() <= now.getTime() ? atNow : (prev ?? latest);
      break;
    }
  }
  return { latest, count };
}

/** The latest due time of `cron` (UK time) after `after` and no later than `now`, or null when none was missed. */
export function dueSince(cron: string, after: Date, now: Date): Date | null {
  return missedSlots(cron, after, now).latest;
}

const toMinute = (d: Date): Date => new Date(Math.floor(d.getTime() / 60_000) * 60_000);

/** Secrets removed, as for every ops message and alert. */
const clean = (deps: OpsDeps, text: string): string => redactAlert(scrub(deps, text), alertSecrets(deps.cfg));

/** The first non-empty line, cleaned and cut to the summary's 500 characters. */
function oneLine(deps: OpsDeps, text: string, fallback: string): string {
  const line = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? fallback;
  return clean(deps, line).slice(0, SUMMARY_MAX);
}

/**
 * Claims the run of `job` for `dueAt`: true when this call recorded it and so must run it, false when it was already
 * claimed (it ran, is running, or was cut short by an ops restart). A run therefore happens at most once per due time.
 */
export async function claimRun(db: Db, job: string, dueAt: Date, startedAt: Date): Promise<boolean> {
  const rows = await db.insert(jobRuns).values({ job, dueAt, startedAt }).onConflictDoNothing().returning({ job: jobRuns.job });
  return rows.length === 1;
}

export interface JobRun { dueAt: Date; startedAt: Date; finishedAt: Date | null; ok: boolean | null; summary: string | null }

/** The job's most recent run (by due time), or null when it has never run. */
export async function lastJobRun(db: Db, job: string): Promise<JobRun | null> {
  const rows = await db
    .select({ dueAt: jobRuns.dueAt, startedAt: jobRuns.startedAt, finishedAt: jobRuns.finishedAt, ok: jobRuns.ok, summary: jobRuns.summary })
    .from(jobRuns)
    .where(eq(jobRuns.job, job))
    .orderBy(desc(jobRuns.dueAt))
    .limit(1);
  return rows[0] ?? null;
}

async function finishRun(deps: OpsDeps, job: AppJob, dueAt: Date, ok: boolean, summary: string | null): Promise<void> {
  try {
    await deps.db.update(jobRuns).set({ finishedAt: deps.now(), ok, summary })
      .where(and(eq(jobRuns.job, job.name), eq(jobRuns.dueAt, dueAt)));
  } catch {
    deps.log(`${job.label}: the outcome of the run could not be written to the database (is the database running?).`);
  }
}

/**
 * Runs `job` for `dueAt` unless that due time was already claimed: claim, run, then record when it finished, whether it
 * worked and its summary. A failure is recorded with its first line and thrown again as an AppJobError, so the daemon's
 * failure hook alerts with the job's label.
 */
export async function runAppJob(deps: OpsDeps, job: AppJob, dueAt: Date): Promise<'ran' | 'already-ran'> {
  let claimed: boolean;
  try {
    claimed = await claimRun(deps.db, job.name, dueAt, deps.now());
  } catch {
    throw new AppJobError(job.label, 'It did not start because its run could not be recorded in the database (is the database running?)');
  }
  if (!claimed) return 'already-ran';
  let result: unknown;
  try {
    result = await job.run({ db: deps.db, log: (line) => { deps.log(`${job.label}: ${clean(deps, line)}`); }, dueAt });
  } catch (e) {
    const line = oneLine(deps, e instanceof Error ? e.message : String(e), 'It stopped without saying why');
    await finishRun(deps, job, dueAt, false, line);
    throw new AppJobError(job.label, line);
  }
  await finishRun(deps, job, dueAt, true, typeof result === 'string' && result.trim() !== '' ? oneLine(deps, result, '') : null);
  return 'ran';
}

const runs = (n: number): string => `${String(n)} ${n === 1 ? 'run' : 'runs'}`;

/**
 * At ops start: each `catchUp: 'once'` job whose latest due time passed while ops was not running runs once for that due
 * time; the slots before it are skipped and logged. A job with no recorded run starts from now (nothing to catch up), and
 * a due time already claimed (even by a run cut short) never runs again. Returns the names of the jobs that ran. A failed
 * run goes to `onFailure` (logged when there is none) and the other jobs still catch up.
 */
export async function catchUpAppJobs(deps: OpsDeps, jobs: AppJob[], onFailure?: (name: string, err: Error) => Promise<void>): Promise<string[]> {
  const ran: string[] = [];
  for (const job of jobs) {
    if (job.catchUp !== 'once') continue;
    let after: Date | null;
    try {
      const r = await deps.db.select({ at: max(jobRuns.dueAt) }).from(jobRuns).where(eq(jobRuns.job, job.name));
      after = r[0]?.at ?? null;
    } catch {
      deps.log(`${job.label}: missed runs were not checked because the database could not be read (is the database running?).`);
      continue;
    }
    if (after === null) continue;
    const { latest, count } = missedSlots(job.cron, after, deps.now());
    if (latest === null) continue;
    let failure: Error | undefined;
    try {
      if ((await runAppJob(deps, job, latest)) === 'already-ran') continue;
    } catch (e) {
      failure = e instanceof Error ? e : new Error(String(e));
    }
    ran.push(job.name);
    if (failure !== undefined) {
      if (onFailure !== undefined) await onFailure(job.name, failure).catch(() => undefined);
      else deps.log(`The scheduled job "${job.label}" did not work: ${failure.message}`);
    }
    deps.log(`${job.label}: missed ${count >= WALK_LIMIT ? `more than ${runs(count)}` : runs(count)} while the box was off; ran ${count === 1 ? 'it' : 'once'} to catch up.`);
  }
  return ran;
}

/**
 * The app's jobs as ops scheduler jobs, ready for `startScheduler`, after catching up. With "scheduled-jobs" not on in
 * app-profile.json none run, and one line says how many are written but switched off.
 */
export async function scheduleAppJobs(deps: OpsDeps, jobs: AppJob[], onFailure: (name: string, err: Error) => Promise<void>): Promise<Job[]> {
  if (!moduleOn(deps.cfg, 'scheduled-jobs')) {
    if (jobs.length > 0) {
      deps.log(`${String(jobs.length)} scheduled ${jobs.length === 1 ? 'job is' : 'jobs are'} written but switched off. Add "scheduled-jobs" to app-profile.json to run them.`);
    }
    return [];
  }
  if (jobs.length > 0) deps.log(`Scheduled app jobs (UK time): ${jobs.map((j) => `${j.label} "${j.cron}"`).join('; ')}.`);
  await catchUpAppJobs(deps, jobs, onFailure);
  return jobs.map((job) => ({
    name: job.name,
    cron: job.cron,
    // The due time is the minute the timer fired for (the clock's minute when a test fires it by hand).
    run: async (at?: Date) => { await runAppJob(deps, job, toMinute(at ?? deps.now())); },
  }));
}

/** `ops jobs`: one line per job with its schedule, its last run in UK time and how that went. */
export async function describeAppJobs(deps: OpsDeps, jobs: AppJob[]): Promise<string[]> {
  const lines: string[] = [];
  for (const job of jobs) {
    const head = `${job.label} — "${job.cron}" (UK time)`;
    const last = await lastJobRun(deps.db, job.name);
    if (last === null) {
      lines.push(`${head} — not run yet.`);
      continue;
    }
    const outcome = last.finishedAt === null || last.ok === null
      ? 'started but did not finish (ops stopped part-way through)'
      : `${last.ok ? 'worked' : 'failed'}${last.summary !== null ? ` (${last.summary.replace(/\.+$/, '')})` : ''}`;
    lines.push(`${head} — last run ${ukDate(last.dueAt)}: ${outcome}.`);
  }
  return lines;
}
