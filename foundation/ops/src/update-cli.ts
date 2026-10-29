import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { desc, eq } from 'drizzle-orm';
import { opsRuns } from '@hf/server/db/schema';
import { USAGE } from './init-cli.js';
import { runBackup } from './backup.js';
import { restoreDataFrom } from './restore.js';
import { ukDate } from './time.js';
import type { Runner } from './runner.js';
import { alertSecrets, channelFromConfig, redactAlert, redactingChannel } from './alerts.js';
import { dockerCompose, imageFileInBundle, loadImageFile, readEnvValue } from './compose.js';
import { fileJournal, UPDATE_RECORD } from './journal.js';
import { fileLock, holderFromInspect, pidAlive, type LockHolder } from './lock.js';
import { withOpsLock } from './opsLock.js';
import { outstandingUpdate, recordRun, type OpsDeps } from './runs.js';
import { frontDoorCheck, httpWaitReady, markRecovered, runUpdate, updateExitCode, updateOutcomeJson, type UpdateOutcome } from './update.js';

/** How long an update waits for a running backup, restore test or restore to finish before giving up. */
const UPDATE_LOCK_WAIT = 15 * 60e3;
/** The app's user (uid/gid 1000): the ops daemon runs as it, so everything the root updater leaves in /state is given to it. */
const OPS_UID_GID = '1000:1000';

const NEEDS_ONE_MODE = 'update needs exactly one of --to <version>, --status or --mark-recovered.';
const JSON_ONLY_WITH_TO = '--json can be used only with --to <version>.';
const UNKNOWN_OPTION = 'update was given an option it does not know, or an option without its value.';
const BAD_SETTINGS = 'The ops settings could not be read, so nothing was changed. The problem is on standard error.';

/** Where updateCli writes, what it runs and how it gets its ops deps (cli.ts gives the real ones; tests give fakes). */
export interface UpdateCliIo {
  /** One or more lines for standard output. */
  out: (line: string) => void;
  /** One or more lines for standard error. */
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Runs docker and chown. */
  runner: Runner;
  /** Opens the ops deps with `log` as their log (createOpsDeps), runs fn, closes them. 2 when the settings are wrong. */
  withDeps: (fn: (deps: OpsDeps) => Promise<number>, log: (line: string) => void) => Promise<number>;
}

/**
 * `ops update --to <version> [--image-file <file>] [--json]`, `update --status`, `update --mark-recovered`. Runs in the
 * on-demand updater service, the only container with the Docker socket (Ruling 7): docker compose run --rm updater update --to 0.1.1
 *
 * With --json every progress line (this command's, runUpdate's, recordRun's and a demo box's alerts) goes to standard error,
 * and standard output gets exactly one line: the outcome as JSON (updateOutcomeJson), or a "refused" line for a problem
 * found before the update started (exit 2). The exit codes are the same with or without it.
 */
export async function updateCli(rest: string[], io: UpdateCliIo): Promise<number> {
  const json = rest.includes('--json');
  const say = json ? io.err : io.out;
  const refuse = (sentence: string, to: string | null, withUsage = false): number => {
    io.err(withUsage ? `${sentence}\n\n${USAGE}` : sentence);
    if (json) io.out(updateOutcomeJson({ refused: sentence, exitCode: 2 }, to));
    return 2;
  };
  let v;
  try {
    v = parseArgs({ args: rest, strict: true, options: { to: { type: 'string' }, 'image-file': { type: 'string' }, status: { type: 'boolean' }, 'mark-recovered': { type: 'boolean' }, json: { type: 'boolean' } } }).values;
  } catch {
    if (!json) { io.err(USAGE); return 2; }
    return refuse(UNKNOWN_OPTION, null, true);
  }
  const to = v.to ?? null;
  const modes = [v.to !== undefined, v.status === true, v['mark-recovered'] === true].filter(Boolean).length;
  if (modes !== 1 || (v['image-file'] !== undefined && v.to === undefined)) return refuse(NEEDS_ONE_MODE, to, true);
  if (json && v.to === undefined) return refuse(JSON_ONLY_WITH_TO, null, true);
  if (v.status === true) {
    return io.withDeps(async (deps) => {
      const rows = await deps.db.select({ at: opsRuns.at, ok: opsRuns.ok, detail: opsRuns.detail }).from(opsRuns)
        .where(eq(opsRuns.kind, 'update')).orderBy(desc(opsRuns.at), desc(opsRuns.id)).limit(5);
      if (rows.length === 0) say('No update has been run on this box yet.');
      for (const r of rows) say(`${ukDate(r.at)}  ${r.ok ? 'done' : 'not done'}  ${r.detail}`);
      return 0;
    }, say);
  }
  const bundleDir = io.env['HF_BUNDLE_DIR']?.trim();
  if (bundleDir === undefined || bundleDir === '' || !bundleDir.startsWith('/')) {
    return refuse('update runs in the updater service, which knows where the bundle is (HF_BUNDLE_DIR): docker compose run --rm updater update --to <version>', to);
  }
  let imageFile: string | undefined;
  if (v['image-file'] !== undefined) {
    try {
      imageFile = await imageFileInBundle(bundleDir, v['image-file']);
    } catch (e) {
      return refuse(`${(e as Error).message} Nothing was changed.`, to);
    }
  }
  const run = io.runner;
  let outcome: UpdateOutcome | undefined;
  const code = await io.withDeps(async (deps) => {
    const { cfg } = deps;
    const stateDir = path.dirname(cfg.workDir);
    const isRoot = process.getuid?.() === 0;
    // A registry sign-in made with `docker --config <bundle>/.docker login <registry>`; never on a command line.
    const dockerEnv: Record<string, string> = existsSync(path.join(bundleDir, '.docker')) ? { DOCKER_CONFIG: path.join(bundleDir, '.docker') } : {};
    // The updater runs as root (it needs the Docker socket and writes the root-owned .env); the ops daemon runs as uid 1000
    // with no extra powers. So whatever the updater leaves in /state (restic cache, work folder, update record) is handed
    // over: at the start (after an update that crashed), before every start of the monitor, and at the end.
    const handOver = async (): Promise<void> => {
      if (!isRoot) return;
      const r = await run.run('chown', ['-R', OPS_UID_GID, stateDir], { timeoutMs: 30 * 60e3 });
      if (r.code !== 0) say(`Warning: the ops work folder (${stateDir}) could not be handed back to the ops service, so its next backup may fail. Run: docker compose run --rm --entrypoint chown updater -R ${OPS_UID_GID} ${stateDir}`);
    };
    // The lock names its holder (this container); it is taken over only when that container is no longer running.
    const isAlive = async (h: LockHolder): Promise<boolean> => {
      if (h.host === hostname()) return pidAlive(h.pid);
      return holderFromInspect(await run.run('docker', ['inspect', '--format', '{{.State.Running}}', h.host], { env: dockerEnv, timeoutMs: 60e3 }));
    };
    const lock = fileLock(path.join(stateDir, 'update.lock'), () => new Date(), { isAlive });
    const journal = fileJournal(path.join(stateDir, UPDATE_RECORD), isRoot ? { owner: { uid: 1000, gid: 1000 } } : {});
    const outstanding = () => outstandingUpdate(deps.db);
    const compose = dockerCompose({ run, bundleDir, project: cfg.composeProject, env: dockerEnv });
    const waitReady = httpWaitReady({ appUrl: cfg.appInternalUrl, healthToken: cfg.healthToken ?? '' });
    await handOver();
    try {
      if (v['mark-recovered'] === true) {
        const r = await markRecovered({ lock, journal, outstanding, readTag: () => compose.readTag(), waitReady, record: (ok, d) => recordRun(deps, 'update', ok, d) });
        if (!r.ok) io.err(r.message);
        return r.ok ? 0 : 1;
      }
      const images = { app: (await readEnvValue(bundleDir, 'APP_IMAGE')) ?? 'highland/app', ops: (await readEnvValue(bundleDir, 'OPS_IMAGE')) ?? 'highland/ops' };
      const secrets = alertSecrets(cfg);
      const o = await runUpdate({
        compose,
        backup: (kind) => runBackup(deps, kind),
        // The database and the uploads from the pre-update backup, through Task 18's swap-in restore. The update holds the ops lock.
        restoreDb: (id, progress) => restoreDataFrom(deps, { id, short: id.slice(0, 8) }, { lockWaitMs: 0, ...(progress !== undefined ? { onStep: progress } : {}) }),
        waitReady,
        alert: redactingChannel(channelFromConfig(cfg, say), secrets),
        // recordRun prints the outcome too.
        record: (ok, detail, ro) => recordRun(deps, 'update', ok, redactAlert(detail, secrets), ro?.snapshotId, ro?.busy === true ? { busy: true } : {}),
        client: cfg.client,
        images,
        lock,
        journal,
        outstanding,
        exclusive: (fn) => withOpsLock(deps, { waitMs: UPDATE_LOCK_WAIT, busyMessage: 'busy' }, fn),
        frontDoor: frontDoorCheck(compose),
        ...(imageFile !== undefined ? { loadImages: () => loadImageFile(run, imageFile, dockerEnv) } : {}),
        beforeStartOps: handOver,
        when: ukDate,
        log: say,
      }, { to: v.to ?? '' });
      // The JSON line goes to standard output, so its message is hidden from secrets as the alert and the record are.
      outcome = { ...o, message: redactAlert(o.message, secrets) };
      return updateExitCode(o);
    } finally {
      await handOver();
    }
  }, say);
  if (json) {
    // The line's exit code is always the process's (a throw after the outcome, while handing /state back, makes it 1).
    if (outcome !== undefined) io.out(updateOutcomeJson(outcome, to, code));
    else if (code === 2) io.out(updateOutcomeJson({ refused: BAD_SETTINGS, exitCode: 2 }, to));
    else io.out(updateOutcomeJson('unknown', to));
  }
  return code;
}

/**
 * The `unknown` line for a crash that escapes updateCli altogether (cli.ts's last-resort handlers), or undefined when the
 * command was not `update … --json`. The caller writes it only if no JSON line has been written yet.
 */
export function crashJsonLine(argv: string[]): string | undefined {
  const [command, ...rest] = argv;
  if (command !== 'update' || !rest.includes('--json')) return undefined;
  let to: string | null = null;
  try {
    const v = parseArgs({ args: rest, strict: false, options: { to: { type: 'string' } } }).values['to'];
    to = typeof v === 'string' ? v : null;
  } catch { /* the line still goes out, without the version */ }
  return updateOutcomeJson('unknown', to);
}
