/**
 * Scheduled app jobs (Plan 12 Ruling 8): a client feature declares a job here, and the ops service runs it on its cron
 * schedule in UK time, never the app process. A job runs at most once per due time, even across ops restarts, and only
 * when "scheduled-jobs" is in app-profile.json. A job gets the database and a log only: work that needs mail or an
 * export is queued for the app to do.
 */
import { Cron } from 'croner';
import type { Db } from '../db/client.js';

export interface AppJobContext {
  db: Db;
  /** Writes a line to the ops log, after the job's label. Secrets are removed. */
  log: (line: string) => void;
  /** The due time this run is for (a whole minute), such as 07:00 UK time on the 1st for a monthly report. */
  dueAt: Date;
}

export interface AppJob {
  /** Lower-case words joined by dashes, like monthly-report. Recorded with every run, so keep it once the job is live. */
  name: string;
  /** What the operator reads in alerts and `ops jobs`, like "monthly report". */
  label: string;
  /** Five-part cron expression (minute hour day month weekday) in UK time, like 0 7 1 * * for 07:00 on the 1st. */
  cron: string;
  /** 'once': if the box was off when the job was due, run it once when ops starts again. 'skip': wait for the next due time. */
  catchUp: 'once' | 'skip';
  /**
   * Does the work. May return a one-line summary for the run history (at most 500 characters are kept). Ops stops waiting
   * for it after 30 minutes and records the run as failed.
   */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- a job either returns a summary or nothing
  run: (ctx: AppJobContext) => Promise<string | void>;
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Ops' own jobs: an app job with one of these names would be mistaken for it. */
const RESERVED = new Set(['backup', 'restore-test', 'audit-purge', 'monitor']);

const jobs: AppJob[] = [];

function cronProblem(cron: string): boolean {
  if (cron.trim().split(/\s+/).length !== 5) return true;
  try {
    new Cron(cron, { paused: true, timezone: 'Europe/London' }).stop();
    return false;
  } catch {
    return true;
  }
}

/**
 * Adds a job. A client feature calls this in its own file under src/jobs/ and adds an import line to src/jobs/index.ts.
 * A mistake throws a plain sentence as soon as the file is imported, so `npm test` catches it.
 */
export function registerAppJob(job: AppJob): void {
  if (!NAME.test(job.name)) throw new Error(`A scheduled job's name must be lower-case words joined by dashes, like monthly-report (got "${job.name}").`);
  if (RESERVED.has(job.name)) throw new Error(`The name "${job.name}" belongs to one of ops' own jobs. Give the scheduled job another name.`);
  if (jobs.some((j) => j.name === job.name)) throw new Error(`There are two scheduled jobs called "${job.name}". Give each job its own name.`);
  if (job.label.trim() === '') throw new Error(`The scheduled job "${job.name}" needs a label: the words the operator reads in alerts, like "monthly report".`);
  if (cronProblem(job.cron)) {
    throw new Error(`The scheduled job "${job.name}" has a schedule that is not a five-part cron expression (minute hour day month weekday), like 0 7 1 * * (got "${job.cron}").`);
  }
  // Checked here as well as by TypeScript, for a job file written in plain JavaScript or with a cast.
  const catchUp: string = job.catchUp;
  if (catchUp !== 'once' && catchUp !== 'skip') {
    throw new Error(`The scheduled job "${job.name}" must say catchUp: 'once' (run once after the box was off) or 'skip' (wait for the next due time).`);
  }
  jobs.push({ ...job, label: job.label.trim() });
}

/** Every registered job, in the order they were registered. */
export const appJobs = (): AppJob[] => [...jobs];

/** Empties the list (for tests). */
export function clearAppJobs(): void {
  jobs.length = 0;
}
