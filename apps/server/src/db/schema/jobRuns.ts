import { pgTable, text, boolean, timestamp, primaryKey, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// One row per run of a scheduled app job (Plan 12 Task 9), written by ops. The primary key makes a run happen at most
// once per due time: whoever claims (job, due_at) first runs it, and a run cut short by an ops restart is never run again.
// `summary` is the job's one-line summary or the failure's first line, at most 500 characters, never a secret.
export const jobRuns = pgTable(
  'job_runs',
  {
    job: text('job').notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    ok: boolean('ok'),
    summary: text('summary'),
  },
  (t) => [
    primaryKey({ name: 'job_runs_pkey', columns: [t.job, t.dueAt] }),
    check('job_runs_summary_length', sql`char_length(${t.summary}) <= 500`),
  ],
);
