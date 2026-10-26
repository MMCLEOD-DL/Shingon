import { and, desc, eq } from 'drizzle-orm';
import type { Db } from '@hf/server/db';
import { opsRuns, type OpsRunKind } from '@hf/server/db/schema';
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
export async function recordRun(deps: OpsDeps, kind: OpsRunKind, ok: boolean, detail: string, snapshotId?: string, opts: { busy?: boolean } = {}): Promise<void> {
  const clean = scrub(deps, detail);
  deps.log(clean);
  try {
    await deps.db.insert(opsRuns).values({ kind, ok, detail: clean, snapshotId: snapshotId ?? null, busy: opts.busy === true, at: deps.now() });
  } catch {
    deps.log(`That result could not be written to the ops log in the database (is the database running?).`);
  }
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
