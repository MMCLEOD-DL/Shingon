#!/usr/bin/env node
// The acceptance checker (Plan 12 Task 11, spec §8 item 9). It reads a project folder (Contract 1) and the app's own
// reports, and fills in every automated criterion with its evidence. It never builds, deploys or calls a model:
// it only reads files. Conductor's own modules are imported, never copied, so a change in their rules reaches here.
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { loadProject } from '../../src/factory/projects.js';
import { loadBrief as realLoadBrief, briefPaths } from '../../src/factory/brief.js';
import { acceptanceIds, testTag, EXAMPLE_ID_RE } from '../../src/factory/acceptance.js';
import { writeFileAtomic } from '../../src/factory/fsAtomic.js';
import { loadDeployment } from '../../src/factory/deployments/store.js';
import { compareVersions } from '../../src/factory/foundationLog.js';
import { loadBuild, buildDirOf } from '../../src/factory/buildState.js';
import { readCouncilReport, councilPassed } from '../../src/factory/change/gate.js';
import { isSha } from '../../src/factory/change/gitSafe.js';
import { RUN_ID_RE } from '../../src/factory/ids.js';

export const FOUNDATION_V020_ROUTES = 31;   // v0.1.0's 28 + Task 5's 3; Task 10's hand-off confirms the figure

export const CRITERIA = Object.freeze([
  { id: 'C1', spec: '§2.1', how: 'auto', title: "The role-crossing harness ran on the finished build: the run's `crossing.json` has 0 failures and more routes than the foundation's own at v0.2.0 (`foundationRoutes`, 31), so at least one expenses route is checked." },
  { id: 'C2', spec: '§2.1, §4.3', how: 'auto', title: "The build's council report (`builds/<runId>/council-report.json`) has verdict `approved` or `approved-with-warnings`, no blocking items, and was **not** overridden (neither the report's `overridden` nor `build.json`'s `council.overridden`)." },
  { id: 'C3', spec: '§2.2', how: 'auto', title: "Every acceptance example in the current approved brief is proven by a passing test: for each id from `acceptanceIds(brief)`, a test whose title contains `testTag(id)` (`[<featureId>#<n>]`, Contract 7.4) passed in the latest run's Vitest report (the change run when given, else the build). An example with no id, a tag with no test, or a tag whose only tests failed is a FAIL naming the id." },
  { id: 'C4', spec: '§2.2', how: 'operator', title: "The app's March report, downloaded from the preview as PDF and as a spreadsheet, shows exactly the totals worked out by hand from the brief's examples." },
  { id: 'C5', spec: '§2.2, §2.5', how: 'operator', title: 'On the 10 fictional printed receipts, photographed through the app on a real phone, no field is ever filled in confidently wrong (no "Please check" missing on a wrong value).' },
  { id: 'C6', spec: '§2.3', how: 'auto', title: 'Every page has a screenshot at desktop width and phone width in Chromium and WebKit (`manifest.json`: every page has `desktop-chromium`, `mobile-chromium` and `mobile-webkit`).' },
  { id: 'C7', spec: '§2.3, §2.5', how: 'operator', title: 'On a real iPhone (Safari) and a real Android phone (Chrome): **Take a photo** opens the camera and uploads; **Choose a file** uploads a photo from the library and a PDF; the reading appears; correcting a field and confirming works; nothing scrolls sideways.' },
  { id: 'C8', spec: '§2.4', how: 'operator', title: 'On the test box: a manual backup, then `restore-test`, pass; then a real restore drill from the runbook returns a record count known beforehand.' },
  { id: 'C9', spec: '§2.4', how: 'operator', title: 'Stopping the app container sends a Matrix alert within 5 minutes, and starting it sends the recovery message.' },
  { id: 'C10', spec: '§2.4, §4.8', how: 'auto', title: "The change request went out as an **update**: the deployment's `history` has an `installed` entry followed later by an `updated` or `confirmed` entry at the `currentVersion` (a trailing `already-on` is ignored), that version is newer than the installed one (`compareVersions`), and the last update that reached the box (outcomes that changed nothing are skipped) was not rolled back, urgent or lost contact." },
  { id: 'C11', spec: '§2.5', how: 'operator', title: 'A member gets from "open the app" to a confirmed receipt in under 60 seconds on a phone, with no step that needs help.' },
  { id: 'C12', spec: '§3, §6', how: 'auto', title: "The app's `app-profile.json` matches the approved brief: `policy.outbound` holds the same `OUTBOUND_SERVICES` ids (Contract 7.4), `residency` is equal, and `modules` contains every module the brief lists (here `ocr`). (Task 14 also checks `OCR_ENGINE=local` on the box by hand.)" },
  { id: 'C13', spec: '§5a', how: 'auto', title: "The latest council report has no blocking or warning item with `member: 'legal'` from the `licences` or `scancode` tool, and every entry in the app's `licence-exceptions.json` has a reason (Plan 9's Legal accepts those entries, Contract 7.7)." },
  { id: 'C14', spec: '§4.8', how: 'auto', title: "The change run's own council report meets C2's rule, and every example id that is new in the current brief version (absent from `brief-v<N-1>.json`) is proven by a passing test in the change run's report." },
  { id: 'C15', spec: '§1', how: 'operator', title: "The operator never edited the app's code by hand (Ruling 9). Any hand edit is recorded with its reason, and counts as a FAIL for the factory." },
  { id: 'C16', spec: '§3', how: 'operator', title: 'No paid-API spend unless opted in; frontier cost recorded per stage.' },
  { id: 'C17', spec: 'Contract 7.5', how: 'auto', title: '`project.json` records `foundation.tag` equal to the expected tag (`foundationTag`, `v0.2.0`, the value of `factory.foundation.tag` for this run) and status `shipped` at the end.' },
].map((c) => Object.freeze(c)));

const PASSING_VERDICTS = new Set(['approved', 'approved-with-warnings']);
const NOT_LANDING = new Set(['already-on', 'busy', 'cancelled', 'settings-error']);
const SHOT_PROJECTS = [['desktop-chromium', 'desktop screenshot in Chromium'], ['mobile-chromium', 'phone screenshot in Chromium'], ['mobile-webkit', 'phone screenshot in WebKit']];
const TESTS_HOW = 'npx vitest run --reporter=json --outputFile=<file>';
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pass = (evidence) => ({ status: 'pass', evidence });
const fail = (evidence) => ({ status: 'fail', evidence });
class Missing extends Error {}

// ---- reading files, defensively: a missing or bad file becomes a plain sentence, never a crash ----

function readJson(file, shown, howToMake) {
  if (!existsSync(file)) throw new Missing(`${shown} is missing.${howToMake ? ` ${howToMake}` : ''}`);
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
    throw new Missing(`${shown} could not be read (${e.message.split('\n')[0]}).`);
  }
}

// One build or change run: its build.json (Plan 8) and the reports its checks listed (absolute paths, fixed names).
// It fails closed: only this run's own record, of the kind the flag names, approved, with its checks on the approved
// commit, counts. kind is 'build' for --build and 'change' for --change.
function runOf(projectDir, runId, kind) {
  const flag = `--${kind}`;
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) throw new Missing(`${flag} "${String(runId)}" is not a run id Conductor made (like 20261028-143205-a1b2).`);
  const dir = buildDirOf(projectDir, runId);
  const shown = `builds/${runId}`;
  let build;
  try { build = loadBuild(dir); } catch (e) { throw new Missing(e.message); }
  if (!build) throw new Missing(`${shown} has no build.json, so the ${kind} run cannot be checked. Check the run id.`);
  if (build.runId !== runId) throw new Missing(`${shown}/build.json belongs to run ${String(build.runId)}, not ${runId}, so it cannot be trusted.`);
  if ((build.kind ?? 'build') !== kind) throw new Missing(`${shown} is a ${build.kind ?? 'build'} run, not a ${kind} run. Pass it with --${build.kind ?? 'build'}.`);
  if (build.status !== 'approved') throw new Missing(`${shown} was not approved (its status is ${String(build.status)}), so its evidence does not count.`);
  if (!isSha(build.approvedSha)) throw new Missing(`${shown} has no approved commit recorded, so its evidence does not count.`);
  if (build.checks?.sha !== build.approvedSha) throw new Missing(`${shown}: the final checks ran on a different commit from the one approved, so their reports do not count. Re-run the build's checks.`);
  const reportsDir = path.join(dir, 'reports');
  const reports = Array.isArray(build.checks?.reports) ? build.checks.reports.filter((p) => typeof p === 'string') : [];
  const report = (name) => {
    const listed = reports.filter((p) => path.basename(p) === name);
    if (!listed.length) return null;
    const own = listed.find((p) => path.isAbsolute(p) && path.dirname(p) === reportsDir);
    if (!own) throw new Missing(`${shown} lists ${name} outside its own reports folder (${shown}/reports), so it does not count.`);
    return own;
  };
  return { runId, dir, shown, build, report };
}

// The app's own files at a commit (read-only git), and whether they differ in the working tree (a hand edit).
const gitEnv = () => { const env = { ...process.env }; delete env.GIT_DIR; delete env.GIT_WORK_TREE; delete env.GIT_INDEX_FILE; env.GIT_OPTIONAL_LOCKS = '0'; return env; }; // read-only: git status must not refresh the index
function appGit(projectDir, args) {
  const r = spawnSync('git', ['-C', path.join(projectDir, 'app'), ...args], { encoding: 'utf8', env: gitEnv(), maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status ?? 1, stdout: r.stdout ?? '' };
}
function appFileAt(projectDir, sha, name, { optional = false } = {}) {
  const changed = appGit(projectDir, ['status', '--porcelain', '--', name]);
  if (changed.code !== 0) throw new Missing(`The app folder is not a git repository Conductor can read, so app/${name} cannot be checked.`);
  if (changed.stdout.trim()) throw new Missing(`app/${name} was changed by hand after the approved commit (git status shows it), so it does not count (Ruling 9).`);
  const r = appGit(projectDir, ['show', `${sha}:${name}`]);
  if (r.code !== 0) {
    if (optional) return null;
    throw new Missing(`app/${name} is not in the app at the approved commit ${sha.slice(0, 12)}. The build writes it; build the app first.`);
  }
  try { return JSON.parse(r.stdout); } catch (e) { throw new Missing(`app/${name} at ${sha.slice(0, 12)} could not be read (${e.message.split('\n')[0]}).`); }
}

const display = (projectDir, file) => {
  const rel = path.relative(projectDir, file);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : file;
};

// Every test in a Vitest (Jest-shaped) JSON report: { title, fullName, status }.
function testsIn(file, shown) {
  const v = readJson(file, shown);
  if (!isObj(v) || !Array.isArray(v.testResults)) throw new Missing(`${shown} is not a Vitest JSON report (it has no testResults list).`);
  return v.testResults.flatMap((f) => (Array.isArray(f?.assertionResults) ? f.assertionResults : []))
    .filter(isObj).map((t) => ({ title: String(t.title ?? ''), fullName: String(t.fullName ?? ''), status: t.status }));
}

// The Vitest report for a run: the operator's own file when given, else the one the run's checks listed.
function testsFor(ctx, run, override, flag) {
  if (override) {
    const file = path.resolve(override);
    return { tests: testsIn(file, display(ctx.projectDir, file)), source: display(ctx.projectDir, file) };
  }
  const file = run.report('vitest.json');
  if (!file) throw new Missing(`${run.shown} has no Vitest report in its checks. Re-run the build's checks, or pass ${flag} <file> made with: ${TESTS_HOW}`);
  const shown = display(ctx.projectDir, file);
  return { tests: testsIn(file, shown), source: shown };
}

// Example ids, checked with Plan 7's own pattern before acceptanceIds (which throws on the first bad one).
function exampleIds(brief) {
  const problems = [];
  for (const f of Array.isArray(brief?.features) ? brief.features : []) {
    (Array.isArray(f?.acceptance) ? f.acceptance : []).forEach((e, i) => {
      const where = `Feature "${f.id}", example ${i + 1}`;
      if (typeof e?.id !== 'string' || e.id === '') problems.push(`${where} has no id, so no test can be traced to it`);
      else {
        const m = EXAMPLE_ID_RE.exec(e.id);
        if (!m || m[1] !== f.id) problems.push(`${where} has the id "${e.id}", which is not one of its own, so no test can be traced to it`);
      }
    });
  }
  if (problems.length) return { problems, ids: [] };
  return { problems, ids: acceptanceIds(brief).map((a) => a.id) };
}

// Which ids a test report proves: a passing test carries the tag, and no test with the tag failed.
function proof(ids, tests) {
  const problems = [];
  for (const id of ids) {
    const tag = testTag(id);
    const mine = tests.filter((t) => t.fullName.includes(tag) || t.title.includes(tag));
    if (mine.length === 0) problems.push(`${id}: no test carries ${tag}`);
    else if (mine.some((t) => t.status === 'failed')) problems.push(`${id}: its test failed`);
    else if (!mine.some((t) => t.status === 'passed')) problems.push(`${id}: its test did not run (${[...new Set(mine.map((t) => t.status))].join(', ')})`);
  }
  return problems;
}

// ---- the automated criteria ----

function crossing(ctx, run) {
  const file = run.report('crossing.json');
  if (!file) throw new Missing(`${run.shown} has no crossing.json in its checks. Re-run the build's checks: the role-crossing harness writes it.`);
  const c = readJson(file, display(ctx.projectDir, file));
  if (!isObj(c) || !Number.isInteger(c.routes) || !Array.isArray(c.failures)) throw new Missing(`${display(ctx.projectDir, file)} is not a crossing report (it needs routes and failures).`);
  const n = c.failures.length;
  const said = n ? `: ${c.failures.map((f) => (typeof f?.sentence === 'string' ? f.sentence : JSON.stringify(f))).join(' ')}` : '';
  const line = `${run.shown}: ${c.routes} routes (foundation ${ctx.foundationRoutes}), ${plural(n, 'problem')}${said}`;
  if (n) return fail(line);
  if (c.routes <= ctx.foundationRoutes) return fail(`${line}; that is no more routes than the foundation's own, so no expenses route was checked.`);
  return pass(`${line}.`);
}

function councilRule(ctx, run) {
  const report = readCouncilReport(ctx.projectDir, run.runId);
  if (!report) {
    return fail(`${run.shown} has no finished council report (council-report.json is missing, paused or from another run). Run the council on this build again.`);
  }
  const blocking = Array.isArray(report.blocking) ? report.blocking : [];
  const warnings = Array.isArray(report.warnings) ? report.warnings : [];
  const items = blocking.map((b) => `[${b?.member}] ${b?.title}`).join('; ');
  if (!PASSING_VERDICTS.has(report.verdict) || blocking.length) {
    return fail(`${run.shown}: the council's verdict was ${report.verdict}, with ${plural(blocking.length, 'blocking item')}${items ? `: ${items}` : ''}.`);
  }
  // Plan 11's own rule: the report is this run's, on the approved commit, with the verdict the build recorded.
  const b = run.build;
  const gate = councilPassed(b.council, { sha: b.approvedSha, runId: run.runId, report, squashedSha: b.squashedSha ?? null });
  if (!gate.ok) return fail(`${run.shown}: ${gate.reason}`);
  if (gate.overridden || report.overridden === true || b.council?.overridden === true) {
    return fail(`${run.shown}: the operator overrode the council, so its approval does not count.`);
  }
  return pass(`${run.shown}: ${report.verdict}, no blocking items, not overridden (${plural(warnings.length, 'warning')}).`);
}

function screenshots(ctx, run) {
  const dir = run.report('screenshots');
  if (!dir) throw new Missing(`${run.shown} has no screenshots in its checks. Re-run the build's checks with the browser gate on.`);
  const checks = run.build.checks ?? {};
  if (checks.overridden === true || checks.browser?.status === 'failed') {
    return fail(`${run.shown}: the browser checks failed and the build was approved anyway, so the screenshots do not count.`);
  }
  const file = path.join(dir, 'manifest.json');
  const m = readJson(file, display(ctx.projectDir, file));
  if (!Array.isArray(m) || m.length === 0) return fail(`${display(ctx.projectDir, file)} lists no screenshots.`);
  const pages = new Map();
  const problems = [];
  for (const e of m) {
    if (!isObj(e) || typeof e.page !== 'string') continue;
    const ok = typeof e.file === 'string' && e.file === path.basename(e.file) && e.file.endsWith('.png') && existsSync(path.join(dir, e.file));
    if (!ok) { problems.push(`the screenshot ${JSON.stringify(e.file)} of "${e.page}" is missing`); continue; }
    (pages.get(e.page) ?? pages.set(e.page, new Set()).get(e.page)).add(e.project);
  }
  for (const [page, projects] of pages) {
    for (const [project, words] of SHOT_PROJECTS) if (!projects.has(project)) problems.push(`"${page}" has no ${words}`);
  }
  if (problems.length) return fail(`${run.shown}: ${problems.join('; ')}.`);
  return pass(`${run.shown}: ${plural(pages.size, 'page')}, each at desktop and phone width in Chromium and at phone width in WebKit.`);
}

function update(ctx) {
  if (!ctx.opts.deployment) return fail('No deployment was named, so the update could not be checked. Pass --deployment <name>.');
  const name = ctx.opts.deployment;
  let dep;
  try { dep = loadDeployment(ctx.projectDir, name); } catch (e) { return fail(e.message); }
  if (!dep) return fail(`There is no deployment called "${name}" in this project (deployments/${name}.json).`);
  const shown = `deployments/${name}`;
  const h = dep.history;
  // Outcomes that changed nothing on the box are walked past; the last landing decides (never calmer than it was).
  let end = h.length;
  while (end > 0 && NOT_LANDING.has(h[end - 1].outcome)) end--;
  const last = h[end - 1];
  const why = last ? ` (${last.version}${last.detail ? `: ${last.detail}` : ''})` : '';
  if (last?.outcome === 'rolled-back') return fail(`${shown}: the last update was rolled back${why}.`);
  if (last?.outcome === 'urgent') return fail(`${shown}: the last update ended urgent${why}.`);
  if (last?.outcome === 'lost-contact') return fail(`${shown}: Conductor lost contact with the box during the last update${why}, so it is not known to have landed.`);
  const i = h.findIndex((e) => e.outcome === 'installed');
  if (i < 0) return fail(`${shown}: the history has no "installed" entry, so the first ship was not recorded.`);
  const installed = h[i];
  const cv = dep.currentVersion;
  if (!cv) return fail(`${shown}: the deployment has no current version.`);
  let j = -1;
  for (let k = h.length - 1; k > i; k--) if ((h[k].outcome === 'updated' || h[k].outcome === 'confirmed') && h[k].version === cv) { j = k; break; }
  if (j < 0) return fail(`${shown}: after installing ${installed.version} there is no update to the current version ${cv} (updated or confirmed).`);
  let newer;
  try { newer = compareVersions(cv, installed.version) > 0; } catch (e) { return fail(`${shown}: ${e.message}`); }
  if (!newer) return fail(`${shown}: the current version ${cv} is not newer than the installed ${installed.version}.`);
  return pass(`${shown}: installed ${installed.version}, then ${h[j].outcome} ${cv} (current version ${cv}).`);
}

function profile(ctx, brief) {
  const p = appFileAt(ctx.projectDir, ctx.approvedSha(), 'app-profile.json');
  const outbound = Array.isArray(p?.policy?.outbound) ? p.policy.outbound : null;
  if (!isObj(p) || !outbound) return fail('app/app-profile.json has no policy.outbound list.');
  const want = Array.isArray(brief.policy?.outbound) ? brief.policy.outbound : [];
  const briefSays = want.length ? `the brief allows only ${want.join(', ')}` : 'the brief allows nothing';
  const problems = [];
  const extra = outbound.filter((id) => !want.includes(id));
  const lacking = want.filter((id) => !outbound.includes(id));
  if (extra.length) problems.push(`the app allows ${extra.join(', ')}, but ${briefSays}`);
  if (lacking.length) problems.push(`the brief allows ${lacking.join(', ')}, but the app does not`);
  if (p.policy.residency !== brief.policy?.residency) problems.push(`the app's residency is ${p.policy.residency}, but the brief's is ${brief.policy?.residency}`);
  const modules = Array.isArray(p.modules) ? p.modules : [];
  const missing = (brief.modules ?? []).filter((m) => !modules.includes(m));
  if (missing.length) problems.push(`the app does not turn on ${missing.join(', ')}, which the brief needs`);
  if (problems.length) return fail(`app/app-profile.json: ${problems.join('; ')}.`);
  const extraModules = modules.filter((m) => !(brief.modules ?? []).includes(m));
  return pass(`app/app-profile.json: outbound ${outbound.length ? outbound.join(', ') : 'none'} (as the brief), residency ${p.policy.residency}, modules ${modules.join(', ') || 'none'} include every module the brief lists${extraModules.length ? ` (also on, not in the brief: ${extraModules.join(', ')})` : ''}.`);
}

function licences(ctx, runs) {
  const problems = [];
  for (const run of runs) {
    const report = readCouncilReport(ctx.projectDir, run.runId);
    if (!report) { problems.push(`${run.shown} has no finished council report`); continue; }
    for (const [list, kind] of [['blocking', 'blocking item'], ['warnings', 'warning']]) {
      for (const item of Array.isArray(report[list]) ? report[list] : []) {
        if (item?.member === 'legal' && (item.tool === 'licences' || item.tool === 'scancode')) problems.push(`${run.shown}: Legal ${kind} about a licence: ${item.title}`);
      }
    }
  }
  let n = 0;
  const ex = appFileAt(ctx.projectDir, ctx.approvedSha(), 'licence-exceptions.json', { optional: true });
  if (ex !== null) {
    if (!isObj(ex)) problems.push('app/licence-exceptions.json is not a list of "name@version": reason entries');
    else {
      n = Object.keys(ex).length;
      for (const [k, why] of Object.entries(ex)) if (typeof why !== 'string' || !why.trim()) problems.push(`the licence exception "${k}" has no reason`);
    }
  }
  if (problems.length) return fail(`${problems.join('; ')}.`);
  return pass(`No Legal licence items in ${runs.map((r) => r.shown).join(', ')}; ${plural(n, 'licence exception')}${n ? ', each with a reason' : ''}.`);
}

function foundationTag(ctx) {
  const p = ctx.project;
  const problems = [];
  if (p.foundation?.tag !== ctx.foundationTag) problems.push(`the app was built on ${p.foundation?.tag ?? 'no foundation'}, but this run expects ${ctx.foundationTag}`);
  if (p.status !== 'shipped') problems.push(`its status is ${p.status}, not shipped`);
  if (problems.length) return fail(`project.json: ${problems.join('; ')}.`);
  return pass(`project.json: foundation ${p.foundation.tag}, status shipped.`);
}

// The ids of the brief version before this one (written once, never changed); null when there is none.
function previousIds(projectDir, version) {
  if (!Number.isInteger(version) || version < 2) return new Set();
  const file = briefPaths(projectDir).json(version - 1);
  const prev = readJson(file, `brief/brief-v${version - 1}.json`);
  return new Set((prev?.features ?? []).flatMap((f) => (f?.acceptance ?? []).map((e) => e?.id)).filter((id) => typeof id === 'string'));
}

// ---- the whole check ----

export async function checkAcceptance(projectDir, opts = {}) {
  const dir = path.resolve(projectDir);
  const ctx = {
    projectDir: dir, opts, foundationTag: opts.foundationTag ?? 'v0.2.0',
    foundationRoutes: opts.foundationRoutes ?? FOUNDATION_V020_ROUTES,
  };
  const loadBrief = opts.deps?.loadBrief ?? realLoadBrief;
  // Each input once; a failure to read it is kept as its plain message for every criterion that needs it.
  const attempt = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e.message }; } };
  const project = attempt(() => loadProject(dir));
  const brief = attempt(() => loadBrief(dir));
  const build = attempt(() => runOf(dir, opts.build, 'build'));
  const change = opts.change ? attempt(() => runOf(dir, opts.change, 'change')) : { error: 'No change run was named, so the change could not be checked. Pass --change <runId>.' };
  ctx.project = project.value;
  // A change run that was named must load: no quiet fallback to the build's evidence.
  const named = opts.change ? [build, change] : [build];
  ctx.approvedSha = () => (change.value ?? build.value).build.approvedSha;

  // Each criterion: its inputs must have loaded, and a Missing file becomes a fail with its sentence.
  const guard = (needs, fn) => {
    for (const n of needs) if (n.error) return fail(n.error);
    try { return fn(); } catch (e) {
      if (e instanceof Missing) return fail(e.message);
      return fail(`The check could not finish: ${e.message}`);
    }
  };
  const runs = () => [build.value, ...(change.value ? [change.value] : [])];
  const each = (fn) => {
    const out = runs().map((r) => {
      try { return fn(r); } catch (e) { if (e instanceof Missing) return fail(e.message); throw e; }
    });
    return out.every((o) => o.status === 'pass') ? pass(out.map((o) => o.evidence).join(' ')) : fail(out.filter((o) => o.status === 'fail').map((o) => o.evidence).join(' '));
  };
  const latest = () => (change.value
    ? testsFor(ctx, change.value, opts.changeTests, '--change-tests')
    : testsFor(ctx, build.value, opts.tests, '--tests'));

  const auto = {
    C1: () => guard(named, () => each((r) => crossing(ctx, r))),
    C2: () => guard([build], () => councilRule(ctx, build.value)),
    C3: () => guard([brief, ...named], () => {
      const { problems: idProblems, ids } = exampleIds(brief.value);
      if (idProblems.length) return fail(`${idProblems.join('; ')}.`);
      const { tests, source } = latest();
      const problems = proof(ids, tests);
      if (problems.length) return fail(`${plural(problems.length, 'example')} of ${ids.length} not proven in ${source}: ${problems.join('; ')}.`);
      return pass(`${ids.length} of ${ids.length} examples proven by passing tests: ${ids.join(', ')} (${source}).`);
    }),
    C6: () => guard(named, () => each((r) => screenshots(ctx, r))),
    C10: () => guard([], () => update(ctx)),
    C12: () => guard([brief, ...named], () => profile(ctx, brief.value)),
    C13: () => guard(named, () => licences(ctx, runs())),
    C14: () => guard([brief, change], () => {
      const council = councilRule(ctx, change.value);
      const { problems: idProblems, ids } = exampleIds(brief.value);
      if (idProblems.length) return fail(`${idProblems.join('; ')}.`);
      const before = previousIds(dir, brief.value.version);
      const fresh = ids.filter((id) => !before.has(id));
      const { tests, source } = testsFor(ctx, change.value, opts.changeTests, '--change-tests');
      const problems = proof(fresh, tests);
      const what = fresh.length ? `${plural(fresh.length, 'new example')} (${fresh.join(', ')})` : `no new examples in brief v${brief.value.version}`;
      if (council.status !== 'pass' || problems.length) {
        return fail([council.status !== 'pass' ? council.evidence : null, problems.length ? `not proven in ${source}: ${problems.join('; ')}.` : null].filter(Boolean).join(' '));
      }
      return pass(`${council.evidence} ${what} proven by passing tests in ${source}.`);
    }),
    C17: () => guard([project], () => foundationTag(ctx)),
  };

  const results = CRITERIA.map((c) => {
    if (c.how === 'operator') {
      let evidence = 'The operator checks this by hand and records it in RESULT.md.';
      if (c.id === 'C15') {
        const st = appGit(dir, ['status', '--porcelain']);
        if (st.code === 0 && st.stdout.trim()) evidence += ` Note: the app folder has changes that are not committed (${plural(st.stdout.trim().split('\n').length, 'path')}); check whether they are hand edits.`;
      }
      return { id: c.id, status: 'operator', evidence };
    }
    return { id: c.id, ...auto[c.id]() };
  });
  return { results, ok: results.every((r) => r.status !== 'fail') };
}

const cell = (s) => String(s).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const SHOWN = { pass: 'PASS', fail: 'FAIL', operator: 'for the operator' };

export function renderResults(project, results) {
  const byId = new Map(results.map((r) => [r.id, r]));
  const rows = CRITERIA.map((c) => {
    const r = byId.get(c.id) ?? { status: c.how === 'operator' ? 'operator' : 'fail', evidence: 'Not checked.' };
    return `| ${c.id} | ${c.spec} | ${cell(c.title)} | ${SHOWN[r.status] ?? cell(r.status)} | ${cell(r.evidence)} |`;
  });
  const autos = results.filter((r) => r.status !== 'operator');
  const passed = autos.filter((r) => r.status === 'pass').length;
  return [
    `# Acceptance check: ${project?.slug ?? 'project'}`,
    '',
    `Automated criteria: ${passed} of ${autos.length} pass. The acceptance test passes only when every criterion passes, including those for the operator.`,
    '',
    '| Id | Spec | Criterion | Result | Evidence |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

// ---- command line ----

const USAGE = `Usage: node spikes/acceptance/check-acceptance.mjs <projectDir> --build <runId> [--change <runId>] [--deployment <name>]
       [--tests <file>] [--change-tests <file>] [--foundation-tag <vX.Y.Z>] [--foundation-routes <n>] [--out <file>]

Reads the project folder and the app's own reports, and fills in every automated acceptance criterion.
It exits 0 when every automated criterion passes, 1 when one fails, and 2 when the arguments are wrong.`;

function cliArgs(argv) {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      build: { type: 'string' }, change: { type: 'string' }, deployment: { type: 'string' }, tests: { type: 'string' },
      'change-tests': { type: 'string' }, 'foundation-tag': { type: 'string' }, 'foundation-routes': { type: 'string' }, out: { type: 'string' },
    },
  });
  if (positionals.length !== 1) throw new Error('Give exactly one project folder.');
  if (!values.build) throw new Error('Name the build run with --build <runId>.');
  const opts = { build: values.build, change: values.change, deployment: values.deployment, tests: values.tests, changeTests: values['change-tests'] };
  if (values['foundation-tag'] !== undefined) {
    if (!/^v\d+\.\d+\.\d+$/.test(values['foundation-tag'])) throw new Error('The foundation tag must look like v0.2.0.');
    opts.foundationTag = values['foundation-tag'];
  }
  if (values['foundation-routes'] !== undefined) {
    if (!/^\d{1,4}$/.test(values['foundation-routes'])) throw new Error('The foundation route count must be a whole number.');
    opts.foundationRoutes = Number(values['foundation-routes']);
  }
  return { projectDir: positionals[0], opts, out: values.out };
}

async function main(argv) {
  let args;
  try { args = cliArgs(argv); } catch (e) {
    process.stderr.write(`${e.message.split('\n')[0]}\n\n${USAGE}\n`);
    return 2;
  }
  const { results, ok } = await checkAcceptance(args.projectDir, args.opts);
  const md = renderResults({ slug: path.basename(path.resolve(args.projectDir)) }, results);
  if (args.out) {
    const out = path.resolve(args.out);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileAtomic(out, md);
    process.stdout.write(`Wrote ${out}\n`);
  } else process.stdout.write(md);
  return ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { process.stderr.write(`The check could not run: ${e.message}\n`); process.exitCode = 1; });
}
