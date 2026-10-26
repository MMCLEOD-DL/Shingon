import { Cron } from 'croner';

export interface Job { name: string; cron: string; run: () => Promise<void> }

/**
 * Runs each job on its cron schedule in UK time. A job never overlaps itself (`protect`): a backup still running when the next
 * one is due makes the next one skip. A job that throws is handed to `onFailure`; the schedule carries on.
 */
export function startScheduler(jobs: Job[], onFailure: (name: string, err: Error) => Promise<void>): { stop(): void } {
  const crons: Cron[] = [];
  try {
    for (const job of jobs) {
      crons.push(new Cron(job.cron, { timezone: 'Europe/London', protect: true, name: job.name }, async () => {
        try {
          await job.run();
        } catch (e) {
          await onFailure(job.name, e instanceof Error ? e : new Error(String(e))).catch(() => undefined);
        }
      }));
    }
  } catch (e) {
    for (const c of crons) c.stop();
    throw e;
  }
  return { stop: () => { for (const c of crons) c.stop(); } };
}
