import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '@hf/server/db';
import { opsRuns, ROLLBACK_FAILED_MARK, type OpsRunKind } from '@hf/server/db/schema';
import { repoPassword, type OpsConfig } from './config.js';
import type { Runner } from './runner.js';

export type { OpsRunKind } from '@hf/server/db/schema';

export interface OpsDeps {
  cfg: OpsConfig;
  run: Runner;
  db: Db;
  now: () => Date;
  log: (line: string) => void;
}

/** Removes the backup password and any address password from text, in case a message ever picked one up. */
export function scrub(deps: Pick<OpsDeps, 'cfg'>, text: string): string {
  let out = text;
  const secrets = [deps.cfg.backup.password, repoPassword(deps.cfg.backup.repository) ?? '', ...Object.values(deps.cfg.backup.backendEnv)];
  for (const v of secrets) if (v.length >= 4) out = out.split(v).join('[hidden]');
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/[^:/\s@]+):[^@\s/]+@/gi, '$1:***@');
}

/**
 * Writes down what ops did, for the operator and for the monitor. If the database cannot take the record (for example
 * because the database itself is what failed), the result is still logged and the caller carries on.
 */
export async function recordRun(deps: OpsDeps, kind: OpsRunKind, ok: boolean, detail: string, snapshotId?: string, opts: { busy?: boolean } = {}): Promise<boolean> {
  const clean = scrub(deps, detail);
  deps.log(clean);
  try {
    await deps.db.insert(opsRuns).values({ kind, ok, detail: clean, snapshotId: snapshotId ?? null, busy: opts.busy === true, at: deps.now() });
    return true;
  } catch {
    deps.log(`That result could not be written to the ops log in the database (is the database running?).`);
    return false;
  }
}

/**
 * The newest update whose automatic undo failed (or that was found stopped part-way) and that no later successful update or
 * `update --mark-recovered` has cleared, or null. The same rule as the app's /readyz `update` check.
 */
export async function outstandingUpdate(db: Db): Promise<{ at: Date; snapshotId?: string } | null> {
  const r = await db.execute<{ at: Date | string; snapshot_id: string | null }>(sql`
    select at, snapshot_id from ops_runs
    where kind = 'update' and not ok and not busy and position(${ROLLBACK_FAILED_MARK} in detail) > 0
      and at > coalesce((select max(at) from ops_runs where kind = 'update' and ok), '-infinity'::timestamptz)
    order by at desc, id desc limit 1`);
  const row = r.rows[0];
  if (row === undefined) return null;
  return { at: new Date(row.at), ...(row.snapshot_id !== null ? { snapshotId: row.snapshot_id } : {}) };
}

export async function lastRun(db: Db, kind: OpsRunKind, opts: { okOnly: boolean }): Promise<{ at: Date; ok: boolean; detail: string } | null> {
  const rows = await db
    .select({ at: opsRuns.at, ok: opsRuns.ok, detail: opsRuns.detail })
    .from(opsRuns)
    .where(opts.okOnly ? and(eq(opsRuns.kind, kind), eq(opsRuns.ok, true)) : eq(opsRuns.kind, kind))
    .orderBy(desc(opsRuns.at), desc(opsRuns.id))
    .limit(1);
  return rows[0] ?? null;
}
