// src/factory/ship/index.js — `conductor ship <project> --to <deployment>` (Contract 5) and updateDeployment, the one way
// Plan 11 touches a box (Contract 7 §7.6). Every refusal comes before anything is touched and all questions come before
// the long build; then the release is found (or the app's first one cut), built on a factory machine, delivered, and
// either set up for the first time or updated through the foundation's own safe update. Each run writes a plain-text
// ship log at <projectDir>/deployments/logs/<name>-<runId>.txt with every line redacted.
import { mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { validateSlug, readProject, loadProject, saveProject } from '../projects.js';
import { loadBrief as realLoadBrief, terminalText } from '../brief.js';
import { factoryConfig } from '../config.js';
import { getMachineProvider } from '../machines/index.js';
import { RUN_ID_RE } from '../ids.js';
import { parseVersion, compareVersions } from '../foundationLog.js';
import { findConfig } from '../../cli/config.js';
import { runCommand } from '../../exec.js';
import { childEnv, redact } from '../../secrets.js';
import { findBin } from '../../council/tools.js';
import { SETUP_STEPS, DeploymentError, loadDeployment, saveDeployment, newDeployment, lockDeployment, addHistory } from '../deployments/store.js';
import { missingTools, targetOf } from './remote.js';
import { preflight } from './probe.js';
import { buildOnMachine, deliverToBox, cleanupBuild } from './build.js';
import { askDeploymentBasics, askSettings, policyProblems } from './setupPlan.js';
import { runFirstSetup } from './firstShip.js';
import { runLaterShip } from './update.js';
import { approvedRelease as realApprovedRelease } from './release.js';
import { SHIP_EXIT, exitFor } from './outcomes.js';

// Contract 4's update outcomes, plus 'refused': stopped before the box was changed, with nothing added to history.
export const UPDATE_OUTCOMES = Object.freeze(['updated', 'rolled-back', 'cancelled', 'already-on', 'busy', 'settings-error', 'urgent', 'lost-contact', 'refused']);

export const NO_TTY_FIRST = 'Setting up a box asks you questions (its address, passwords, and a backup password to save), and there is no terminal, so nothing was done. Run the ship in a terminal.';

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const FOUNDATION_RE = /^v\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const GIT_LOCATION_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE'];
const FIRST_SETUP_EXIT = { installed: SHIP_EXIT.done, stopped: SHIP_EXIT.notDone, partway: SHIP_EXIT.partway };

// Ruling S9: everything bound for the terminal or the ship log loses control characters and secrets.
const clean = (t) => String(redact(terminalText(t)));
const plainVersion = (v) => { const p = parseVersion(v); return p !== null && v === `${p.major}.${p.minor}.${p.patch}`; };
const nameProblem = (name) => (typeof name === 'string' && NAME_RE.test(name)
  ? null : `"${clean(name)}" is not a deployment name: use lower-case letters, digits and dashes.`);
const toolText = (tool) => `Conductor needs ${tool} on this machine, and it is not installed.`;
const busyText = (name) => `Another ship to ${name} is already running.`;
const pendingText = (dep) => `The last update to ${dep.name} (${clean(dep.pendingCheck.version ?? 'unknown version')}) ended without Conductor seeing the result. Run conductor deployments status first; it checks the box and clears this.`;
const olderText = (version, name, current) => `${version} is older than what ${name} runs (${current}). Conductor does not ship older versions.`;
const notReadyText = (name, problems) => `${name} is not ready for a ship:\n${problems.map((p) => `- ${p}`).join('\n')}`;
const unexpected = (e) => clean(e?.message ?? e).split('\n')[0] || 'no reason given';

// The ship log: append-only, one redacted line per call (Ruling S10's named exception to atomic writes).
function shipLog(projectDir, name, runId) {
  const dir = path.join(projectDir, 'deployments', 'logs');
  const file = path.join(dir, `${name}-${runId}.txt`);
  return (line) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(file, `${line}\n`, { mode: 0o644 });
    } catch { /* a log that cannot be written never stops a ship half-way */ }
  };
}

function saver(projectDir, state) {
  return (d) => {
    saveDeployment(projectDir, d);
    state.dep = d;
    return d;
  };
}

// While updating, every save after the first in-progress one records an outcome (Ruling S19). From then on the phase is
// 'finishing', so a later unexpected throw cannot contradict what is already recorded.
function updateSaver(projectDir, state) {
  const save = saver(projectDir, state);
  return (d) => {
    const out = save(d);
    if (d.pendingCheck?.why !== 'in-progress') {
      state.phase = 'finishing';
      state.recorded = d.history.at(-1)?.outcome ?? null;
    }
    return out;
  };
}

// An unexpected throw while updating: the record must say what the caller is told (lost contact, result unknown).
// Best effort: if this cannot be saved, the in-progress check saved before the update started still blocks the next ship.
function saveLostContact(state, text) {
  try {
    const current = loadDeployment(state.projectDir, state.name) ?? state.dep;
    if (!current) return;
    const at = new Date().toISOString();
    const withHistory = addHistory(current, { at, version: state.version, from: current.currentVersion, outcome: 'lost-contact', detail: text.split('\n')[0] });
    saveDeployment(state.projectDir, {
      ...withHistory, pendingCheck: { since: at, version: state.version, foundation: state.foundation, why: 'lost-contact', runId: state.runId },
    });
  } catch { /* see above */ }
}

const stoppedWhileUpdating = (name, e) => `Conductor stopped unexpectedly while updating ${name} (${unexpected(e)}). The update may carry on by itself on the box. Run conductor deployments status to see how it ended.`;
const stoppedAfterUpdate = (name, outcome, e) => `The update to ${name} ended (${outcome}) and is recorded, but Conductor stopped unexpectedly afterwards (${unexpected(e)})${outcome === 'updated' ? ', so the new compose.yaml and Caddyfile may not be in place' : ''}. Run conductor deployments status to check the box.`;

// Build on a factory machine (Ruling S8: the provider is made here, inside a try), check the box can run it, deliver it,
// and always clean the build machine up. Shared by the first-time setup, later ships and updateDeployment.
async function buildAndDeliver({ factory, getProvider, projectDir, slug, dep, rel, facts, runId, say, env, state }) {
  let provider;
  try { provider = getProvider(); } catch (e) { return { ok: false, problem: clean(e?.message ?? e) }; }
  state.phase = 'building';
  const built = await buildOnMachine({
    provider, slug, runId, appDir: path.join(projectDir, 'app'), release: { sha: rel.sha, tag: rel.tag, version: rel.version },
    dep, say, env, buildTimeoutMs: factory.ship.buildTimeoutMs,
  });
  if (!built.ok) return { ok: false, problem: built.problem };
  if (!built.arch || !facts?.arch || built.arch !== facts.arch) {
    await cleanupBuild(built, { env });
    return {
      ok: false,
      problem: built.arch && facts?.arch
        ? `The box is ${facts.arch} but the app was built for ${built.arch}. Conductor cannot ship to this box.`
        : 'Conductor could not tell whether the box and the build machine have the same kind of processor, so it did not ship.',
    };
  }
  state.phase = 'delivering';
  let delivered;
  try {
    delivered = await deliverToBox({ built, target: targetOf(dep), dep, version: rel.version, say, env });
  } finally {
    await cleanupBuild(built, { env });
  }
  if (!delivered.ok) return { ok: false, problem: delivered.problem };
  return { ok: true, images: built.images, imagesFile: delivered.imagesFile };
}

// A later ship: build, deliver (which unpacks .conductor/bundle-<v>/ that refreshBundleFiles reads), then the safe update.
async function deliverAndUpdate({ factory, getProvider, projectDir, slug, dep, rel, foundation, facts, runId, say, env, sleep, state }) {
  const d = await buildAndDeliver({ factory, getProvider, projectDir, slug, dep, rel, facts, runId, say, env, state });
  if (!d.ok) return { outcome: 'refused', text: d.problem };
  state.phase = 'updating';
  const r = await runLaterShip({
    dep, target: targetOf(dep), version: rel.version, foundation, imagesFile: d.imagesFile, runId, say,
    save: updateSaver(projectDir, state), env,
    opts: { updateTimeoutMs: factory.ship.updateTimeoutMs, pollMs: factory.ship.pollMs, ...(sleep ? { sleep } : {}) },
  });
  state.phase = 'done';
  return { outcome: r.outcome, text: r.text };
}

// For Ctrl-C handlers (shipCommand here, Plan 11's change command). Synchronous: the process exits straight after.
export function interruptShip(state = {}) {
  let text = 'Stopped. Steps already finished on the box are recorded; run the same command to carry on.';
  if (state.phase === 'updating') {
    try {
      const name = state.dep?.name ?? state.name;
      const current = loadDeployment(state.projectDir, name) ?? state.dep;
      saveDeployment(state.projectDir, {
        ...current, pendingCheck: { since: new Date().toISOString(), version: state.version, foundation: state.foundation, why: 'interrupted', runId: state.runId },
      });
    } catch { /* the in-progress check saved before the update started still blocks the next ship (Ruling S19) */ }
    text = 'Stopped watching. The update carries on by itself on the box. Run conductor deployments status to see how it ended.';
  }
  try { state.lock?.release(); } catch { /* already gone */ }
  state.lock = null;
  return text;
}

export async function shipProject({ factory, slug, name, ask, env = process.env, runId, sleep, state = {}, deps = {} }) {
  const no = (text) => ({ exit: SHIP_EXIT.notDone, text });
  const slugProblem = validateSlug(slug);
  if (slugProblem) return no(slugProblem);
  const badName = nameProblem(name);
  if (badName) return no(badName);
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return no(`"${clean(runId)}" is not a run id.`);
  let projectDir, project;
  try { ({ dir: projectDir, project } = readProject(factory.projectsRoot, slug)); } catch (e) { return no(e.message); }

  Object.assign(state, { phase: 'checking', projectDir, name, runId, dep: null, lock: null, version: null, foundation: null, recorded: null });
  let lock;
  try { lock = lockDeployment(projectDir, name); } catch (e) { return no(clean(e.message)); }
  if (!lock) return no(busyText(name));
  state.lock = lock;

  const log = shipLog(projectDir, name, runId);
  const say = (t) => { const s = clean(t); ask.say(s); log(s); };
  // sayOnce (the backup password, the first-admin link) goes to the terminal only, never to the log (Ruling S18).
  const shipAsk = { ...ask, say, sayOnce: (t) => ask.sayOnce(t) };
  try {
    const r = await shipSteps({ factory, slug, name, project, projectDir, ask: shipAsk, say, env, runId, sleep, state, deps });
    log(clean(r.text));
    return r;
  } catch (e) {
    let text;
    if (state.phase === 'updating') {
      text = stoppedWhileUpdating(name, e);
      saveLostContact(state, text);
    } else if (state.phase === 'finishing') text = stoppedAfterUpdate(name, state.recorded, e);
    else text = `Conductor stopped unexpectedly (${unexpected(e)}). Steps already finished on the box are recorded; run the same command to carry on.`;
    log(text);
    return { exit: SHIP_EXIT.partway, text };
  } finally {
    lock.release();
    state.lock = null;
  }
}

async function shipSteps({ factory, slug, name, project, projectDir, ask, say, env, runId, sleep, state, deps }) {
  const no = (text) => ({ exit: SHIP_EXIT.notDone, text });
  const loadBrief = deps.loadBrief ?? realLoadBrief;
  const approvedRelease = deps.approvedRelease ?? realApprovedRelease;
  const getProvider = () => deps.provider ?? getMachineProvider(factory, { env });
  const save = saver(projectDir, state);

  const missing = missingTools(['ssh', 'git'], { env });
  if (missing.length) return no(toolText(missing[0]));
  let dep;
  try { dep = loadDeployment(projectDir, name); } catch (e) {
    if (e instanceof DeploymentError) return no(e.message);
    throw e;
  }
  state.dep = dep;
  if (dep?.pendingCheck) return no(pendingText(dep));
  let brief;
  try { brief = await loadBrief(projectDir); } catch (e) { return no(clean(e?.message ?? e)); }

  const firstTime = !dep || dep.setup.step !== 'done';
  // Ruling S18: no terminal → refused before any SSH call, machine or release.
  if (firstTime && !ask.isTTY) return no(NO_TTY_FIRST);

  // Contract 7 §7.5: the foundation a deployment runs comes from project.json, never from the box. Checked before
  // approvedRelease, which may cut the app's first release: every refusal leaves the app repo untouched.
  const foundation = project.foundation?.tag;
  if (typeof foundation !== 'string' || !FOUNDATION_RE.test(foundation)) {
    return no(`The project does not record which foundation release it is built on, so it cannot be shipped. Build it first (conductor build ${slug}).`);
  }
  const rel = await approvedRelease(projectDir, { runId, env });
  if (!rel.ok) return no(rel.problem);
  if (rel.cut) say(`Made the app's first release, v${rel.version}.`);
  if (!firstTime) {
    if (rel.version === dep.currentVersion) return no(`${name} is already on ${rel.version}. There is nothing new to ship.`);
    if (dep.currentVersion && compareVersions(rel.version, dep.currentVersion) < 0) return no(olderText(rel.version, name, dep.currentVersion));
  }
  Object.assign(state, { version: rel.version, foundation });
  say(`Shipping ${rel.version} of ${slug} to ${name} (run ${runId}).`);

  if (!dep) {
    const basics = await askDeploymentBasics(ask, { name, slug, policy: brief.policy, defaults: {} });
    if (!basics) return no('Nothing was changed.');
    try {
      dep = save(newDeployment({ ...basics, name, project: slug, alerts: { matrix: null, webhook: false, heartbeat: false } }));
    } catch (e) {
      if (e instanceof DeploymentError) return no(e.message);
      throw e;
    }
  }
  const policy = policyProblems(brief.policy, dep);
  if (policy.length) return no(policy.join('\n'));
  const pf = await preflight(targetOf(dep), { bundleDir: dep.bundleDir, env });
  if (!pf.ok) return no(notReadyText(name, pf.problems));

  let settings = null;
  if (firstTime && SETUP_STEPS.indexOf(dep.setup.step) < SETUP_STEPS.indexOf('configured')) {
    settings = await askSettings(ask, { dep, policy: brief.policy, defaults: { matrix: factory.alerts.matrix } });
    if (!settings) return no('Nothing was changed on the box.');
  }

  const common = { factory, getProvider, projectDir, slug, dep, rel, facts: pf.facts, runId, say, env, state };
  if (!firstTime) {
    const r = await deliverAndUpdate({ ...common, foundation, sleep });
    return { exit: r.outcome === 'refused' ? SHIP_EXIT.notDone : exitFor(r.outcome), text: r.text };
  }

  const d = await buildAndDeliver(common);
  if (!d.ok) return no(d.problem);
  state.phase = 'setting-up';
  const r = await runFirstSetup({
    dep, brief, target: targetOf(dep), ask, version: rel.version, foundation, images: d.images, imagesFile: d.imagesFile,
    facts: pf.facts, settings, save, env,
    opts: { startTimeoutMs: factory.ship.startTimeoutMs, pollMs: factory.ship.pollMs, ...(sleep ? { sleep } : {}) },
  });
  state.phase = 'done';
  let text = r.text;
  if (r.outcome === 'installed') {
    // Contract 7 §7.5: 'shipped' = at least one deployment installed. Plan 10 is the only plan that installs.
    try {
      const now = loadProject(projectDir);
      if (now.status === 'ready') saveProject(projectDir, { ...now, status: 'shipped' });
    } catch (e) {
      text += `\nNote: the project could not be marked as shipped (${unexpected(e)}).`;
    }
  }
  return { exit: FIRST_SETUP_EXIT[r.outcome] ?? SHIP_EXIT.partway, text };
}

// The release v<version>: its tag exists, is on main, and package.json at it says <version>. null otherwise.
async function releaseOnMain(appDir, version, env) {
  const gitBin = findBin('git', { env });
  if (!gitBin) return null;
  const genv = childEnv({ env });
  for (const k of GIT_LOCATION_ENV) delete genv[k]; // the repo named by -C, never one the caller's env points at
  const git = (args) => runCommand({ cmd: gitBin, args: ['-C', appDir, ...args], env: genv });
  const tag = `v${version}`;
  const r = await git(['rev-parse', '--verify', '-q', `refs/tags/${tag}^{commit}`]);
  const sha = r.code === 0 ? r.stdout.trim() : '';
  if (!SHA_RE.test(sha)) return null;
  if ((await git(['merge-base', '--is-ancestor', sha, 'refs/heads/main'])).code !== 0) return null;
  const pkg = await git(['show', `${sha}:package.json`]);
  if (pkg.code !== 0) return null;
  try { if (JSON.parse(pkg.stdout).version !== version) return null; } catch { return null; }
  return { sha, version, tag };
}

// Ruling S8: the config read the way runFactoryCommand reads it (raw JSON + factoryConfig), so a config with no
// participants is fine.
function defaultFactory(env) {
  const home = env.HOME || homedir();
  let file = null;
  try { file = findConfig({ env, home }); } catch { file = null; }
  let parsed = {};
  if (file) {
    try { parsed = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new Error(`its config file ${file} could not be read (${e.message})`); }
  }
  return factoryConfig({ factory: parsed?.factory }, { env, home });
}

export async function updateDeployment({ projectDir, name, version, foundation, runId } = {},
  { factory, provider, env = process.env, say = () => {}, sleep, state = {} } = {}) {
  const refused = (message) => ({ outcome: 'refused', message });
  const badName = nameProblem(name);
  if (badName) return refused(badName);
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return refused(`"${clean(runId)}" is not a run id, so nothing was done.`);
  if (typeof version !== 'string' || !plainVersion(version)) return refused(`"${clean(version)}" is not a release version such as 1.2.0, so nothing was done.`);
  if (typeof foundation !== 'string' || !FOUNDATION_RE.test(foundation)) return refused(`"${clean(foundation)}" is not a foundation release such as v0.1.0, so nothing was done.`);
  if (typeof projectDir !== 'string' || !path.isAbsolute(projectDir)) return refused(`"${clean(projectDir)}" is not a project folder, so nothing was done.`);
  let f = factory;
  if (!f) {
    try { f = defaultFactory(env); } catch (e) { return refused(`Conductor could not read its config: ${clean(e.message)}`); }
  }
  let project;
  try { project = loadProject(projectDir); } catch (e) { return refused(clean(e.message)); }

  Object.assign(state, { phase: 'checking', projectDir, name, runId, dep: null, lock: null, version, foundation, recorded: null });
  let lock;
  try { lock = lockDeployment(projectDir, name); } catch (e) { return refused(clean(e.message)); }
  if (!lock) return { outcome: 'busy', message: busyText(name) };
  state.lock = lock;

  const log = shipLog(projectDir, name, runId);
  const tell = (t) => { const s = clean(t); say(s); log(s); };
  const getProvider = () => provider ?? getMachineProvider(f, { env });
  try {
    const r = await updateSteps({ factory: f, getProvider, projectDir, slug: project.slug, name, version, foundation, runId, say: tell, env, sleep, state });
    const message = clean(r.message);
    log(message);
    return { outcome: r.outcome, message };
  } catch (e) {
    let outcome, message;
    if (state.phase === 'updating') {
      [outcome, message] = ['lost-contact', stoppedWhileUpdating(name, e)];
      saveLostContact(state, message);
    } else if (state.phase === 'finishing') {
      // The recorded outcome stands; the message says what did not finish.
      outcome = UPDATE_OUTCOMES.includes(state.recorded) ? state.recorded : 'lost-contact';
      message = stoppedAfterUpdate(name, outcome, e);
    } else [outcome, message] = ['refused', `Conductor stopped unexpectedly before ${name} was changed (${unexpected(e)}).`];
    log(message);
    return { outcome, message };
  } finally {
    lock.release();
    state.lock = null;
  }
}

async function updateSteps({ factory, getProvider, projectDir, slug, name, version, foundation, runId, say, env, sleep, state }) {
  const refused = (message) => ({ outcome: 'refused', message });
  let dep;
  try { dep = loadDeployment(projectDir, name); } catch (e) {
    if (e instanceof DeploymentError) return refused(e.message);
    throw e;
  }
  if (!dep) return refused(`There is no deployment called ${name} for this project.`);
  if (dep.setup.step !== 'done') return refused(`First-time setup of ${name} is not finished, so it cannot be updated. Run: conductor ship ${dep.project} --to ${name}`);
  if (dep.pendingCheck) return refused(pendingText(dep));
  state.dep = dep;
  if (version === dep.currentVersion) return { outcome: 'already-on', message: `${name} is already on ${version}. Nothing was done.` };
  if (dep.currentVersion && compareVersions(version, dep.currentVersion) < 0) return refused(olderText(version, name, dep.currentVersion));

  // Tools first: without git, the release could not even be looked for.
  const missing = missingTools(['ssh', 'git'], { env });
  if (missing.length) return refused(toolText(missing[0]));
  const rel = await releaseOnMain(path.join(projectDir, 'app'), version, env);
  if (!rel) return refused(`There is no release v${version} on the app's main branch, so ${name} was not updated.`);
  const pf = await preflight(targetOf(dep), { bundleDir: dep.bundleDir, env });
  if (!pf.ok) return refused(notReadyText(name, pf.problems));

  say(`Shipping ${version} of ${slug} to ${name} (run ${runId}).`);
  const r = await deliverAndUpdate({ factory, getProvider, projectDir, slug, dep, rel, foundation, facts: pf.facts, runId, say, env, sleep, state });
  return { outcome: r.outcome, message: r.text };
}
