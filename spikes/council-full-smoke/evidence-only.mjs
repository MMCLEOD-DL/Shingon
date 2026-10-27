#!/usr/bin/env node
// Plan 9 smoke, evidence only (operator-run in a real terminal): no models, no spend. It proves the council's gates
// and the reliability smoke on real tools: real npm, Playwright (the council's .ts config import), optionally axe,
// and a real test machine (CT 111, through Plan 8's static provider). Never run by the test suite.
//   node spikes/council-full-smoke/evidence-only.mjs
// Everything it makes lives in ONE throwaway folder under /var/tmp (printed, and removed at the end unless
// KEEP=1); it never touches the real ~/highland-projects and deletes nothing outside that folder.
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p) => import(path.join(ROOT, 'src', p));

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('Run this in a real terminal (it uses a real test machine and takes about 15-25 minutes).');
  process.exit(2);
}

const { findConfig } = await src('cli/config.js');
const { loadConfig } = await src('config.js');
const { factoryConfig } = await src('factory/config.js');
const { createProject, saveProject } = await src('factory/projects.js');
const { renderBrief, validateBrief } = await src('factory/brief.js');
const { createSsh } = await src('factory/ssh.js');
const { getMachineProvider } = await src('factory/machines/index.js');
const { DEFAULT_OPTIONS } = await src('options.js');
const { git } = await src('workspace.js');
const { openCouncilWorkspace, openCouncilLog } = await src('council/councilWorkspace.js');
const { collectEvidence } = await src('council/evidence.js');
const { projectContext } = await src('council/project.js');
const { councilProgressLine } = await src('council/progress.js');
const { buildReport } = await src('council/report.js');
const { addedLines, SECURITY } = await src('council/security.js');
const { LEGAL } = await src('council/licences.js');
const { CORRECTNESS } = await src('council/correctness.js');
const { DESIGN } = await src('council/design.js');
const { RELIABILITY } = await src('council/reliability.js');
const { TOOL_LABEL } = await src('council/tools.js');

const say = (s = '') => console.log(s);
const die = (s, code = 2) => { console.error(s); process.exit(code); };

// ---- config (the way src/cli/main.js and src/cli/factory.js load it) ----
let config;
let factory;
try {
  const configPath = findConfig({ cwd: process.cwd(), env: process.env });
  config = loadConfig(configPath);
  factory = factoryConfig({ factory: JSON.parse(readFileSync(configPath, 'utf8')).factory }, { env: process.env, home: homedir() });
} catch (e) { die(`Conductor could not read its config: ${e.message}`); }
if (factory.machines.provider !== 'static') {
  die('This smoke only runs against the static test machine list. Set factory.machines in your config.');
}

// ---- one throwaway folder for everything ----
const tmp = mkdtempSync('/var/tmp/hf-council-evidence.');
say(`throwaway folder: ${tmp}${process.env.KEEP ? ' (KEEP=1: it stays afterwards)' : ' (removed at the end)'}`);
const appDir = path.join(tmp, 'app');
const projectsRoot = path.join(tmp, 'projects');
const baseDir = path.join(tmp, 'workspaces');
let opened = null;

async function finish(code) {
  try { opened?.remove(); } catch { /* best effort */ }
  if (!process.env.KEEP) rmSync(tmp, { recursive: true, force: true });
  process.exit(code);
}
process.on('SIGINT', () => { say('\nStopped.'); finish(130); });

try {
  // ---- the "app": the foundation at its tag, plus a branch holding one empty commit ----
  const tag = factory.foundation.tag;
  const run = (cwd, args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  };
  run(tmp, ['clone', '--quiet', '--no-hardlinks', factory.foundation.repo, appDir]);
  const commit = run(appDir, ['rev-parse', `${tag}^{commit}`]);
  run(appDir, ['checkout', '-q', '-B', 'main', commit]);
  run(appDir, ['checkout', '-q', '-b', 'build/smoke']);
  run(appDir, ['-c', 'user.name=smoke', '-c', 'user.email=smoke@local', 'commit', '--allow-empty', '-q', '-m', 'council smoke: empty commit']);
  const sha = run(appDir, ['rev-parse', 'HEAD']);

  // ---- the throwaway project and an in-memory brief (one worked example the foundation's tests do not tag) ----
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const slug = `council-smoke-${date}`;
  const { dir: projectDir, project } = createProject(projectsRoot, { client: 'Council Smoke Ltd', slug });
  saveProject(projectDir, { ...project, foundation: { repo: factory.foundation.repo, tag, commit } });
  const brief = {
    schema: 1, client: 'Council Smoke Ltd', purpose: 'Evidence-only smoke for the full council.', kind: 'web-app',
    roles: [{ name: 'Staff', whatTheyDo: 'Keep notes', sees: 'Their own notes', mapsTo: 'member' }],
    records: [{ name: 'Note', description: 'A short note', holdsFiles: false, personalData: false }],
    features: [{ id: 'notes', title: 'Notes', story: 'Staff keep short notes.', roles: ['Staff'], data: ['Note'],
      acceptance: [{ id: 'notes#1', given: 'Alice is signed in as Staff', when: 'she adds a note called Hello', then: 'her notes list shows Hello' }] }],
    outputs: [], integrations: [], modules: [],
    policy: { hosting: 'client-box', outbound: [], residency: 'uk', retention: { text: 'Notes are kept for 6 years', days: 2190 },
      backupDestination: { kind: 'client-owned', detail: 'A USB disk kept in the office safe' }, operatorAccess: true },
    assumptions: [], openQuestions: [], exampleSeq: { notes: 1 },
    slug, version: 1, createdAt: new Date().toISOString(), revisedFrom: null, approvedAt: new Date().toISOString(), approvedBy: 'smoke',
  };
  const valid = validateBrief(brief, { stage: 'approved' });
  if (!valid.ok) throw new Error(`the smoke's own brief is not valid: ${valid.problems.join(' ')}`);

  // ---- the council workspace and the evidence stage ----
  const runId = `${date}-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}-0001`;
  const project2 = await projectContext({ projectDir, appDir, sha, brief, runId, slug });
  project2.factory = factory;
  project2.deps = {};
  project2.briefText = renderBrief(brief);
  mkdirSync(project2.buildDir, { recursive: true });

  const onEvent = (e) => { if (e.type === 'council-evidence') { const l = councilProgressLine(e); if (l) say(l); else say(`  [${e.stage}: ${e.status}${e.machine ? ` on ${e.machine}` : ''}]`); } };
  const { log, state } = openCouncilLog(project2.buildDir, { onEvent });
  opened = await openCouncilWorkspace({ appDir, sha, foundation: project2.foundation, runId, baseDir });
  project2.problem = opened.problem;
  if (opened.problem) say(`NOTE: ${opened.problem}`);
  const { ws } = opened;
  const options = { ...DEFAULT_OPTIONS, ...config.options, council: true };
  const ctx = { ws, log, state, team: null, options };
  const head = await ws.head();

  say('\nCollecting evidence (checks: null, so every gate runs; this is the point of the smoke). Be patient.');
  const t0 = Date.now();
  const evidence = await collectEvidence(ctx, { project: project2, head, round: 1, deps: {} });
  say(`Evidence collected in ${Math.round((Date.now() - t0) / 60000)} minutes.`);

  // ---- each member's collect, no interpreter ----
  const files = await ws.filesRange(ws.baseSha, head);
  const diff = await ws.diffRange(ws.baseSha, head);
  const u0 = await git(ws.dir, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '-U0', ws.baseSha, head]);
  const input = {
    dir: ws.dir, files, changed: new Set(files), added: u0.code === 0 ? addedLines(u0.stdout) : null, wholeFiles: new Set(),
    baseSha: ws.baseSha, tests: null, baseTests: null, options, env: process.env, request: null, plan: null, diff,
    project: project2, brief, briefText: project2.briefText, policy: brief.policy, evidence,
  };
  const members = [SECURITY, LEGAL, CORRECTNESS, DESIGN, RELIABILITY];
  const toolRuns = [];
  const checked = [];
  for (const m of members) {
    const runs = await m.collect(input);
    toolRuns.push(...runs);
    const ran = runs.filter((r) => r.status === 'ran').map((r) => r.label ?? TOOL_LABEL[r.tool] ?? r.tool);
    checked.push(`${m.label}: ${ran.length ? ran.join(', ') : 'nothing could run'}`);
  }
  const findings = toolRuns.flatMap((r) => r.findings);
  const coverage = toolRuns.find((r) => r.tool === 'coverage' && r.status === 'ran' && r.coverage)?.coverage ?? null;
  const report = buildReport({ round: 1, findings, toolRuns, by: null, history: [], interpreted: new Set(), checked, coverage,
    files: { md: '(not written by this smoke)', json: null, screenshots: evidence.shotsDir ?? null } });
  say(`\n${report.text}\n`);

  const g = evidence.gates;
  if (g?.axe) say(`axe-core: ${g.axe.status}${g.axe.version ? ` ${g.axe.version}` : ''}${g.axe.note ? ` (${g.axe.note})` : ''}`);
  say(`Gate steps: ${g ? JSON.stringify(g.steps) : '(the gates did not run)'}`);
  if (evidence.gatesNote) say(`Gates note: ${evidence.gatesNote}`);
  say(`Smoke: ${evidence.smokeStatus}${evidence.smoke ? ` (passed: ${evidence.smoke.passed})` : ''}${evidence.smokeNote ? ` - ${evidence.smokeNote}` : ''}`);

  // ---- the machine must be free and clean afterwards ----
  say('\nChecking the test machine afterwards...');
  const ssh = createSsh(factory.machines);
  const provider = getMachineProvider(factory, { ssh });
  const inUse = await provider.list();
  say(inUse.length ? `STILL IN USE: ${inUse.map((m) => m.id).join(', ')}` : 'No factory machines are in use.');
  let leftovers = '(could not check)';
  let clean = false;
  try {
    const m = await provider.acquire({ purpose: 'council', projectSlug: slug, runId });
    try {
      const r = await ssh.exec(m, 'docker ps -a --format "{{.Names}}" | grep -E "hfsmoke|hf-smoke-rest" || true; ls -d /tmp/hf-smoke /tmp/hf-smoke-cookies 2>/dev/null || true');
      leftovers = (r.stdout ?? '').trim();
      clean = r.code === 0 && leftovers === '';
    } finally { await m.release(); }
  } catch (e) { leftovers = `could not check: ${e.message}`; }
  say(clean ? 'Nothing named hfsmoke or hf-smoke-rest is left on the machine.' : `LEFTOVERS: ${leftovers || '(none)'}`);

  // ---- verdict ----
  const REQUIRED = ['npm-ci', 'lint', 'typecheck', 'licences', 'vitest', 'build', 'browser'];
  const steps = g?.steps ?? {};
  const stepsOk = !!g && REQUIRED.every((s) => steps[s] === 0) && Object.values(steps).every((c) => c === null || c === 0);
  const pageBlocking = toolRuns.filter((r) => r.tool === 'page-gate').flatMap((r) => r.findings).filter((f) => f.grade === 'blocking' && !f.dismissed);
  const smokeOk = evidence.smoke?.passed === true;
  const titles = findings.map((f) => f.title);
  const expected = [
    ['role-crossing note', titles.some((t) => t.startsWith('The role-crossing tests passed:'))],
    ['deployed note', titles.some((t) => t.startsWith('Deployed on a fresh test machine'))],
    ['notes#1 has no test', titles.some((t) => t.includes('Worked example notes#1 has no test'))],
    ['accessibility results (only when axe is installed)', g?.axe?.status !== 'ok' || g?.a11y != null],
  ];
  say('\nExpected lines:');
  for (const [name, ok] of expected) say(`  ${ok ? 'yes' : 'NO '}  ${name}`);
  say(`\nEvery gate step 0: ${stepsOk ? 'yes' : 'NO'}`);
  say(`Page gate has no blocking finding: ${pageBlocking.length === 0 ? 'yes' : `NO (${pageBlocking.map((f) => f.title).join('; ')})`}`);
  say(`Smoke passed: ${smokeOk ? 'yes' : 'NO'}`);
  say(`Machine released and clean: ${inUse.length === 0 && clean ? 'yes' : 'NO'}`);
  const pass = stepsOk && pageBlocking.length === 0 && smokeOk;
  say(pass ? '\nEVIDENCE SMOKE PASSED' : '\nEVIDENCE SMOKE FAILED (see above; note it in RESULT.md)');
  await finish(pass ? 0 : 1);
} catch (e) {
  console.error(`The smoke stopped: ${e.message}`);
  await finish(2);
}
