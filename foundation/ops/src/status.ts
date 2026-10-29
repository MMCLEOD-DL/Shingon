import type { Db } from '@hf/server/db';
import type { OpsConfig } from './config.js';
import type { Check } from './checks.js';
import { alertSecrets, redactAlert } from './alerts.js';
import { USAGE } from './init-cli.js';
import { lastRun, outstandingUpdate, scrub, type OpsDeps } from './runs.js';
import { ukDate } from './time.js';

/** One run from the ops log: when (ISO), whether it worked, and its plain-English detail (secrets hidden). */
export interface RunView { at: string; ok: boolean; detail: string }

/**
 * `ops status --json`: one line, for scripts (Conductor reads it over ssh). `schema` changes only when a field changes
 * meaning or goes away. `runs` is null when the ops log could not be read (the reason is in `problems`).
 */
export interface OpsStatus {
  schema: 1;
  client: string;
  at: string;
  ok: boolean;
  checks: { name: string; ok: boolean; critical: boolean; detail: string }[];
  runs: { backup: RunView | null; backupOk: RunView | null; restoreTest: RunView | null; restoreTestOk: RunView | null; update: RunView | null } | null;
  outstandingUpdate: { at: string; snapshotId: string | null } | null;
  problems: string[];
}

export const DB_PROBLEM = 'The ops log in the database could not be read, so the backup and update history is missing. Is the database running?';
const CHECKS_PROBLEM = 'The health checks could not be run, so the state of the app, the disks and the tunnel is not known.';
const BAD_SETTINGS = 'The ops settings could not be read, so no status could be collected. The problem is on standard error.';
const UNKNOWN = 'The status could not be collected because of an unexpected problem, so nothing about this box is known. The details are on standard error.';
const ONLY_JSON = 'status takes only --json.';

/**
 * The health checks and the latest backup, restore-test and update runs. Never throws: checks that cannot be run or an ops
 * log that cannot be read become `problems`, and `ok` is false. `ok` is also false while an update that could not be undone
 * is outstanding, or the latest backup or restore test failed. Every detail has the settings' secrets hidden.
 */
export async function collectStatus(d: { cfg: OpsConfig; db: Db; now: () => Date; checks: () => Promise<Check[]> }): Promise<OpsStatus> {
  const secrets = alertSecrets(d.cfg);
  const clean = (text: string): string => redactAlert(scrub({ cfg: d.cfg }, text), secrets);
  const view = (r: { at: Date; ok: boolean; detail: string } | null): RunView | null => (r === null ? null : { at: r.at.toISOString(), ok: r.ok, detail: clean(r.detail) });
  const problems: string[] = [];

  let checks: OpsStatus['checks'] = [];
  try {
    checks = (await d.checks()).map((c) => ({ name: c.name, ok: c.ok, critical: c.critical === true, detail: clean(c.detail) }));
  } catch {
    problems.push(CHECKS_PROBLEM);
  }

  let runs: OpsStatus['runs'] = null;
  let outstanding: OpsStatus['outstandingUpdate'] = null;
  try {
    const [backup, backupOk, restoreTest, restoreTestOk, update, o] = await Promise.all([
      lastRun(d.db, 'backup', { okOnly: false, notBusy: true }),
      lastRun(d.db, 'backup', { okOnly: true }),
      lastRun(d.db, 'restore-test', { okOnly: false, notBusy: true }),
      lastRun(d.db, 'restore-test', { okOnly: true }),
      lastRun(d.db, 'update', { okOnly: false, notBusy: true }),
      outstandingUpdate(d.db),
    ]);
    runs = { backup: view(backup), backupOk: view(backupOk), restoreTest: view(restoreTest), restoreTestOk: view(restoreTestOk), update: view(update) };
    outstanding = o === null ? null : { at: o.at.toISOString(), snapshotId: o.snapshotId ?? null };
  } catch {
    problems.push(DB_PROBLEM);
  }

  return {
    schema: 1,
    client: d.cfg.client,
    at: d.now().toISOString(),
    // A failed undo, or a latest backup or restore test that failed, is never "ok", whatever the checks say.
    ok: problems.length === 0 && checks.every((c) => c.ok) && outstanding === null && runs?.backup?.ok !== false && runs?.restoreTest?.ok !== false,
    checks,
    runs,
    outstandingUpdate: outstanding,
    problems,
  };
}

/** `Last backup: 27 October 2026 at 01:00, done.` or `…, failed: <detail>`, or `none yet`. */
function runLine(label: string, r: RunView | null): string {
  if (r === null) return `${label}: none yet.`;
  return `${label}: ${ukDate(new Date(r.at))}, ${r.ok ? 'done.' : `failed: ${r.detail}`}`;
}

/** `ops status` without --json: the checks as `ops check` prints them, then any problems and the latest runs. */
export function statusLines(s: OpsStatus): string[] {
  const lines = s.checks.map((c) => (c.ok ? `✓ ${c.name}` : `✗ ${c.name}: ${c.detail}`));
  lines.push(...s.problems);
  if (s.runs !== null) {
    const r = s.runs;
    lines.push(runLine('Last backup', r.backup));
    if (r.backup !== null && !r.backup.ok) lines.push(r.backupOk === null ? 'No backup has worked yet.' : `Last backup that worked: ${ukDate(new Date(r.backupOk.at))}.`);
    lines.push(runLine('Last restore test', r.restoreTest));
    if (r.restoreTest !== null && !r.restoreTest.ok) lines.push(r.restoreTestOk === null ? 'No restore test has passed yet.' : `Last restore test that passed: ${ukDate(new Date(r.restoreTestOk.at))}.`);
    lines.push(runLine('Last update', r.update));
  }
  if (s.outstandingUpdate !== null) {
    lines.push(`The update on ${ukDate(new Date(s.outstandingUpdate.at))} failed and could not be undone, and has not been marked as recovered. See "Recovering from a failed update" in the runbook.`);
  }
  return lines;
}

/** A status that says only that nothing is known: for the JSON line when no status could be collected. Never looks calm. */
function unknownStatus(problem: string, client = ''): OpsStatus {
  return { schema: 1, client, at: new Date().toISOString(), ok: false, checks: [], runs: null, outstandingUpdate: null, problems: [problem] };
}

/** Where statusCli writes, how it gets its ops deps and its checks (cli.ts gives the real ones; tests give fakes). */
export interface StatusCliIo {
  /** One or more lines for standard output. */
  out: (line: string) => void;
  /** One or more lines for standard error. */
  err: (line: string) => void;
  /** Opens the ops deps with `log` as their log (createOpsDeps), runs fn, closes them. 2 when the settings are wrong. */
  withDeps: (fn: (deps: OpsDeps) => Promise<number>, log: (line: string) => void) => Promise<number>;
  /** The health checks for these settings (monitorChecks). */
  checks: (cfg: OpsConfig) => Promise<Check[]>;
}

/**
 * `ops status [--json]`: exit 0 when everything is fine, 1 otherwise, 2 for a usage or settings error. With --json, standard
 * output gets exactly one line of JSON whatever happens (anything else goes to standard error): the status, or one whose
 * `problems` says why none could be collected, with `ok` false.
 */
export async function statusCli(rest: string[], io: StatusCliIo): Promise<number> {
  const json = rest.includes('--json');
  if (rest.some((a) => a !== '--json') || rest.length > 1) {
    io.err(`${ONLY_JSON}\n\n${USAGE}`);
    if (json) io.out(JSON.stringify(unknownStatus(ONLY_JSON)));
    return 2;
  }
  const say = json ? io.err : io.out;
  let status: OpsStatus | undefined;
  const code = await io.withDeps(async (deps) => {
    status = await collectStatus({ cfg: deps.cfg, db: deps.db, now: deps.now, checks: () => io.checks(deps.cfg) });
    if (!json) for (const l of statusLines(status)) io.out(l);
    return status.ok ? 0 : 1;
  }, say);
  if (json) {
    if (status !== undefined) io.out(JSON.stringify(status));
    else io.out(JSON.stringify(unknownStatus(code === 2 ? BAD_SETTINGS : UNKNOWN)));
  }
  return code;
}

/**
 * The line for a crash that escapes statusCli altogether (cli.ts's last-resort handlers), or undefined when the command was
 * not `status --json`. The caller writes it only if no JSON line has been written yet.
 */
export function statusCrashLine(argv: string[]): string | undefined {
  const [command, ...rest] = argv;
  if (command !== 'status' || !rest.includes('--json')) return undefined;
  return JSON.stringify(unknownStatus(UNKNOWN));
}
