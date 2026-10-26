import { parseArgs } from 'node:util';
import { generateEnv } from './init.js';

const USAGE = [
  'Usage: ops <command>',
  '',
  'Commands:',
  '  init --client <name> --origin <web address> --site <address> --dir <bundle folder> [--demo]',
  '      Writes a new .env to standard output and a checklist to standard error, so this works:',
  '      ops init --client "Acme Ltd" --origin https://app.acme.co.uk --site app.acme.co.uk --dir /opt/highland/acme > .env',
].join('\n');

function init(args: string[]): number {
  let v;
  try {
    ({ values: v } = parseArgs({
      args,
      strict: true,
      options: {
        client: { type: 'string' }, origin: { type: 'string' }, site: { type: 'string' }, dir: { type: 'string' }, demo: { type: 'boolean' },
      },
    }));
  } catch {
    console.error(USAGE);
    return 2;
  }
  if (v.client === undefined || v.origin === undefined || v.site === undefined || v.dir === undefined) {
    console.error('init needs --client, --origin, --site and --dir.\n\n' + USAGE);
    return 2;
  }
  if (!/^https?:\/\/[^\s/]+/.test(v.origin)) {
    console.error('--origin must be a web address such as https://app.client.co.uk (or http://... on a LAN without HTTPS).');
    return 2;
  }
  if (!v.dir.startsWith('/')) {
    console.error('--dir must be the full path of the bundle folder, starting with /.');
    return 2;
  }
  try {
    const { env, checklist } = generateEnv({ client: v.client, origin: v.origin, siteAddress: v.site, bundleDir: v.dir, mode: v.demo === true ? 'demo' : 'production' });
    process.stdout.write(env);
    process.stderr.write(checklist);
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'The settings file could not be made.');
    return 2;
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'init') process.exitCode = init(rest);
else {
  console.error(command === undefined ? USAGE : `"${command}" is not an ops command yet.\n\n${USAGE}`);
  process.exitCode = 2;
}
