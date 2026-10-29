/**
 * The app's scheduled jobs (`@hf/server/jobs`), run by the ops daemon and never by the app (Plan 12 Ruling 8): the ops
 * container is stopped during an update, so a job never meets a half-updated database, and an app restart never runs a
 * job twice. Each run is claimed in `job_runs` by (job, due time) first, so a due time runs at most once whoever tries;
 * after the box was off, a `catchUp: 'once'` job runs once for the latest missed due time, not once per missed slot.
 */
import { Cron } from 'croner';
import { and, desc, eq, isNull, lt, max } from 'drizzle-orm';
import { moduleOn } from '@hf/shared';
import type { Db } from '@hf/server/db';
import { jobRuns } from '@hf/server/db/schema';
import type { AppJob } from '@hf/server/jobs';
import { alertSecrets, redactAlert } from './alerts.js';
import { scrub, type OpsDeps } from './runs.js';
import type { Job } from './scheduler.js';
import { ukDate } from './time.js';
import { USAGE } from './init-cli.js';

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

/**
 * The due time a fire at `at` is for: the latest slot of `cron` at or before `at` (croner fires on or just after a slot;
 * a fire held up by a busy event loop still counts for the slot it was due at).
 */
export function dueAtFor(cron: string, at: Date): Date {
  const c = schedule(cron);
  const prev = c.previousRuns(1, at)[0];
  if (prev === undefined) return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
  const next = c.nextRun(prev);
  return next !== null && next.getTime() <= at.getTime() ? next : prev;
}

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

/** How long ops waits for one run of an app job before recording it as failed and alerting. */
export const APP_JOB_TIME_LIMIT_MS = 30 * 60e3;

const duration = (ms: number): string => {
  const [n, unit] = ms >= 60e3 ? [Math.round(ms / 60e3), 'minute'] : [Math.max(1, Math.round(ms / 1000)), 'second'];
  return `${String(n)} ${unit}${n === 1 ? '' : 's'}`;
};

export interface AppJobOptions {
  /** How long one run may take (default 30 minutes). */
  timeLimitMs?: number;
  /** Aborted when ops begins to stop; passed on to the job as `ctx.signal`. */
  stopSignal?: AbortSignal;
}

/**
 * Runs `job` for `dueAt` unless that due time was already claimed: claim, run, then record when it finished, whether it
 * worked and its summary. A failure, or a run still going after the time limit, is recorded with one line and thrown as
 * an AppJobError, so the daemon's failure hook alerts with the job's label. Ops stops waiting for a run past its limit
 * and aborts `ctx.signal` (it cannot stop the job from outside: a job that ignores the signal carries on), so a hung job
 * never holds up anything else. The signal is aborted when ops begins to stop, too.
 */
export async function runAppJob(deps: OpsDeps, job: AppJob, dueAt: Date, opts: AppJobOptions = {}): Promise<'ran' | 'already-ran'> {
  let claimed: boolean;
  try {
    claimed = await claimRun(deps.db, job.name, dueAt, deps.now());
  } catch {
    throw new AppJobError(job.label, 'It did not start because its run could not be recorded in the database (is the database running?)');
  }
  if (!claimed) return 'already-ran';
  const limit = opts.timeLimitMs ?? APP_JOB_TIME_LIMIT_MS;
  const abort = new AbortController();
  const onStop = (): void => { abort.abort(); };
  if (opts.stopSignal?.aborted === true) abort.abort();
  else opts.stopSignal?.addEventListener('abort', onStop, { once: true });
  const ctx = { db: deps.db, log: (line: string) => { deps.log(`${job.label}: ${clean(deps, line)}`); }, dueAt, signal: abort.signal };
  // Settles either way and never rejects, so a job that fails after its time limit is not an unhandled rejection.
  const settled = Promise.resolve()
    .then(() => job.run(ctx))
    .then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  let timer: NodeJS.Timeout | undefined;
  // Unref'd: a run ops is waiting for never keeps the process alive on its own once everything else has stopped.
  const timedOut = new Promise<'timed-out'>((resolve) => { timer = setTimeout(() => { resolve('timed-out'); }, limit); timer.unref(); });
  const outcome = await Promise.race([settled, timedOut]).finally(() => {
    clearTimeout(timer);
    opts.stopSignal?.removeEventListener('abort', onStop);
  });
  if (outcome === 'timed-out') {
    abort.abort();
    const line = `It did not finish within ${duration(limit)}.`;
    await finishRun(deps, job, dueAt, false, line);
    throw new AppJobError(job.label, line);
  }
  if (!outcome.ok) {
    const e = outcome.error;
    const line = oneLine(deps, e instanceof Error ? e.message : String(e), 'It stopped without saying why');
    await finishRun(deps, job, dueAt, false, line);
    throw new AppJobError(job.label, line);
  }
  const result = outcome.value;
  await finishRun(deps, job, dueAt, true, typeof result === 'string' && result.trim() !== '' ? oneLine(deps, result, '') : null);
  return 'ran';
}

const runs = (n: number): string => `${String(n)} ${n === 1 ? 'run' : 'runs'}`;

type RunFn = (job: AppJob, dueAt: Date) => Promise<'ran' | 'already-ran' | 'skipped'>;

/**
 * At ops start: each `catchUp: 'once'` job whose latest due time passed while ops was not running runs once for that due
 * time; the slots before it are skipped and logged. A job with no recorded run starts from now (nothing to catch up), and
 * a due time already claimed (even by a run cut short) never runs again. Returns the names of the jobs that ran. A failed
 * run goes to `onFailure` (logged when there is none) and the other jobs still catch up.
 */
export async function catchUpAppJobs(
  deps: OpsDeps, jobs: AppJob[], onFailure?: (name: string, err: Error) => Promise<void>,
  run: RunFn = (job, dueAt) => runAppJob(deps, job, dueAt),
): Promise<string[]> {
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
      if ((await run(job, latest)) !== 'ran') continue;
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

const CUT_SHORT = 'Ops stopped before it finished (or could not record how it went), so it was not run again.';

/**
 * At ops start: a run that started before `before` and never finished was cut short by an ops stop or crash. It is never
 * run again (it may have done part or all of its work), but the operator is told once: the alert goes to `onFailure` and
 * the row is marked failed, so a later start does not tell them again. Returns the names of the jobs reported.
 */
export async function reportUnfinishedRuns(deps: OpsDeps, jobs: AppJob[], onFailure: (name: string, err: Error) => Promise<void>, before: Date): Promise<string[]> {
  const reported: string[] = [];
  for (const job of jobs) {
    let rows: { dueAt: Date; startedAt: Date }[];
    try {
      rows = await deps.db.update(jobRuns).set({ ok: false, summary: CUT_SHORT })
        .where(and(eq(jobRuns.job, job.name), isNull(jobRuns.finishedAt), isNull(jobRuns.ok), lt(jobRuns.startedAt, before)))
        .returning({ dueAt: jobRuns.dueAt, startedAt: jobRuns.startedAt });
    } catch {
      deps.log(`${job.label}: runs cut short by an ops stop were not checked because the database could not be read (is the database running?).`);
      continue;
    }
    const latest = rows.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    if (latest === undefined) continue;
    reported.push(job.name);
    const message = `It started on ${ukDate(latest.startedAt)} but ops stopped before it finished (or could not record how it went), so it has not been run again. Check whether it did its work.`;
    await onFailure(job.name, new AppJobError(job.label, message)).catch(() => undefined);
  }
  return reported;
}

/**
 * One job's runs, live and catch-up alike: never two at once. A run due while the last one is still going is skipped;
 * each skip is logged and the first skip of a stuck run is alerted.
 */
function jobRunner(deps: OpsDeps, job: AppJob, onFailure: (name: string, err: Error) => Promise<void>, opts: AppJobOptions): { run: RunFn; skipped: () => Promise<void> } {
  let current: Date | null = null;
  let alerted = false;
  const skipped = async (): Promise<void> => {
    if (current === null) return;
    const message = `The run due on ${ukDate(dueAtFor(job.cron, deps.now()))} was skipped because the run due on ${ukDate(current)} is still going.`;
    if (alerted) {
      deps.log(`${job.label}: ${message}`);
      return;
    }
    alerted = true;
    await onFailure(job.name, new AppJobError(job.label, message)).catch(() => undefined);
  };
  const run: RunFn = async (j, dueAt) => {
    if (current !== null) {
      await skipped();
      return 'skipped';
    }
    current = dueAt;
    try {
      return await runAppJob(deps, j, dueAt, opts);
    } finally {
      current = null;
      alerted = false;
    }
  };
  return { run, skipped };
}

/**
 * The app's jobs as ops scheduler jobs, ready for `startScheduler`, and the start-up work to run once the scheduler is
 * going (never awaited before it: a hung job must not hold up backups or the monitor): report runs cut short by an ops
 * stop, then catch up. With "scheduled-jobs" not on in app-profile.json none run, and one line says how many are written
 * but switched off. `stop` is called when ops begins to stop: each running job's `ctx.signal` is aborted, and from then on
 * a job failure is only logged (the database pool is closing, so a raw "pool after calling end" must never be alerted).
 */
export function scheduleAppJobs(
  deps: OpsDeps, jobs: AppJob[], onFailure: (name: string, err: Error) => Promise<void>, opts: AppJobOptions = {},
): { jobs: Job[]; startUp: () => Promise<void>; stop: () => void } {
  if (!moduleOn(deps.cfg, 'scheduled-jobs')) {
    if (jobs.length > 0) {
      deps.log(`${String(jobs.length)} scheduled ${jobs.length === 1 ? 'job is' : 'jobs are'} written but switched off. Add "scheduled-jobs" to app-profile.json to run them.`);
    }
    return { jobs: [], startUp: () => Promise.resolve(), stop: () => undefined };
  }
  if (jobs.length > 0) deps.log(`Scheduled app jobs (UK time): ${jobs.map((j) => `${j.label} "${j.cron}"`).join('; ')}.`);
  const started = deps.now();
  const stopping = new AbortController();
  const stoppingLine = (err: Error): string => {
    const label = err instanceof AppJobError ? err.label : 'a scheduled job';
    return `The scheduled job "${label}" did not finish because ops was stopping: ${scrub(deps, err.message)}`;
  };
  // Alerts as usual while running; once ops is stopping, only a log line.
  const report = async (name: string, err: Error): Promise<void> => {
    if (stopping.signal.aborted) { deps.log(stoppingLine(err)); return; }
    await onFailure(name, err);
  };
  const runOpts: AppJobOptions = { ...opts, stopSignal: stopping.signal };
  const runners = new Map(jobs.map((job) => [job.name, jobRunner(deps, job, report, runOpts)]));
  const runnerOf = (job: AppJob): ReturnType<typeof jobRunner> => runners.get(job.name) as ReturnType<typeof jobRunner>;
  return {
    jobs: jobs.map((job) => ({
      name: job.name,
      cron: job.cron,
      // The due time is the slot the timer fired for (the clock's time when a test fires it by hand).
      run: async (at?: Date) => {
        try {
          await runnerOf(job).run(job, dueAtFor(job.cron, at ?? deps.now()));
        } catch (e) {
          if (!stopping.signal.aborted) throw e;
          deps.log(stoppingLine(e instanceof Error ? e : new Error(String(e))));
        }
      },
      onSkip: () => { void runnerOf(job).skipped(); },
    })),
    startUp: async () => {
      await reportUnfinishedRuns(deps, jobs, report, started);
      await catchUpAppJobs(deps, jobs, report, (job, dueAt) => runnerOf(job).run(job, dueAt));
    },
    stop: () => { stopping.abort(); },
  };
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
      ? 'started but did not finish (ops stopped part-way through, or could not record how it went)'
      : `${last.ok ? 'worked' : 'failed'}${last.summary !== null ? ` (${last.summary.replace(/\.+$/, '')})` : ''}`;
    lines.push(`${head} — last run ${ukDate(last.dueAt)}: ${outcome}.`);
  }
  return lines;
}

/**
 * `ops jobs`: the app's jobs, each with its last run, and a line when they are switched off. `open` gives the command its
 * database connection (and closes it afterwards).
 */
export async function jobsCommand(
  rest: string[], jobs: AppJob[], open: (fn: (deps: OpsDeps) => Promise<number>) => Promise<number>,
  io: { say: (line: string) => void; complain: (line: string) => void },
): Promise<number> {
  if (rest.length > 0) {
    io.complain(`jobs takes no options.\n\n${USAGE}`);
    return 2;
  }
  if (jobs.length === 0) {
    io.say('This app has no scheduled jobs.');
    return 0;
  }
  return open(async (deps) => {
    if (!moduleOn(deps.cfg, 'scheduled-jobs')) io.say('These jobs are switched off. Add "scheduled-jobs" to app-profile.json to run them.');
    for (const line of await describeAppJobs(deps, jobs)) io.say(line);
    return 0;
  });
}
