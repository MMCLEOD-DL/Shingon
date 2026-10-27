// test/helpers/stubDocker.js
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeStubCli } from './stubCli.js';

// A fake `docker` that logs its arguments (one line of text in <logFile>, one JSON array per call in <logFile>.json)
// and prints canned text for ps, volume ls and network ls. `run … init … --out /out/.env` writes a minimal .env into
// the host side of the `-v …:/out` mount, as the foundation's `ops init` would; `compose … exec` prints `seed`.
export function stubDockerPath(dir, { ps = '', volumes = '', networks = '', seed = '' } = {}) {
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'docker.log');
  writeStubCli(dir, 'docker', `
const fs = require('node:fs');
const path = require('node:path');
fs.appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');
fs.appendFileSync(${JSON.stringify(`${logFile}.json`)}, JSON.stringify(args) + '\\n');
const out = { ps: ${JSON.stringify(ps)}, volume: ${JSON.stringify(volumes)}, network: ${JSON.stringify(networks)}, seed: ${JSON.stringify(seed)} };
// Like the real commands, compose exec and run read stdin: a script fed to bash -s loses its remaining lines
// unless the call has </dev/null.
const drain = () => { try { fs.readFileSync(0); } catch { /* no stdin */ } };
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === 'ps') process.stdout.write(out.ps);
else if (args[0] === 'volume' && args[1] === 'ls') process.stdout.write(out.volume);
else if (args[0] === 'network' && args[1] === 'ls') process.stdout.write(out.network);
else if (args[0] === 'run' && args.includes('init') && after('--out') === '/out/.env') {
  drain();
  const mount = after('-v') || '';
  const host = mount.slice(0, mount.lastIndexOf(':/out'));
  fs.mkdirSync(host, { recursive: true });
  fs.writeFileSync(path.join(host, '.env'), 'CLIENT_LABEL=' + after('--client') + '\\n# APP_TAG=\\nINSTANCE_MODE=demo\\n', { mode: 0o600 });
}
else if (args[0] === 'compose' && args.includes('exec')) { drain(); process.stdout.write(out.seed); }
`);
  return { binDir: dir, logFile };
}

// A fake `hostname` whose -I prints the given addresses.
export function stubHostname(binDir, addresses) {
  return writeStubCli(binDir, 'hostname', `process.stdout.write(${JSON.stringify(`${addresses}\n`)});`);
}

// A fake `curl` that prints body and exits 0.
export function stubCurl(binDir, body = '{"status":"ok"}') {
  return writeStubCli(binDir, 'curl', `process.stdout.write(${JSON.stringify(body)});`);
}
