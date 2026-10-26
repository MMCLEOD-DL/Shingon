import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { desc, eq } from 'drizzle-orm';
import { opsRuns } from '@hf/server/db/schema';
import { realIo, runInit, USAGE } from './init-cli.js';
import { checkEdgePair, loadOpsConfig, OpsConfigError, type OpsConfig } from './config.js';
import { BackupError, runBackup, firstLine } from './backup.js';
import { RestoreError, restoreDataFrom, restoreLive, ukDate, verifyLatestRestore } from './restore.js';
import { createOpsDeps, runDaemon } from './daemon.js';
import { execRunner, redact } from './runner.js';
import { formatChecks, monitorChecks } from './checks.js';
import { alertSecrets, channelFromConfig, redactAlert, redactingChannel } from './alerts.js';
import { dockerCompose, loadImageFile, readEnvValue } from './compose.js';
import { fileLock } from './lock.js';
import { withOpsLock } from './opsLock.js';
import { recordRun } from './runs.js';
import { frontDoorCheck, httpWaitReady, runUpdate } from './update.js';

const say = (line: string): void => { console.log(line); };
const MANUAL_BACKUP_LOCK_WAIT = 2 * 60e3;
const complain = (line: string): void => { console.error(line); };
/** How long an update waits for a running backup, restore test or restore to finish before giving up. */
const UPDATE_LOCK_WAIT = 15 * 60e3;
/** The app's user (uid/gid 1000): the ops daemon runs as it, so everything the root updater leaves in /state is given to it. */
const OPS_UID_GID = '1000:1000';
const EXIT = { updated: 0, cancelled: 1, 'rolled-back': 1, 'rollback-failed': 2 } as const;

/** The last line of defence: a plain sentence, never a stack trace, and never a secret from the environment. */
function plain(e: unknown): string {
  if (e instanceof BackupError || e instanceof RestoreError) return e.message;
  const text = e instanceof Error ? e.message : String(e);
  return `Ops stopped because of an unexpected problem: ${firstLine(redact(text, process.env as Record<string, string>))}.`;
}
process.on('uncaughtException', (e) => { complain(plain(e)); process.exit(1); });
process.on('unhandledRejection', (e) => { complain(plain(e)); process.exit(1); });

function config(): OpsConfig | undefined {
  try {
    return loadOpsConfig();
  } catch (e) {
    complain(e instanceof OpsConfigError ? e.message : 'The ops settings could not be read.');
    return undefined;
  }
}

async function withDeps(fn: (deps: ReturnType<typeof createOpsDeps>['deps']) => Promise<number>): Promise<number> {
  const cfg = config();
  if (cfg === undefined) return 2;
  const { deps, close } = createOpsDeps(cfg, say);
  try {
    return await fn(deps);
  } catch (e) {
    // A backup or restore failure has already been logged and recorded in plain English; anything else is said here.
    if (!((e instanceof BackupError || e instanceof RestoreError) && e.reported)) complain(plain(e));
    return 1;
  } finally {
    await close().catch(() => undefined);
  }
}

/**
 * `ops update --to <version> [--image-file <file>]`, `update --status`, `update --mark-recovered`. Runs in the on-demand
 * updater service, the only container with the Docker socket (Ruling 7): docker compose run --rm updater update --to 0.1.1
 */
async function updateCli(rest: string[]): Promise<number> {
  let v;
  try {
    v = parseArgs({ args: rest, strict: true, options: { to: { type: 'string' }, 'image-file': { type: 'string' }, status: { type: 'boolean' }, 'mark-recovered': { type: 'boolean' } } }).values;
  } catch {
    complain(USAGE);
    return 2;
  }
  const modes = [v.to !== undefined, v.status === true, v['mark-recovered'] === true].filter(Boolean).length;
  if (modes !== 1 || (v['image-file'] !== undefined && v.to === undefined)) {
    complain(`update needs exactly one of --to <version>, --status or --mark-recovered.\n\n${USAGE}`);
    return 2;
  }
  if (v.status === true) {
    return withDeps(async (deps) => {
      const rows = await deps.db.select({ at: opsRuns.at, ok: opsRuns.ok, detail: opsRuns.detail }).from(opsRuns)
        .where(eq(opsRuns.kind, 'update')).orderBy(desc(opsRuns.at), desc(opsRuns.id)).limit(5);
      if (rows.length === 0) say('No update has been run on this box yet.');
      for (const r of rows) say(`${ukDate(r.at)}  ${r.ok ? 'done' : 'not done'}  ${r.detail}`);
      return 0;
    });
  }
  if (v['mark-recovered'] === true) {
    return withDeps(async (deps) => {
      await recordRun(deps, 'update', true, 'The operator marked the failed update as recovered.');
      return 0;
    });
  }
  const to = v.to ?? '';
  const bundleDir = process.env['HF_BUNDLE_DIR']?.trim();
  if (bundleDir === undefined || bundleDir === '' || !bundleDir.startsWith('/')) {
    complain('update runs in the updater service, which knows where the bundle is (HF_BUNDLE_DIR): docker compose run --rm updater update --to <version>');
    return 2;
  }
  return withDeps(async (deps) => {
    const { cfg } = deps;
    const stateDir = path.dirname(cfg.workDir);
    // A registry sign-in made with `docker --config <bundle>/.docker login <registry>`; never on a command line.
    const dockerEnv: Record<string, string> = existsSync(path.join(bundleDir, '.docker')) ? { DOCKER_CONFIG: path.join(bundleDir, '.docker') } : {};
    // The updater runs as root (it needs the Docker socket and writes the root-owned .env); the ops daemon runs as uid 1000
    // with no extra powers. So whatever the updater leaves in /state (restic cache, work folder) is handed over, before and
    // after, and also after an update that crashed last time.
    const handOver = async (): Promise<void> => {
      if (process.getuid?.() !== 0) return;
      const r = await execRunner.run('chown', ['-R', OPS_UID_GID, stateDir], { timeoutMs: 30 * 60e3 });
      if (r.code !== 0) say(`Warning: the ops work folder (${stateDir}) could not be handed back to the ops service, so its next backup may fail. Run: docker compose run --rm --entrypoint chown updater -R ${OPS_UID_GID} ${stateDir}`);
    };
    await handOver();
    try {
      if (v['image-file'] !== undefined) say((await loadImageFile(execRunner, path.resolve(bundleDir, v['image-file']), dockerEnv)).message);
      const compose = dockerCompose({ run: execRunner, bundleDir, project: cfg.composeProject, env: dockerEnv });
      const images = { app: (await readEnvValue(bundleDir, 'APP_IMAGE')) ?? 'highland/app', ops: (await readEnvValue(bundleDir, 'OPS_IMAGE')) ?? 'highland/ops' };
      const secrets = alertSecrets(cfg);
      const outcome = await runUpdate({
        compose,
        backup: (kind) => runBackup(deps, kind),
        // The database and the uploads from the pre-update backup, through Task 18's swap-in restore. The update holds the ops lock.
        restoreDb: (id) => restoreDataFrom(deps, { id, short: id.slice(0, 8) }, { lockWaitMs: 0 }),
        waitReady: httpWaitReady({ appUrl: cfg.appInternalUrl, healthToken: cfg.healthToken ?? '' }),
        alert: redactingChannel(channelFromConfig(cfg, say), secrets),
        // recordRun prints the outcome too.
        record: (ok, detail, o) => recordRun(deps, 'update', ok, redactAlert(detail, secrets), undefined, o),
        client: cfg.client,
        images,
        lock: fileLock(path.join(stateDir, 'update.lock')),
        exclusive: (fn) => withOpsLock(deps, { waitMs: UPDATE_LOCK_WAIT, busyMessage: 'busy' }, fn),
        frontDoor: frontDoorCheck(compose),
        log: say,
      }, { to });
      return EXIT[outcome.outcome];
    } finally {
      await handOver();
    }
  });
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init':
      return runInit(rest, realIo);
    case 'backup':
      if (rest.length > 0) { complain(`backup takes no options.\n\n${USAGE}`); return 2; }
      // runBackup logs and records its own outcome; only the exit code is added here.
      // Waits up to 2 minutes for a running backup, restore test or restore, then refuses in plain English.
      return withDeps(async (deps) => { await runBackup(deps, 'manual', { lockWaitMs: MANUAL_BACKUP_LOCK_WAIT }); return 0; });
    case 'restore-test':
      if (rest.length > 0) { complain(`restore-test takes no options.\n\n${USAGE}`); return 2; }
      return withDeps(async (deps) => ((await verifyLatestRestore(deps)).ok ? 0 : 1));
    case 'restore': {
      let parsed;
      try {
        parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { 'yes-replace-live-data': { type: 'boolean' } } });
      } catch {
        complain(USAGE);
        return 2;
      }
      const which = parsed.positionals[0];
      if (which === undefined || parsed.positionals.length > 1) { complain('restore needs one backup id, or latest.\n\n' + USAGE); return 2; }
      if (parsed.values['yes-replace-live-data'] !== true) {
        complain('This replaces the live database and uploaded files with the backup. Nothing has been changed. To go ahead, stop the app and ops (docker compose stop app ops), then run: docker compose run --rm ops restore <backup id | latest> --yes-replace-live-data');
        return 2;
      }
      return withDeps(async (deps) => {
        await restoreLive(deps, which);
        say('Done. Start the app and ops again: docker compose start app ops');
        return 0;
      });
    }
    case 'check': {
      if (rest.length > 0) { complain(`check takes no options.\n\n${USAGE}`); return 2; }
      const cfg = config();
      if (cfg === undefined) return 2;
      const secrets = alertSecrets(cfg);
      const { lines, ok } = formatChecks(await monitorChecks({ cfg }));
      for (const l of lines) say(redactAlert(l, secrets));
      return ok ? 0 : 1;
    }
    case 'check-edge': {
      // Run by the one-shot edge-check service: the front door does not start until this passes.
      const problems = checkEdgePair(process.env['TUNNEL_IP']?.trim() || '172.30.250.10', process.env['EDGE_SUBNET']?.trim() || '172.30.250.0/28');
      if (problems.length > 0) {
        complain(`The front door has not been started because the tunnel settings do not match:\n- ${problems.join('\n- ')}\nFix TUNNEL_IP and EDGE_SUBNET in .env (change both together), then run docker compose up -d again. Backups carry on meanwhile.`);
        return 1;
      }
      say('The tunnel address and the edge network match.');
      return 0;
    }
    case 'update':
      return updateCli(rest);
    case 'daemon': {
      const cfg = config();
      if (cfg === undefined) return 2;
      const { deps, close } = createOpsDeps(cfg, say);
      await runDaemon(deps, close);
      return 0;
    }
    default:
      complain(command === undefined ? USAGE : `"${command}" is not an ops command.\n\n${USAGE}`);
      return 2;
  }
}

process.exitCode = await main(process.argv.slice(2));
