import { parseArgs } from 'node:util';
import { appJobs } from '@hf/server/jobs';
import { realIo, runHelp, runInit, USAGE } from './init-cli.js';
import { checkEdgePair, loadOpsConfig, OpsConfigError, type OpsConfig } from './config.js';
import { BackupError, firstLine } from './backup.js';
import { RestoreError, restoreLive, verifyLatestRestore } from './restore.js';
import { createOpsDeps, manualBackup, runDaemon } from './daemon.js';
import { execRunner, redact } from './runner.js';
import { formatChecks, monitorChecks } from './checks.js';
import { alertSecrets, redactAlert } from './alerts.js';
import { opsLockHeld } from './opsLock.js';
import { jobsCommand } from './appJobs.js';
import { crashJsonLine, updateCli } from './update-cli.js';

const say = (line: string): void => { console.log(line); };
const MANUAL_BACKUP_LOCK_WAIT = 2 * 60e3;
const complain = (line: string): void => { console.error(line); };

/** The last line of defence: a plain sentence, never a stack trace, and never a secret from the environment. */
function plain(e: unknown): string {
  if (e instanceof BackupError || e instanceof RestoreError) return e.message;
  const text = e instanceof Error ? e.message : String(e);
  return `Ops stopped because of an unexpected problem: ${firstLine(redact(text, process.env as Record<string, string>))}.`;
}
/** update --json promises exactly one line on standard output: set once it has been written. */
let jsonWritten = false;
const out = (line: string): void => { jsonWritten = true; say(line); };
/** A crash that escapes everything: a plain sentence on standard error, and under update --json the `unknown` line. */
function crash(e: unknown): never {
  complain(plain(e));
  const line = crashJsonLine(process.argv.slice(2));
  if (line !== undefined && !jsonWritten) process.stdout.write(`${line}\n`);
  process.exit(1);
}
process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);

function config(): OpsConfig | undefined {
  try {
    return loadOpsConfig();
  } catch (e) {
    complain(e instanceof OpsConfigError ? e.message : 'The ops settings could not be read.');
    return undefined;
  }
}

/** Opens the ops deps, runs fn and closes them. `log` is where their progress lines go (update --json sends them to standard error). */
async function withDeps(fn: (deps: ReturnType<typeof createOpsDeps>['deps']) => Promise<number>, log: (line: string) => void = say): Promise<number> {
  const cfg = config();
  if (cfg === undefined) return 2;
  const { deps, close } = createOpsDeps(cfg, log);
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

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'init':
      return runInit(rest, realIo);
    case 'help':
    case '-h':
    case '--help':
      return runHelp(rest, (t) => process.stdout.write(t), (t) => process.stderr.write(t));
    case 'backup': {
      const force = rest.length === 1 && rest[0] === '--force';
      if (rest.length > 0 && !force) { complain(`backup takes only --force.\n\n${USAGE}`); return 2; }
      // runBackup logs and records its own outcome; only the exit code is added here.
      // Waits up to 2 minutes for a running backup, restore test or restore, then refuses in plain English.
      // While backups are paused (a failed update's backup must stay "latest"), it refuses unless --force.
      return withDeps(async (deps) => {
        const r = await manualBackup(deps, { force, lockWaitMs: MANUAL_BACKUP_LOCK_WAIT });
        if (!r.ok && r.message !== undefined) complain(r.message);
        return r.ok ? 0 : 1;
      });
    }
    case 'restore-test':
      if (rest.length > 0) { complain(`restore-test takes no options.\n\n${USAGE}`); return 2; }
      return withDeps(async (deps) => ((await verifyLatestRestore(deps)).ok ? 0 : 1));
    case 'restore': {
      let parsed;
      try {
        parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: { 'yes-replace-live-data': { type: 'boolean' }, 'any-host': { type: 'boolean' } } });
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
        await restoreLive(deps, which, { anyHost: parsed.values['any-host'] === true });
        say('Done. Start the app and ops again: docker compose start app ops');
        return 0;
      });
    }
    case 'check': {
      if (rest.length > 0) { complain(`check takes no options.\n\n${USAGE}`); return 2; }
      const cfg = config();
      if (cfg === undefined) return 2;
      const secrets = alertSecrets(cfg);
      const { lines, ok } = formatChecks(await monitorChecks({ cfg, opsLockHeld: () => opsLockHeld({ cfg }) }));
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
      return updateCli(rest, { out, err: complain, env: process.env, runner: execRunner, withDeps });
    case 'jobs':
      return jobsCommand(rest, appJobs(), withDeps, { say, complain });
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
