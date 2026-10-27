// test/helpers/stubDocker.js
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { writeStubCli } from './stubCli.js';

// A fake `docker` that logs its arguments and prints canned text for ps, volume ls and network ls.
export function stubDockerPath(dir, { ps = '', volumes = '', networks = '' } = {}) {
  mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, 'docker.log');
  writeStubCli(dir, 'docker', `
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(logFile)}, args.join(' ') + '\\n');
const out = { ps: ${JSON.stringify(ps)}, volume: ${JSON.stringify(volumes)}, network: ${JSON.stringify(networks)} };
if (args[0] === 'ps') process.stdout.write(out.ps);
else if (args[0] === 'volume' && args[1] === 'ls') process.stdout.write(out.volume);
else if (args[0] === 'network' && args[1] === 'ls') process.stdout.write(out.network);
`);
  return { binDir: dir, logFile };
}
