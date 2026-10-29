import { Cron } from 'croner';

/** `at` is the time the run was due, when the timer knows it (the app jobs record each run against it). */
export interface Job {
  name: string;
  cron: string;
  run: (at?: Date) => Promise<void>;
  /** Told when a due run is skipped because the previous run is still going (ops' own jobs skip silently). */
  onSkip?: () => void;
}

/**
 * Starts one timer that calls `fire` on a cron schedule, with the time the run was due, and `skipped` when the timer itself
 * holds a run back because the last one is still going. The default is croner in UK time; tests pass a manual one.
 */
export type ScheduleFn = (cron: string, name: string, fire: (at?: Date) => Promise<unknown>, skipped: () => void) => { stop(): void };

const cronSchedule: ScheduleFn = (cron, name, fire, skipped) =>
  // croner's `protect` as well as the guard below, so croner itself also never stacks runs. When croner holds a run back
  // it is only reported as skipped (an app job says so); nothing is started.
  new Cron(cron, { timezone: 'Europe/London', protect: () => { skipped(); }, name }, async (self: Cron) => { await fire(self.currentRun() ?? undefined); });

/**
 * One job's run as the scheduler calls it: never overlapping itself (a call while the last run is still going is skipped
 * and returns 'skipped'), and a job that throws is handed to `onFailure`. Each job has its own guard, so one job waiting or
 * running long (a backup waiting an hour for the ops lock) never delays another (the monitor).
 */
export function guardJob(job: Job, onFailure: (name: string, err: Error) => Promise<void>): (at?: Date) => Promise<'ran' | 'skipped'> {
  let running = false;
  return async (at) => {
    if (running) {
      job.onSkip?.();
      return 'skipped';
    }
    running = true;
    try {
      await job.run(at);
    } catch (e) {
      await onFailure(job.name, e instanceof Error ? e : new Error(String(e))).catch(() => undefined);
    } finally {
      running = false;
    }
    return 'ran';
  };
}

/**
 * Runs each job on its cron schedule in UK time. A job never overlaps itself: a backup still running when the next one is
 * due makes the next one skip. A job that throws is handed to `onFailure`; the schedule carries on.
 */
export function startScheduler(jobs: Job[], onFailure: (name: string, err: Error) => Promise<void>, schedule: ScheduleFn = cronSchedule): { stop(): void } {
  const timers: { stop(): void }[] = [];
  try {
    for (const job of jobs) timers.push(schedule(job.cron, job.name, guardJob(job, onFailure), () => { job.onSkip?.(); }));
  } catch (e) {
    for (const t of timers) t.stop();
    throw e;
  }
  return { stop: () => { for (const t of timers) t.stop(); } };
}
