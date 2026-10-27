// The reliability evidence (Plan 9 Task 5): the app's own copy of the foundation's deploy/smoke/run-smoke.sh (v0.1.0)
// run on a factory machine. Conductor pushes the reviewed commit, runs the script, parses its log and cleans up.
// Every remote value is validated with assertSafe and quoted with shQuote; ssh is always passed in.
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git } from '../workspace.js';
import { shQuote, assertSafe } from '../factory/remote.js';
import { redact } from '../secrets.js';
import { clip } from '../text.js';

export const SMOKE_STEPS = {
  1: 'build the app images',
  2: 'start the backup server and the alert catcher',
  3: 'install the bundle with ops init',
  4: 'start the app and load the demo data',
  5: 'back up, then test a restore',
  6: 'run every health check',
  '6a': 'restore over the live data, then upload a file',
  7: 'stop the app: an alert is sent, then Fixed',
  8: 'update, then undo a broken update automatically',
  9: 'back up and test a restore after the rollback',
  secrets: 'no secret in the alerts or logs',
  10: 'tear down',
};

export class SmokeError extends Error {
  // kind: unreachable | timeout | failed
  constructor(kind, message) {
    super(message);
    this.name = 'SmokeError';
    this.kind = kind;
  }
}

const asset = (name) => readFileSync(new URL(`./assets/${name}`, import.meta.url), 'utf8');
const unreachable = (host) => new SmokeError('unreachable', `Conductor could not reach the test machine ${host} over SSH.`);
const copyFailed = (host) => new SmokeError('failed', `The app could not be copied to the test machine ${host}.`);

export async function pushCommit({ ssh, machine, dir, sha, remoteDir, timeoutMs }) {
  assertSafe('path', remoteDir);
  if (!/^[0-9a-f]{7,64}$/.test(String(sha))) throw copyFailed(machine.host);
  const tmp = mkdtempSync(path.join(tmpdir(), 'council-smoke-'));
  try {
    const tar = path.join(tmp, 'app.tar');
    const a = await git(dir, ['archive', '--format=tar', '-o', tar, sha]);
    if (a.code !== 0) throw copyFailed(machine.host);
    const up = await ssh.upload(machine, tar, `${remoteDir}.tar`, { timeoutMs });
    if (up.code === 255) throw unreachable(machine.host);
    if (up.code !== 0) throw copyFailed(machine.host);
    const d = shQuote(remoteDir);
    const t = shQuote(`${remoteDir}.tar`);
    const ex = await ssh.exec(machine, `set -euo pipefail\nmkdir -p ${d} && tar -x -C ${d} -f ${t} && rm -f ${t}\n`, { timeoutMs });
    if (ex.code === 255) throw unreachable(machine.host);
    if (ex.code !== 0) throw copyFailed(machine.host);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const CLIP = 8000;
const firstLine = (t) => redact(String(t ?? '')).split('\n').find((l) => l.trim())?.trim() ?? '';
const STEP_RE = /^== Step (\d+[a-z]?):/;
const TITLES = new Map(Object.entries(SMOKE_STEPS));

export function parseSmokeLog(text, code, { timedOut = false, stderr = '' } = {}) {
  const lines = String(text ?? '').split('\n').map((l) => l.replace(/\r$/, ''));
  const steps = [];
  let open = null;
  let failure = null;
  let failedStep = null;
  let sawPassed = false;
  const begin = (n) => { open = { n, title: TITLES.get(n) ?? n, ok: false }; steps.push(open); };
  for (const line of lines) {
    const s = STEP_RE.exec(line);
    if (s) { begin(s[1]); continue; }
    if (line.startsWith('== Secrets:')) { begin('secrets'); continue; }
    if (line.startsWith('   ok:')) { if (open) open.ok = true; continue; }
    const f = /^ {3}FAILED: (.*)$/.exec(line);
    if (f) { failure ??= f[1]; continue; }
    const d = /^SMOKE FAILED during: (?:step (\d+[a-z]?)\b|(secrets) check)/.exec(line);
    if (d) { failedStep ??= d[1] ?? d[2]; continue; }
    if (line.startsWith('SMOKE PASSED')) sawPassed = true;
  }
  const passed = code === 0 && sawPassed && !timedOut;
  let refused = null;
  if (!passed && code === 2 && steps.length === 0 && !timedOut) refused = lines.find((l) => l.trim() !== '') ?? null;
  if (!passed && !refused) {
    if (failedStep === null) {
      const real = steps.filter((x) => x.n !== '10');
      failedStep = (real.at(-1) ?? steps.at(-1))?.n ?? null;
    }
    if (failure === null) {
      failure = timedOut ? 'the smoke ran out of time'
        : steps.length === 0 ? `the smoke stopped before its first step (exit code ${code})${firstLine(stderr) ? `: ${firstLine(stderr)}` : ''}`
          : `the step stopped without saying why (exit code ${code})`;
    }
  }
  if (refused) { failedStep = null; failure = null; }
  return {
    ran: !refused, passed, steps, failedStep, failure, refused, timedOut, code,
    tail: clip(redact(lines.slice(-40).join('\n')), CLIP),
  };
}

const lastMatch = (text, re) => [...text.matchAll(re)].at(-1) ?? null;
const EXIT_RE = /^COUNCIL-SMOKE-EXIT (\d+)\s*$/gm;
const REFUSED_RE = /^COUNCIL-REFUSED (.+)$/gm;

export async function runSmoke({ ssh, machine, remoteDir, timeoutMs }) {
  assertSafe('path', remoteDir);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error(`runSmoke needs timeoutMs as a positive whole number of milliseconds, got ${JSON.stringify(timeoutMs)}.`);
  const seconds = Math.max(60, Math.floor((timeoutMs - 300000) / 1000));
  const script = `export ROOT=${shQuote(remoteDir)}\nexport SMOKE_SECONDS=${shQuote(String(seconds))}\n${asset('smoke-clean.sh')}\n${asset('smoke.sh')}`;
  const r = await ssh.exec(machine, script, { timeoutMs });
  if (r.code === 255) throw unreachable(machine.host);
  const out = r.stdout ?? '';
  const refusal = lastMatch(out, REFUSED_RE);
  if (refusal) {
    return { ran: false, passed: false, steps: [], failedStep: null, failure: null, refused: refusal[1].trim(), timedOut: false, code: r.code, tail: clip(redact(out), 2000) };
  }
  const m = lastMatch(out, EXIT_RE);
  const code = m ? Number(m[1]) : r.code;
  return parseSmokeLog(out, code, { timedOut: r.code === -1 || code === 124, stderr: r.stderr });
}

export async function cleanSmoke({ ssh, machine, remoteDir }) {
  assertSafe('path', machine.runDir);
  if (machine.runDir === '/') throw new Error(`The machine's run folder ${machine.runDir} is not a usable folder.`);
  if (typeof remoteDir !== 'string' || !remoteDir.startsWith(`${machine.runDir}/`) || remoteDir.split('/').includes('..')) {
    throw new Error(`The clean-up path ${remoteDir} is outside the machine's run folder.`);
  }
  assertSafe('path', remoteDir);
  const r = await ssh.exec(machine, `${asset('smoke-clean.sh')}\nrm -rf ${shQuote(remoteDir)}\n`, { timeoutMs: 120000 });
  if (r.code === 0) return null;
  const first = String(r.stderr ?? '').split('\n').find((l) => l.trim()) ?? `exit code ${r.code}`;
  return `The test machine ${machine.id} could not be fully cleaned up (${first}).`;
}
