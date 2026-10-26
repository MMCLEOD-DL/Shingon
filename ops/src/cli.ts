import { parseArgs } from 'node:util';
import { realIo, runInit, USAGE } from './init-cli.js';
import { checkEdgePair, loadOpsConfig, OpsConfigError, type OpsConfig } from './config.js';
import { BackupError, runBackup, firstLine } from './backup.js';
import { RestoreError, restoreLive, verifyLatestRestore } from './restore.js';
import { createOpsDeps, runDaemon } from './daemon.js';
import { redact } from './runner.js';
import { formatChecks, monitorChecks } from './checks.js';
import { alertSecrets, redactAlert } from './alerts.js';

const say = (line: string): void => { console.log(line); };
const MANUAL_BACKUP_LOCK_WAIT = 2 * 60e3;
const complain = (line: string): void => { console.error(line); };

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
