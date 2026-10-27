// src/council/evidence.js
// The evidence stage (Plan 9 Task 6): everything the project members measure, gathered once per round
// before any member runs, and saved by commit in the council's state. This is the only code in a round
// that reads Plan 8's reports, runs gates or touches a machine.
//  - Plan 8's checks for the same commit are reused (Contract 7.7, index Ruling 5);
//  - the council's own gates run locally only for what is missing, and for the axe pass (Task 4);
//  - the reliability smoke runs on one machine, acquired with purpose 'council', always cleaned and released (Task 5).
import { readFileSync, lstatSync, realpathSync, mkdirSync, rmSync, cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { detectAxe, runGates, readScreenshots, parseVitestJson, parsePlaywrightJson, parseCrossingJson, GATE_STEPS } from './gates.js';
import { pushCommit, runSmoke, cleanSmoke, SmokeError } from './smoke.js';
import { git } from '../workspace.js';
import { redact } from '../secrets.js';

const NO_MACHINE = 'No test machine is set up (factory.machines in the config), so the reliability test did not run.';
const SMOKE_TIMEOUT = 'The reliability test took longer than the time allowed.';
const PAGES_UNREAD = 'Conductor could not read the page check results, so the pages were not proven.';
const A11Y_UNREAD = 'Conductor could not read the accessibility scan results, so accessibility was not proven.';
const VERIFY_STEPS = ['lint', 'typecheck', 'licences', 'vitest'];
const SHOTS = path.join('reports', 'screenshots');

// A thrown error as a plain clause (no trailing full stop), redacted.
const plain = (e) => redact(String(e?.message ?? e ?? 'unknown error')).trim().replace(/\.+$/, '');
const join = (...notes) => notes.filter(Boolean).join(' ') || null;
const cleanupNote = (id, reason) => `The test machine ${id} could not be fully cleaned up (${reason}); the next run cleans it first.`;

// ---------- Plan 8's checks ----------

const REPORT_NAMES = { 'vitest.json': 'vitest', 'playwright.json': 'playwright', 'crossing.json': 'crossing', screenshots: 'screenshots' };

// The only place the report names live (index A3): Plan 8 Task 6 writes them to builds/<runId>/reports/.
export function reportFiles(checks) {
  const out = { vitest: null, playwright: null, crossing: null, screenshots: null };
  for (const p of Array.isArray(checks?.reports) ? checks.reports : []) {
    if (typeof p !== 'string') continue;
    const key = REPORT_NAMES[path.basename(p)];
    if (key && out[key] === null) out[key] = p;
  }
  return out;
}

function readReport(file, parse) {
  if (!file) return null;
  try { return parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function isRealDir(p) {
  try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; }
}

// What of Plan 8's checks counts as evidence. A report that is missing or does not parse counts as missing, never as a pass.
export function reuseChecks(checks) {
  const files = reportFiles(checks);
  const tests = readReport(files.vitest, parseVitestJson);
  const v = checks?.verify;
  // `npm run verify` chains its steps with &&, so a present vitest report means lint, types and licences passed.
  const verify = v && (v.status === 'failed' || (v.status === 'passed' && tests)) ? v : null;
  return {
    verify,
    tests: verify ? tests : null,
    browser: readReport(files.playwright, parsePlaywrightJson),
    crossing: readReport(files.crossing, parseCrossingJson),
    screenshotsDir: files.screenshots && isRealDir(files.screenshots) ? files.screenshots : null,
  };
}

// Plan 8 copies its reports into builds/<runId>/reports/; anything outside the build folder counts as missing.
function reportsInside(reports, buildDir) {
  let root;
  try { root = realpathSync(buildDir); } catch { return []; }
  return (Array.isArray(reports) ? reports : []).filter((p) => {
    try { return realpathSync(p).startsWith(root + path.sep); } catch { return false; }
  });
}

// ---------- merging the reused parts with the council's own run ----------

// own: a GatesResult from runGates, or null when the council's own gates did not run. Own results win where their step ran.
export function mergeGates(reused, own) {
  const steps = own?.steps ?? Object.fromEntries(GATE_STEPS.map((s) => [s, null]));
  const ran = (s) => own != null && steps[s] !== null;
  const ownVerify = !reused.verify && (ran('npm-ci') || VERIFY_STEPS.some(ran));
  const ownA11y = own != null && own.axe?.status === 'ok' && (ran('a11y') || ran('browser'));
  let note = own?.note ?? null;
  // Ruling R20: a step that exits 0 but leaves no report is "could not read", never clean.
  if (ran('browser') && steps.browser === 0 && own.browser == null) note = join(note, PAGES_UNREAD);
  if (ownA11y && (steps.a11y === 0 || steps.browser === 0) && own.a11y == null) note = join(note, A11Y_UNREAD);
  return {
    steps,
    verify: reused.verify ?? null,
    tests: ran('vitest') ? own.tests : (reused.verify ? reused.tests : null),
    browser: ran('browser') ? own.browser : reused.browser,
    a11y: own?.a11y ?? null,
    crossing: own?.crossing ?? reused.crossing ?? null,
    screenshots: ran('browser') ? own.screenshots : [],
    logs: own?.logs ?? {},
    axe: own?.axe ?? null,
    note,
    source: {
      verify: reused.verify ? 'build' : (ownVerify ? 'council' : null),
      browser: ran('browser') ? 'council' : (reused.browser ? 'build' : null),
      a11y: ownA11y ? 'council' : null,
    },
  };
}

// ---------- screenshots ----------

// Replaces `to` with a copy of `from`, skipping symlinks. True when something was copied.
function copyShots(from, to) {
  if (!from || !isRealDir(from)) return false;
  try {
    rmSync(to, { recursive: true, force: true });
    mkdirSync(path.dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, filter: (src) => { try { return !lstatSync(src).isSymbolicLink(); } catch { return false; } } });
    return true;
  } catch { return false; }
}

// The screenshots in the workspace, relative to it: from the manifest, else every image file.
function listShots(dir) {
  const listed = readScreenshots(dir);
  if (listed.length) return listed;
  let names = [];
  try { names = readdirSync(path.join(dir, SHOTS)); } catch { /* none */ }
  return names.filter((n) => /\.(png|jpe?g)$/i.test(n) && !n.startsWith('.'))
    .map((n) => ({ page: null, project: null, file: `reports/screenshots/${n}` }));
}

// ---------- the smoke ----------

async function machineProvider(project, deps) {
  const machines = project.factory?.machines ?? {};
  try {
    // Ruling R15: machines.sshBin / scpBin are honoured.
    const ssh = deps.createSsh ? deps.createSsh(machines) : (await import('../factory/ssh.js')).createSsh(machines);
    const get = deps.getMachineProvider ?? (await import('../factory/machines/index.js')).getMachineProvider;
    return { ssh, provider: (await get(project.factory, { ssh })) ?? null, note: null };
  } catch (e) {
    return { ssh: null, provider: null, note: `${plain(e)}.` };
  }
}

async function smokeStage({ ctx, project, head, deps, emit }) {
  const out = { smoke: null, smokeStatus: 'missing', smokeNote: NO_MACHINE, machine: null };
  const { ssh, provider, note } = await machineProvider(project, deps);
  if (!provider) { out.smokeNote = join(NO_MACHINE, note); return out; }

  emit('acquire', 'start');
  let machine;
  try {
    machine = await provider.acquire({ purpose: 'council', projectSlug: project.slug, runId: project.runId });
  } catch (e) {
    // A MachineError 'busy' (a preview holds the static host) reads the same way, with Plan 8's plain message.
    emit('acquire', 'error');
    return { ...out, smokeStatus: 'error', smokeNote: `The test machine could not be started (${plain(e)}).` };
  }
  const id = machine.id;
  emit('acquire', 'ok', id);
  out.machine = id;
  const notes = [];
  const timeoutMs = ctx.options?.councilSmokeTimeoutMs ?? 2_400_000;
  const remoteDir = `${machine.runDir}/smoke-app`;
  let stage = 'push';
  try {
    emit('push', 'start', id);
    await pushCommit({ ssh, machine, dir: ctx.ws.dir, sha: head, remoteDir, timeoutMs });
    emit('push', 'ok', id);
    stage = 'smoke';
    emit('smoke', 'start', id);
    out.smoke = await runSmoke({ ssh, machine, remoteDir, timeoutMs });
    emit('smoke', 'ok', id);
    out.smokeStatus = 'ran';
  } catch (e) {
    emit(stage, 'error', id);
    out.smoke = null;
    out.smokeStatus = 'error';
    if (e instanceof SmokeError) notes.push(e.kind === 'timeout' ? SMOKE_TIMEOUT : redact(e.message));
    else notes.push(`The reliability test could not run (${plain(e)}).`);
  } finally {
    // Ruling R21: clean-up and release always run, each in its own try.
    try {
      const problem = await cleanSmoke({ ssh, machine, remoteDir });
      if (problem) {
        notes.push(redact(problem).replace(/\.\s*$/, '; the next run cleans it first.'));
        emit('cleanup', 'error', id);
      } else emit('cleanup', 'ok', id);
    } catch (e) {
      notes.push(cleanupNote(id, plain(e)));
      emit('cleanup', 'error', id);
    }
    try {
      await machine.release();
      emit('release', 'ok', id);
    } catch (e) {
      notes.push(cleanupNote(id, plain(e)));
      emit('release', 'error', id);
    }
  }
  out.smokeNote = join(...notes);
  return out;
}

// ---------- the stage ----------

// Ruling R7: gate output (node_modules, .council/, reports) must not flood the later scanners; the screenshots stay.
async function cleanWorkspace(dir) {
  try { await git(dir, ['clean', '-ffdx', '-q', '-e', '/reports/screenshots/']); } catch { /* best effort */ }
}

export async function collectEvidence(ctx, { project, head, round, deps = {} }) {
  const { ws, log, state, options = {} } = ctx;
  const emit = (stage, status, machine = null) => log.event('council-evidence', { stage, status, machine });
  const wsShots = path.join(ws.dir, SHOTS);
  state.council ??= {};
  try {
    const saved = state.council.evidence;
    if (saved && saved.sha === head && saved.value) {
      emit('cached', 'ok');
      // Ruling R6: the Design reviewer opens the screenshots in the (new) workspace.
      if (saved.value.shotsDir) copyShots(saved.value.shotsDir, wsShots);
      return saved.value;
    }

    // Plan 8's checks for this commit.
    const checks = project.checks ? { ...project.checks, reports: reportsInside(project.checks.reports, project.buildDir) } : null;
    const reused = reuseChecks(checks);
    if (checks) emit('reuse', 'ok');

    // Own gates, only for what is missing, and the axe pass.
    const axe = detectAxe({ options });
    const need = { verify: !reused.verify, browser: !reused.browser };
    let own = null;
    let gatesNote = null;
    if (need.verify || need.browser || axe.status === 'ok') {
      emit('gates', 'start');
      try {
        const r = await runGates({ dir: ws.dir, axe, need, options, run: deps.run, home: deps.home, helpers: deps.helpers });
        if (r.problem) { gatesNote = r.problem; emit('gates', 'error'); } else { own = r; emit('gates', 'ok'); }
      } catch (e) {
        gatesNote = `The council's own checks could not run (${plain(e)}).`;
        emit('gates', 'error');
      }
    }
    let gates = null;
    if (own || reused.verify || reused.browser || reused.crossing) {
      gates = mergeGates(reused, own);
      gates.axe ??= axe;
      if (own) gatesNote = gates.note;
    }

    // Screenshots, after the gates (Ruling R8: the foundation's global set-up deletes reports/screenshots).
    if (gates && gates.source.browser === 'build' && reused.screenshotsDir && copyShots(reused.screenshotsDir, wsShots)) {
      gates.screenshots = listShots(ws.dir);
    }
    let shotsDir = null;
    if (gates?.screenshots?.length) {
      const to = path.join(project.buildDir, 'council', `round-${round}`, 'screenshots');
      if (copyShots(wsShots, to)) shotsDir = to;
    }

    const smoke = await smokeStage({ ctx, project, head, deps, emit });
    const value = { gates, gatesNote, ...smoke, shotsDir };
    state.council.evidence = { sha: head, value };
    log.saveState(state);
    return value;
  } finally {
    await cleanWorkspace(ws.dir);
  }
}
