import { pgTable, bigserial, text, boolean, timestamp, check, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const OPS_RUN_KINDS = ['backup', 'restore-test', 'restore', 'update', 'audit-purge'] as const;
export type OpsRunKind = (typeof OPS_RUN_KINDS)[number];

// What the ops service did and whether it worked: backups, restore tests, restores, updates and audit-log purges.
// The monitor (Task 19) reads it to alert on a failed or missing backup or restore test. `detail` is plain English
// shown to the operator; it never holds a password or a file name.
export const opsRuns = pgTable(
  'ops_runs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind', { enum: OPS_RUN_KINDS }).notNull(),
    ok: boolean('ok').notNull(),
    detail: text('detail').notNull(),
    snapshotId: text('snapshot_id'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ops_runs_kind_check', sql`${t.kind} in ('backup','restore-test','restore','update','audit-purge')`),
    index('ops_runs_kind_at_idx').on(t.kind, t.at),
  ],
);
