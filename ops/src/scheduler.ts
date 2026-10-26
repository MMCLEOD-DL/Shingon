import { Cron } from 'croner';

export interface Job { name: string; cron: string; run: () => Promise<void> }

/** Starts one timer that calls `fire` on a cron schedule. The default is croner in UK time; tests pass a manual one. */
export type ScheduleFn = (cron: string, name: string, fire: () => Promise<unknown>) => { stop(): void };

const cronSchedule: ScheduleFn = (cron, name, fire) =>
  // `protect` as well as the guard below, so croner itself also never stacks runs.
  new Cron(cron, { timezone: 'Europe/London', protect: true, name }, async () => { await fire(); });

/**
 * One job's run as the scheduler calls it: never overlapping itself (a call while the last run is still going is skipped
 * and returns 'skipped'), and a job that throws is handed to `onFailure`. Each job has its own guard, so one job waiting or
 * running long (a backup waiting an hour for the ops lock) never delays another (the monitor).
 */
export function guardJob(job: Job, onFailure: (name: string, err: Error) => Promise<void>): () => Promise<'ran' | 'skipped'> {
  let running = false;
  return async () => {
    if (running) return 'skipped';
    running = true;
    try {
      await job.run();
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
    for (const job of jobs) timers.push(schedule(job.cron, job.name, guardJob(job, onFailure)));
  } catch (e) {
    for (const t of timers) t.stop();
    throw e;
  }
  return { stop: () => { for (const t of timers) t.stop(); } };
}
