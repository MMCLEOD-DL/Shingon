// test/helpers/councilFull.js
// Fakes for the full council (Plan 9). Nothing here runs a real npm, browser, database or machine.
import { cpSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const FIXTURES = new URL('../fixtures/council-full/', import.meta.url).pathname;

function stepOf(command) {
  if (command.includes('npm ci')) return 'npm-ci';
  if (command.includes('npm run lint')) return 'lint';
  if (command.includes('npm run typecheck')) return 'typecheck';
  if (command.includes('npm run licences')) return 'licences';
  if (command.includes('vitest run')) return 'vitest';
  if (command.includes('tsc -b packages/shared')) return 'build';
  if (command.includes('playwright test')) return command.includes('--project=council-a11y-') ? 'a11y' : 'browser';
  throw new Error(`fakeGatesRun: unknown command ${command}`);
}

// codes: exit code per step (default 0). timeout: a step name that runs out of time.
// Each call is { step, args, env }; the fixture reports are copied where the real command writes them.
export function fakeGatesRun({ codes = {}, fixtures = 'gates-out', timeout = null } = {}) {
  const calls = [];
  const src = path.join(FIXTURES, fixtures);
  const copy = (from, to) => { if (existsSync(path.join(src, from))) { mkdirSync(path.dirname(to), { recursive: true }); cpSync(path.join(src, from), to, { recursive: true }); } };
  const run = async ({ args, cwd, env }) => {
    const step = stepOf(args.at(-1));
    calls.push({ step, args, env });
    if (timeout === step) return { stdout: '', stderr: '', code: -1, timedOut: true };
    const code = codes[step] ?? 0;
    const out = path.join(cwd, '.council', 'out');
    if (step === 'vitest') {
      copy('vitest.json', path.join(out, 'vitest.json'));
      copy('crossing.json', path.join(cwd, 'apps', 'server', 'reports', 'crossing.json'));
    }
    if (step === 'browser') {
      copy('playwright.json', path.join(out, 'playwright.json'));
      copy('a11y.jsonl', path.join(out, 'a11y.jsonl'));
      copy('screenshots', path.join(cwd, 'reports', 'screenshots'));
    }
    if (step === 'a11y') copy('a11y.jsonl', path.join(out, 'a11y.jsonl'));
    const stdout = step === 'vitest' && code !== 0 && existsSync(path.join(src, 'vitest.log')) ? readFileSync(path.join(src, 'vitest.log'), 'utf8') : '';
    return { stdout, stderr: '', code, timedOut: false };
  };
  return { run, calls };
}

// A fake machine (Plan 8 Machine shape). `released` counts release() calls.
export function fakeMachine(over = {}) {
  const m = {
    id: 'ct111', name: 'ct111', host: '192.168.1.111', runDir: '/srv/hf-factory/runs/acme-r1',
    ssh: { user: 'factory', keyPath: '/keys/id', knownHostsFile: null, hostKeyPolicy: 'yes' },
    released: 0,
    async release() { m.released += 1; },
    ...over,
  };
  return m;
}

// A fake machine provider: acquire() hands out `machine`, release errors are thrown on demand
// (by machine.release() as well as provider.release(), since callers release through the Machine).
export function fakeProvider({ machine = fakeMachine(), acquireError = null, releaseError = null } = {}) {
  const calls = [];
  if (releaseError) machine.release = async () => { machine.released += 1; throw releaseError; };
  const provider = {
    async acquire(opts) {
      calls.push({ kind: 'acquire', opts });
      if (acquireError) throw acquireError;
      return machine;
    },
    async release(m) {
      calls.push({ kind: 'release', machine: m });
      if (releaseError) throw releaseError;
      return machine.release();
    },
  };
  return { provider, calls };
}

// A fake ssh helper (Plan 8 createSsh shape). A route is { match (string or RegExp, tested against the script for
// exec and the remote path for upload), stdout, stderr, code, once }. Unmatched calls succeed with empty output.
export function fakeSsh(routes = []) {
  const calls = [];
  const live = routes.map((r) => ({ stdout: '', stderr: '', code: 0, once: false, ...r, used: false }));
  const answer = (text) => {
    const r = live.find((x) => !(x.once && x.used) && (x.match instanceof RegExp ? x.match.test(text) : text.includes(x.match)));
    if (!r) return { code: 0, stdout: '', stderr: '' };
    r.used = true;
    return { code: r.code, stdout: r.stdout, stderr: r.stderr };
  };
  const ssh = {
    async exec(machine, script) { calls.push({ kind: 'exec', machine, script }); return answer(script); },
    async upload(machine, localFile, remotePath) {
      let bytes = null;
      try { bytes = statSync(localFile).size; } catch { /* already gone */ }
      calls.push({ kind: 'upload', machine, localFile, remotePath, bytes });
      return answer(remotePath);
    },
  };
  return { ssh, calls };
}
