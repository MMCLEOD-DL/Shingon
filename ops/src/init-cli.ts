import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { generateEnv } from './init.js';

export const USAGE = [
  'Usage: ops <command>',
  '',
  'Commands:',
  '  init --client <name> --origin <web address> --site <address> --dir <bundle folder> [--tunnel] [--demo] [--out <file>]',
  '      Makes a new .env with strong random secrets and prints a checklist.',
  '      --out .env     writes the file (readable only by its owner) and refuses to overwrite an existing one.',
  '      Without --out the settings go to standard output, which must be redirected to a file, then protected:',
  '        ops init ... > .env && chmod 600 .env',
  '      --tunnel       the box is reached through the outbound tunnel (sets SITE_ADDRESS to :80).',
  '  backup',
  '      Takes an encrypted backup now (database, uploads and a record of what they hold).',
  '  restore-test',
  '      Restores the newest backup into a scratch database and checks that everything came back.',
  '  restore <backup id | latest> --yes-replace-live-data',
  '      Puts a backup back over the live data, after taking a safety backup. Stop the app first.',
  '  check',
  '      Runs the health checks now (the app, disk space, the tunnel, backup and settings problems): one line each, exit 1 if any fail.',
  '  check-edge',
  '      Checks that TUNNEL_IP is a usable address inside EDGE_SUBNET (the edge-check service runs this before the front door starts).',
  '  update --to <version> [--image-file <file>]',
  '      Updates the app safely (run it in the updater: docker compose run --rm updater update --to 0.1.1). Stops the app and',
  '      the monitor, takes a backup, switches version, updates the database and checks health; undoes it all if anything fails.',
  '      --image-file   loads the new images from a file made with docker save, kept in the bundle folder.',
  '  update --status',
  '      Shows the last 5 updates.',
  '  update --mark-recovered',
  '      After recovering by hand from a failed update whose undo also failed, clears the standing alert.',
  '  daemon',
  '      Runs the scheduled backups, restore tests, audit-log tidy-up and health checks with alerts (the ops service does this).',
].join('\n');

export interface InitIo {
  stdoutIsTTY: boolean;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Writes a new file readable only by its owner; throws if it already exists. */
  writeNew: (file: string, text: string) => void;
}

export const realIo: InitIo = {
  stdoutIsTTY: process.stdout.isTTY,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  writeNew: (file, text) => { writeFileSync(file, text, { flag: 'wx', mode: 0o600 }); },
};

export function runInit(args: string[], io: InitIo): number {
  let v;
  try {
    ({ values: v } = parseArgs({
      args,
      strict: true,
      options: {
        client: { type: 'string' }, origin: { type: 'string' }, site: { type: 'string' }, dir: { type: 'string' },
        demo: { type: 'boolean' }, tunnel: { type: 'boolean' }, out: { type: 'string' },
      },
    }));
  } catch {
    io.stderr(USAGE + '\n');
    return 2;
  }
  const tunnel = v.tunnel === true;
  if (v.client === undefined || v.origin === undefined || v.dir === undefined || (v.site === undefined && !tunnel)) {
    io.stderr('init needs --client, --origin, --dir and --site (--site is not needed with --tunnel).\n\n' + USAGE + '\n');
    return 2;
  }
  if (!v.dir.startsWith('/')) {
    io.stderr('--dir must be the full path of the bundle folder, starting with /.\n');
    return 2;
  }
  // The settings hold passwords. Never print them to a screen, where they would sit in scrollback and screen recordings.
  if (v.out === undefined && io.stdoutIsTTY) {
    io.stderr('These settings contain secrets, so they are not shown on screen. Send them to a file: add --out .env, or use  > .env  and then run  chmod 600 .env\n');
    return 2;
  }
  let made;
  try {
    made = generateEnv({ client: v.client, origin: v.origin, siteAddress: v.site ?? ':80', bundleDir: v.dir, mode: v.demo === true ? 'demo' : 'production', tunnel });
  } catch (e) {
    io.stderr((e instanceof Error ? e.message : 'The settings file could not be made.') + '\n');
    return 2;
  }
  if (v.out !== undefined) {
    try {
      io.writeNew(v.out, made.env);
    } catch (e) {
      const code = (e as { code?: unknown } | null)?.code;
      io.stderr(code === 'EEXIST'
        ? `${v.out} already exists, so it has not been touched. Move it away or choose another name.\n`
        : `${v.out} could not be written. Check the folder exists and that you may write to it.\n`);
      return 1;
    }
    io.stderr(made.checklist);
    return 0;
  }
  io.stdout(made.env);
  io.stderr(made.checklist + '\n0. Run chmod 600 .env now (or wherever you saved it): it holds secrets and must be readable only by you.\n');
  return 0;
}
