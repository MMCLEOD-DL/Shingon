// Two read-only looks at a client box: preflight (before a ship touches anything) and probeBox (status / verify).
// The health token never leaves the box: the version probe runs inside the ops container and reads it from there.
import { remoteRun, sshProblem } from './remote.js';
import { assertSafe, shQuote } from '../remote.js';
import { redact } from '../../secrets.js';
import { terminalText } from '../brief.js';

const MIN_FREE_KB = 4194304;

// Anything kept from a box is stripped of terminal control characters and redacted.
const clean = (s, max = 400) => String(redact(terminalText(s))).slice(0, max);
const firstLine = (s) => clean(String(s ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '', 160).replace(/[.\s]+$/, '');

export function composeCmd(dep, args) {
  const cfg = dep.imageDelivery === 'registry' ? 'DOCKER_CONFIG="$PWD/.docker" ' : '';
  return `cd ${shQuote(assertSafe('path', dep.bundleDir))} && ${cfg}docker compose ${args}`;
}

function preflightScript(bundleDir) {
  return `d=${shQuote(bundleDir)}
echo "arch=$(uname -m)"
if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then echo docker=yes; else echo docker=no; fi
if docker compose version >/dev/null 2>&1; then echo compose=yes; else echo compose=no; fi
for t in setsid sha256sum tar awk mktemp cmp; do command -v "$t" >/dev/null 2>&1 || echo "missing=$t"; done
if [ -d "$d" ]; then echo dir=yes; if [ -w "$d" ]; then echo writable=yes; else echo writable=no; fi; else echo dir=no; fi
[ -f "$d/.env" ] && echo env=yes
[ -f "$d/compose.yaml" ] && echo composefile=yes
p="$d"; while [ ! -d "$p" ]; do p=$(dirname "$p"); done
echo "freekb=$(df -Pk "$p" | awk 'NR==2{print $4}')"
true
`;
}

export async function preflight(t, { bundleDir, env = process.env, timeoutMs = 60000 } = {}) {
  try { assertSafe('path', bundleDir); } catch { return { ok: false, problems: [`The bundle folder "${clean(bundleDir, 80)}" is not a usable path.`], facts: null }; }
  const r = await remoteRun(t, `bash -c ${shQuote(preflightScript(bundleDir))}`, { env, timeoutMs });
  if (r.code !== 0) return { ok: false, problems: [sshProblem(t, r)], facts: null };
  const kv = {};
  const missing = [];
  for (const line of String(r.stdout).split('\n')) {
    const m = /^([a-z]+)=(.*)$/.exec(line.trim());
    if (!m) continue;
    if (m[1] === 'missing') missing.push(m[2]); else kv[m[1]] = m[2];
  }
  const label = t.label;
  const problems = [];
  if (kv.docker !== 'yes') problems.push(`Docker is not working on ${label} for the user ${t.user}. Install Docker Engine, and add ${t.user} to the docker group.`);
  if (kv.compose !== 'yes') problems.push(`The Docker Compose plugin is missing on ${label}.`);
  for (const m of missing) problems.push(`${/^[\w.-]{1,20}$/.test(m) ? m : 'A needed tool'} is missing on ${label}.`);
  if (kv.dir === 'yes' && kv.writable !== 'yes') problems.push(`The bundle folder ${bundleDir} on ${label} is not writable by ${t.user}.`);
  const freeKb = /^\d+$/.test(kv.freekb ?? '') ? Number(kv.freekb) : null;
  if (freeKb === null) problems.push(`${label} did not say how much disk space is free where the bundle folder lives.`);
  else if (freeKb < MIN_FREE_KB) problems.push(`${label} has only ${(freeKb / 1048576).toFixed(1)} GB free where the bundle folder lives; a ship needs at least 4 GB.`);
  return {
    ok: problems.length === 0,
    problems,
    facts: { arch: clean(kv.arch ?? '', 40) || null, freeKb, hasDir: kv.dir === 'yes', hasEnv: kv.env === 'yes', hasCompose: kv.composefile === 'yes' },
  };
}

export const VERSION_PROBE = `
const base = process.env.APP_INTERNAL_URL || 'http://app:3000';
const headers = { 'x-health-token': process.env.HEALTH_TOKEN || '' };
const get = async (p) => { try { const r = await fetch(base + p, { headers, signal: AbortSignal.timeout(5000) }); return await r.json(); } catch { return null; } };
console.log(JSON.stringify({ version: await get('/api/version'), ready: await get('/readyz') }));
`;

export const RUNS_SQL = `select json_build_object(
 'backup', (select json_build_object('at', at, 'ok', ok, 'detail', detail) from ops_runs where kind = 'backup' and not busy order by at desc, id desc limit 1),
 'backupOk', (select at from ops_runs where kind = 'backup' and ok order by at desc, id desc limit 1),
 'restore', (select json_build_object('at', at, 'ok', ok, 'detail', detail) from ops_runs where kind = 'restore-test' and not busy order by at desc, id desc limit 1),
 'restoreOk', (select at from ops_runs where kind = 'restore-test' and ok order by at desc, id desc limit 1))`;

// The last stdout line that starts with "{" and parses; anything else is "no JSON line".
function lastJson(stdout) {
  const lines = String(stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const v = JSON.parse(lines[i]); if (v && typeof v === 'object') return v; } catch { /* try the previous line */ }
  }
  return null;
}

const str = (v) => (typeof v === 'string' || typeof v === 'number' ? clean(v, 120) : null);

export async function probeVersion(t, dep, { env = process.env, timeoutMs = 120000 } = {}) {
  const cmd = composeCmd(dep, 'run --rm --no-deps -T --entrypoint node ops --input-type=module -');
  const r = await remoteRun(t, cmd, { input: VERSION_PROBE, env, timeoutMs });
  if (r.unreachable) return { unreachable: true, version: null, ready: null, problem: sshProblem(t, r) };
  const json = r.code === 0 ? lastJson(r.stdout) : null;
  if (!json) {
    const why = firstLine(r.stderr) || (r.code === 0 ? 'it printed no answer' : `code ${r.code}`);
    return { unreachable: false, version: null, ready: null, problem: `The app's version could not be read on the box (the ops container did not run: ${why}).` };
  }
  const v = json.version && typeof json.version === 'object' ? json.version : null;
  const ready = json.ready && typeof json.ready === 'object' ? str(json.ready.status) : null;
  if (!v) return { unreachable: false, version: null, ready, problem: "The app's version could not be read on the box (the app did not answer /api/version)." };
  return { unreachable: false, version: { app: str(v.app), foundation: str(v.foundation), commit: str(v.commit) }, ready, problem: null };
}

export function BoxStatus(parts = {}) {
  return { reachable: true, problem: null, version: null, ready: null, checks: null, runs: null, notes: [], ...parts };
}

const FOUNDATION_NOTE = 'The box did not give its full version details, so HEALTH_TOKEN may be missing for ops (see RUNBOOK.md, "The app reports a problem, but ops cannot see which").';

function parseRuns(stdout) {
  const j = lastJson(stdout);
  if (!j) return null;
  const run = (x) => (x && typeof x === 'object' ? { at: str(x.at), ok: x.ok === true, detail: clean(x.detail ?? '', 300) } : null);
  const okAt = (at) => (at ? { at: str(at) } : null);
  return { backup: { last: run(j.backup), lastOk: okAt(j.backupOk) }, restoreTest: { last: run(j.restore), lastOk: okAt(j.restoreOk) } };
}

export async function probeBox(t, dep, { env = process.env } = {}) {
  const v = await probeVersion(t, dep, { env });
  if (v.unreachable) return BoxStatus({ reachable: false, problem: v.problem });
  const notes = [];
  if (v.problem) notes.push(v.problem);
  else if (v.version.foundation === null) notes.push(FOUNDATION_NOTE);

  let checks = null;
  const c = await remoteRun(t, composeCmd(dep, 'run --rm --no-deps -T ops check'), { env, timeoutMs: 120000 });
  const marks = String(c.stdout ?? '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('✓ ') || l.startsWith('✗ '));
  if ((c.code === 0 || c.code === 1) && !c.unreachable && (c.code === 0 || marks.length > 0)) {
    checks = { ok: c.code === 0, failing: marks.filter((l) => l.startsWith('✗ ')).map((l) => clean(l.slice(2), 400)) };
  } else notes.push(`The box's own checks could not run (code ${c.code}).`);

  let runs = null;
  const q = await remoteRun(t, composeCmd(dep, `exec -T db psql -U app -d app -At -c ${shQuote(RUNS_SQL)}`), { env, timeoutMs: 60000 });
  if (q.code === 0 && !q.unreachable) runs = parseRuns(q.stdout);
  if (!runs) notes.push('The backup records could not be read (the database may be down).');

  return BoxStatus({ version: v.version, ready: v.ready, checks, runs, notes });
}
