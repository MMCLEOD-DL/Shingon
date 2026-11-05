// P08 batch review (Claude, 5 Nov 2026): which `codex --version` outputs does the PR79 local-agent guard accept?
//   node p08-batch-version-guard.mjs <conductor dir>
// Uses performProbe's installation check with a stubbed command: nothing is executed and no model is called.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const dir = path.resolve(process.argv[2] ?? '.');
const { performProbe } = await import(pathToFileURL(path.join(dir, 'src/service/probe-worker.js')).href);
const cases = ['codex-cli 0.163.0', 'codex-cli 0.163.0\n', 'codex-cli 0.162.9', 'codex-cli 1.0.0', 'OpenAI Codex v0.170.1', 'codex 0.163.0+build.7',
  'codex-cli 0.163.0-alpha.2', 'codex-cli 0.0163.0', 'WARNING: PATH not updated\ncodex-cli 0.164.0', 'codex-cli 0.122.0'];
for (const stdout of cases) {
  const r = await performProbe({ participant: { name: 'local', adapter: { kind: 'local-agent', bin: 'codex' } }, kind: 'installation',
    command: async () => ({ code: 0, stdout, stderr: '', timedOut: false }) });
  console.log(JSON.stringify(stdout).padEnd(46), r.reason === 'version-skew' ? 'refused (version-skew)' : `accepted (${r.executable})`);
}
