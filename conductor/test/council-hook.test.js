// The full council hook (Plan 9 Task 12, Contract 7 §7.7) end to end. Everything external is stubbed:
// the gates run through fakeGatesRun, the machine is fake, SSH is fake, the reviewer is a fake participant.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runProjectCouncil } from '../src/council/projectCouncil.js';
import { git } from '../src/workspace.js';
import { BRIEF } from './fixtures/council-full/brief.js';
import { fakeGatesRun, fakeMachine, fakeProvider, fakeSsh } from './helpers/councilFull.js';
import { fakeParticipant } from './helpers/fakes.js';
import { councilStubs } from './helpers/councilStubs.js';
import { makeRepo } from './helpers/gitRepo.js';

const RUN = '20261027-100000-abcd';   // Ruling R1: a real-format run id
const FX = new URL('./fixtures/council-full/gates-out/', import.meta.url).pathname;
const log = (f) => readFileSync(new URL(`./fixtures/council-full/${f}`, import.meta.url), 'utf8');
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const okChecks = { browsersInstalled: () => ({ ok: true, why: '' }), testDatabaseProblem: () => null };
const failingSsh = () => fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-failed-step5.log') }, { match: 'rm -rf' }]);
const passingSsh = () => fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf' }]);

const TOTAL = "export const total = (miles: number) => {\n  const total = miles * 0.45;\n  return fetch('https://vision.googleapis.com/v1').then(() => total);\n};\n";
const SCHEMA = "import { pgTable, text } from 'drizzle-orm/pg-core';\nexport const claims = pgTable('claims', {\n  claimant_name: text('claimant_name'),\n});\n";

async function commit(dir, files, message) {
  for (const [name, body] of Object.entries(files)) {
    const p = path.join(dir, name);
    if (body === null) { rmSync(p, { force: true }); continue; }
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  return (await git(dir, ['rev-parse', 'HEAD'])).stdout.trim();
}

// A build commit on build/<runId>, made with appDir left on main.
async function buildCommit(appDir, files, message) {
  await git(appDir, ['checkout', '-q', `build/${RUN}`]);
  const sha = await commit(appDir, files, message);
  await git(appDir, ['checkout', '-q', 'main']);
  return sha;
}

async function setup({ build = {}, reviewer = null, councilTools = {} } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'council-hook-'));
  const projectDir = path.join(root, 'projects', 'acme');
  mkdirSync(projectDir, { recursive: true });
  const baseDir = path.join(root, 'work');
  const appDir = await makeRepo({ 'foundation.json': '{ "tag": "v0.1.0" }\n', 'old.ts': "export const OLD = 'https://old-vendor.co.uk/api';\n" });
  const foundationSha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(appDir, ['branch', `build/${RUN}`]);
  const buildSha = await buildCommit(appDir, { 'apps/server/src/claims/total.ts': TOTAL, 'apps/server/src/db/schema/claims.ts': SCHEMA, ...build }, 'build');

  const prompts = [];
  const script = reviewer ?? (() => ({ text: 'VERDICT: APPROVE' }));
  const team = {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => ({ text: 'x' }) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task, ...rest) => { prompts.push(task); return script(role, task, ...rest); } }),
  };
  const machine = fakeMachine({ id: 'ct111' });
  const prov = fakeProvider({ machine });
  const gates = fakeGatesRun({ codes: { vitest: 1, browser: 1 } });
  const deps = {
    loadProject: async () => ({ client: 'Acme Ltd', foundation: { repo: '/f', tag: 'v0.1.0', commit: foundationSha } }),
    renderBrief: () => '# Acme Ltd',
    run: gates.run,
    helpers: okChecks,
    getMachineProvider: () => prov.provider,
    createSsh: () => failingSsh().ssh,
    baseDir,
  };
  const options = { councilTools: { ...councilStubs(root, {}), axe: false, ...councilTools } };
  const seen = [];
  const args = { projectDir, appDir, sha: buildSha, brief: BRIEF, policy: BRIEF.policy, runId: RUN, slug: 'acme', team, factory: {}, onEvent: (e) => seen.push(e), checks: null };
  return { root, projectDir, appDir, baseDir, foundationSha, buildSha, team, prompts, machine, prov, gates, deps, options, seen, args };
}

// Plan 8's reports for the build commit, in builds/<runId>/reports/ (as in Task 6).
function buildChecks(projectDir) {
  const reports = path.join(projectDir, 'builds', RUN, 'reports');
  mkdirSync(reports, { recursive: true });
  for (const f of ['vitest.json', 'playwright.json', 'crossing.json', 'screenshots']) cpSync(path.join(FX, f), path.join(reports, f), { recursive: true });
  return {
    verify: { status: 'failed', summary: 'The tests fail.', output: '…' },
    browser: { status: 'failed', summary: 'A page check fails.', output: '' },
    reports: ['vitest.json', 'playwright.json', 'crossing.json', 'screenshots'].map((f) => path.join(reports, f)),
  };
}

const workspaces = (baseDir) => { try { return readdirSync(baseDir).filter((n) => n.startsWith('conductor-council-')); } catch { return []; } };

test('the hook: whole app, five members, blocked with a fix, report saved, appDir untouched', async () => {
  const s = await setup();
  const { appDir, projectDir, args, options, deps, seen, prompts, machine } = s;
  const before = (await git(appDir, ['for-each-ref'])).stdout;
  const headBefore = (await git(appDir, ['rev-parse', 'HEAD'])).stdout;
  const r = await runProjectCouncil(args, { options, deps });
  assert.equal(r.status, 'blocked', r.text ?? r.reason);
  assert.deepEqual(seen.find((e) => e.type === 'council-start').members, ['security', 'legal', 'correctness', 'design', 'reliability']);
  for (const t of ['The app connects to vision.googleapis.com, which the data policy does not allow', 'The tests fail',
    'Worked example mileage-claims#1 fails its test', 'A user journey fails in the browser: a member adds a note with a photo (desktop)',
    'The notes page scrolls sideways on a phone (Safari)', 'The reliability test failed at: back up, then test a restore']) assert.match(r.text, new RegExp(escape(t)));
  assert.doesNotMatch(r.text, /old-vendor/);
  assert.match(r.text, /Worked examples proven: 1 of 3/);
  assert.match(r.text, /What was checked:\n {2}- Security: /);
  assert.match(r.text, /\n {2}- Reliability: the reliability test \(deploy, backup, restore, alerts, updates\)/);
  assert.equal(r.fix.title, 'Council fixes, round 1');
  assert.deepEqual(Object.keys(r.fix).sort(), ['instructions', 'title']);
  assert.ok(r.fix.instructions.length <= 3000, 'Ruling R16');
  assert.match(r.fix.instructions, /The reliability test failed at: back up, then test a restore/);
  const md = path.join(projectDir, 'builds', RUN, 'council-report.md');
  assert.equal(readFileSync(md, 'utf8'), r.text);
  assert.ok(r.text.includes(`  Full report: ${md}`));
  assert.ok(r.text.includes(`  Screenshots: ${path.join(projectDir, 'builds', RUN, 'council', 'round-1', 'screenshots')}`));
  assert.deepEqual(seen.filter((e) => e.type === 'council-report-saved').map((e) => e.md), [md]);
  assert.equal(machine.released, 1);
  assert.equal((await git(appDir, ['for-each-ref'])).stdout, before);
  assert.equal((await git(appDir, ['rev-parse', 'HEAD'])).stdout, headBefore);
  assert.equal((await git(appDir, ['status', '--porcelain'])).stdout, '');
  assert.deepEqual(workspaces(s.baseDir), [], 'the council workspace is removed');
  assert.equal(prompts.filter((p) => p.includes('reports/screenshots/')).length, 1);          // Design only
  assert.ok(prompts.some((p) => p.includes("The client's approved brief:\n# Acme Ltd")));
  assert.equal(r.secretSeen, false);
  const json = JSON.parse(readFileSync(path.join(projectDir, 'builds', RUN, 'council-report.json'), 'utf8'));
  assert.equal(Object.keys(json).includes('text'), false);
  assert.equal(json.verdict, 'blocked');
  assert.deepEqual(json.coverage, { proven: 1, total: 3 });
});

test('the hook reuses Plan 8\'s checks for the same commit: no own verify or browser run', async () => {
  const s = await setup();
  const r = await runProjectCouncil({ ...s.args, checks: buildChecks(s.projectDir) }, { options: s.options, deps: s.deps });
  assert.equal(r.status, 'blocked');
  assert.deepEqual(s.gates.calls.map((c) => c.step), [], 'axe is off, and verify and browser come from the build');
  assert.match(r.text, /The tests fail/);
  assert.match(r.text, /The notes page scrolls sideways on a phone \(Safari\)/);
  assert.match(r.text, /- Correctness: the foundation's checks \(install, lint, types, licences, tests, build\) \(from the build's checks\)/);
  assert.match(r.text, /- Design: the page check \(desktop and phone\) \(from the build's checks\), the screen list check \(from the build's checks\)/);
  assert.match(r.text, /the role-crossing tests \(from the build's checks\)/);
});

test('the hook says secretSeen when an added line carries gitleaks:allow, and keeps saying it for the build', async () => {
  const s = await setup({ build: { 'apps/server/src/key.ts': "const k = 'x'; // gitleaks:allow\n" } });
  const r1 = await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
  assert.equal(r1.status, 'blocked');
  assert.equal(r1.secretSeen, true);
  const later = await buildCommit(s.appDir, { 'apps/server/src/key.ts': null }, 'remove the marker');
  const r2 = await runProjectCouncil({ ...s.args, sha: later }, { options: s.options, deps: s.deps });
  assert.doesNotMatch(r2.text, /gitleaks:allow/);
  assert.equal(r2.secretSeen, true, 'sticky for the build');
});

test('the hook again on a fixed commit: round 2, fresh evidence, "Fixed during the review"', async () => {
  const s = await setup();
  const r1 = await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
  assert.match(r1.text, /Round 1/);
  const fixedSha = await buildCommit(s.appDir, { 'apps/server/src/claims/total.ts': 'export const total = (miles: number) => miles * 45;\n' }, 'fix');
  const r2 = await runProjectCouncil({ ...s.args, sha: fixedSha }, { options: s.options, deps: { ...s.deps, createSsh: () => passingSsh().ssh } });
  assert.match(r2.text, /Round 2/);
  assert.match(r2.text, /Fixed during the review[\s\S]*The reliability test failed at: back up, then test a restore/);
  assert.match(r2.text, /Fixed during the review[\s\S]*The app connects to vision\.googleapis\.com/);
  assert.equal(s.prov.calls.filter((c) => c.kind === 'acquire').length, 2, 'fresh evidence for the new commit');
  assert.equal(r2.fix.title, 'Council fixes, round 2');
});

test('the hook on the same commit after a pause: no second machine, no second gate run', async () => {
  let calls = 0;
  const s = await setup({ reviewer: () => (calls++ === 0
    ? { ok: false, failure: 'no-participant', error: 'no AI model is available for codex (codex: rate-limited)' }
    : { text: 'VERDICT: APPROVE' }) });
  const r1 = await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
  assert.deepEqual(r1, { status: 'paused', reason: 'no AI model is available for codex (codex: rate-limited)' });
  const gateCalls = s.gates.calls.length;
  assert.ok(gateCalls > 0);
  assert.deepEqual(workspaces(s.baseDir), [], 'removed after a pause too');
  const r2 = await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
  assert.equal(r2.status, 'blocked');
  assert.match(r2.text, /Round 1/);
  assert.equal(s.prov.calls.filter((c) => c.kind === 'acquire').length, 1);
  assert.equal(s.gates.calls.length, gateCalls);
  assert.equal(s.machine.released, 1);
});

test('a pause after a secret was seen still says secretSeen', async () => {
  let calls = 0;
  const s = await setup({ build: { 'apps/server/src/key.ts': "const k = 'x'; // gitleaks:allow\n" } });
  await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
  const team = { ...s.team, reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: () => (calls++ === 0 ? { ok: false, failure: 'no-participant', error: 'no model' } : { text: 'x' }) }) };
  const later = await buildCommit(s.appDir, { 'apps/server/src/key.ts': null }, 'remove the marker');
  const r = await runProjectCouncil({ ...s.args, sha: later, team }, { options: s.options, deps: s.deps });
  assert.deepEqual(r, { status: 'paused', reason: 'no model', secretSeen: true });
});

test('the hook never throws: an unexpected error pauses the build with a plain reason', async () => {
  const s = await setup();
  const r = await runProjectCouncil({ ...s.args }, { options: s.options, deps: { ...s.deps, loadProject: async () => { throw new Error('The project file could not be read.'); } } });
  assert.deepEqual(r, { status: 'paused', reason: 'The council hit a problem it could not get past (The project file could not be read.), so the build paused. Run "conductor build acme" to try again.' });
});

test('the hook fails closed on an unsafe run id, a bad option, or an unusable commit (Ruling R19)', async () => {
  const s = await setup();
  const bad = await runProjectCouncil({ ...s.args, runId: '../x' }, { options: s.options, deps: s.deps });
  assert.equal(bad.status, 'paused');
  assert.match(bad.reason, /^The council hit a problem it could not get past \(The run id "\.\.\/x" cannot be used in a folder name\.\), so the build paused\./);
  const opt = await runProjectCouncil(s.args, { options: { ...s.options, councilSmokeTimeoutMs: 0 }, deps: s.deps });
  assert.equal(opt.status, 'paused');
  assert.match(opt.reason, /councilSmokeTimeoutMs must be a whole number/);
  const sha = await runProjectCouncil({ ...s.args, sha: 'not-a-sha' }, { options: s.options, deps: s.deps });
  assert.equal(sha.status, 'paused');
  assert.match(sha.reason, /The council needs a build commit to review/);
  const noFoundation = await runProjectCouncil(s.args, { options: s.options, deps: { ...s.deps, loadProject: async () => ({ client: 'Acme Ltd' }) } });
  // No foundation pin: the round falls back to where the build branch started, with a locked warning.
  assert.equal(noFoundation.status, 'blocked');
  assert.match(noFoundation.text, /Conductor could not find the foundation release, so the council reviewed only this build's own changes/);
  assert.deepEqual(workspaces(s.baseDir), []);
});

test('the machine goes away mid-smoke: released, "not proven", no throw (Review Focus 1)', async () => {
  const s = await setup();
  const ssh = { async upload() { return { code: 0, stdout: '', stderr: '' }; }, async exec(m, script) { if (script.includes('run-smoke.sh')) throw new Error('ssh: connection reset'); return { code: 0, stdout: '', stderr: '' }; } };
  const r = await runProjectCouncil(s.args, { options: s.options, deps: { ...s.deps, createSsh: () => ssh } });
  assert.equal(r.status, 'blocked');
  assert.equal(s.machine.released, 1);
  // "not proven" heads the warnings (Ruling R24c's accessibility line may come first).
  assert.match(r.text, /Warnings \(\d+\):\n(?: {2}- \[\w+\] [^\n]*not proven[^\n]*\n)* {2}- \[Reliability\] Reliability was not proven: The reliability test could not run \(ssh: connection reset\)/);
  assert.doesNotMatch(r.text, /The reliability test failed at/);
});

test('the hook redacts what it hands back: an env secret in an interpreter reply never reaches text or fix', async () => {
  const SECRET = 'hunter2-super-secret-value';
  const before = process.env.COUNCIL_TEST_TOKEN;
  process.env.COUNCIL_TEST_TOKEN = SECRET;
  try {
    const ids = ['S1', 'S2', 'L1', 'C1', 'C2', 'C3', 'D1', 'D2', 'R1'];
    const reply = { findings: ids.map((id) => ({ id, decision: 'keep', why: `because ${SECRET}`, fix: `rotate ${SECRET}` })),
      extra: [{ title: `The key ${SECRET} is printed`, why: `seen ${SECRET}`, grade: 'warning' }] };
    const s = await setup({ reviewer: () => ({ text: `\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`` }) });
    const r = await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
    assert.equal(r.status, 'blocked');
    assert.match(r.text, /\[redacted\]/);
    for (const v of [r.text, r.fix.title, r.fix.instructions]) assert.ok(!v.includes(SECRET), v);
    const paused = await runProjectCouncil(s.args, { options: s.options, deps: { ...s.deps, loadProject: async () => { throw new Error(`bad ${SECRET}`); } } });
    assert.ok(!paused.reason.includes(SECRET));
    const p2 = await setup({ reviewer: () => ({ ok: false, failure: 'no-participant', error: `no AI model is available (${SECRET})` }) });
    const noModel = await runProjectCouncil(p2.args, { options: p2.options, deps: p2.deps });
    assert.equal(noModel.status, 'paused');
    assert.ok(!noModel.reason.includes(SECRET), noModel.reason);
  } finally {
    if (before === undefined) delete process.env.COUNCIL_TEST_TOKEN; else process.env.COUNCIL_TEST_TOKEN = before;
  }
});

test('council-report.json names the reviewed commit, the run and secretSeen', async () => {
  const s = await setup({ build: { 'apps/server/src/key.ts': "const k = 'x'; // gitleaks:allow\n" } });
  const r = await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
  assert.equal(r.status, 'blocked');
  const json = JSON.parse(readFileSync(path.join(s.projectDir, 'builds', RUN, 'council-report.json'), 'utf8'));
  assert.deepEqual([json.sha, json.runId, json.secretSeen], [s.buildSha, RUN, true]);
});

test('a pause on a new commit marks an older commit\'s saved report as stale (Plans 11 and 12 never read it as current)', async () => {
  let pause = false;
  const s = await setup({ reviewer: () => (pause ? { ok: false, failure: 'no-participant', error: 'no model' } : { text: 'VERDICT: APPROVE' }) });
  const r1 = await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
  assert.equal(r1.status, 'blocked');
  const dir = path.join(s.projectDir, 'builds', RUN);
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'council-report.json'), 'utf8')).sha, s.buildSha);
  const later = await buildCommit(s.appDir, { 'apps/server/src/claims/total.ts': 'export const total = (m: number) => m * 45;\n' }, 'fix');
  pause = true;
  const r2 = await runProjectCouncil({ ...s.args, sha: later }, { options: s.options, deps: s.deps });
  assert.equal(r2.status, 'paused');
  const json = JSON.parse(readFileSync(path.join(dir, 'council-report.json'), 'utf8'));
  assert.deepEqual(json, { sha: later, runId: RUN, status: 'paused', reason: 'no model' });
  const md = readFileSync(path.join(dir, 'council-report.md'), 'utf8');
  assert.doesNotMatch(md, /Round 1|The reliability test failed/);
  assert.match(md, /paused before it finished/);
  // A pause on the same commit as the saved report leaves that report alone.
  let pause2 = false;
  const s2 = await setup({ reviewer: () => (pause2 ? { ok: false, failure: 'no-participant', error: 'no model' } : { text: 'VERDICT: APPROVE' }) });
  await runProjectCouncil(s2.args, { options: s2.options, deps: s2.deps });
  const before = readFileSync(path.join(s2.projectDir, 'builds', RUN, 'council-report.json'), 'utf8');
  pause2 = true;
  const same = await runProjectCouncil(s2.args, { options: s2.options, deps: s2.deps });
  assert.equal(same.status, 'paused');
  assert.equal(readFileSync(path.join(s2.projectDir, 'builds', RUN, 'council-report.json'), 'utf8'), before);
});

test('a first round that pauses after the secret scanner hid a file still says secretSeen', async () => {
  const s = await setup({ build: { 'apps/server/src/key.ts': "const k = 'x'; // gitleaks:allow\n" },
    reviewer: () => ({ ok: false, failure: 'no-participant', error: 'no model' }) });
  const r = await runProjectCouncil(s.args, { options: s.options, deps: s.deps });
  assert.deepEqual(r, { status: 'paused', reason: 'no model', secretSeen: true });
  const state = JSON.parse(readFileSync(path.join(s.projectDir, 'builds', RUN, 'council', 'state.json'), 'utf8'));
  assert.equal(state.council.secretSeen, true, 'saved, so a later call keeps saying it');
});

test('the resume hint stays plain when the project name is missing', async () => {
  const s = await setup();
  for (const slug of [undefined, null, '']) {
    const r = await runProjectCouncil({ ...s.args, slug }, { options: s.options, deps: { ...s.deps, loadProject: async () => { throw new Error('The project file could not be read.'); } } });
    assert.equal(r.status, 'paused');
    assert.match(r.reason, /Run "conductor build <project>" to try again\.$/);
    assert.doesNotMatch(r.reason, /conductor build (undefined|null|)"/);
  }
});
