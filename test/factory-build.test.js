import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runBuild } from '../src/factory/build.js';
import { factoryConfig } from '../src/factory/config.js';
import { latestBuild, buildDirOf } from '../src/factory/buildState.js';
import { mergeFeature as realMerge } from '../src/factory/buildState.js';
import { git } from '../src/workspace.js';
import { fakeParticipant, approve } from './helpers/fakes.js';
import { sampleBrief } from './helpers/factoryFixtures.js';
import { UNITS, json, PLAN, team, setup as baseSetup, log } from './helpers/buildHarness.js';
import { lockProject } from '../src/factory/projectLock.js';

// runFinal is stubbed here: these tests cover the phases before it (test/factory-build-final.test.js covers it).
async function setup(opts) {
  const s = await baseSetup(opts);
  s.finals = [];
  s.deps.runFinal = async (bctx) => { s.finals.push(bctx); return { status: 'ready', runId: bctx.build.runId, buildDir: bctx.buildDir }; };
  return s;
}

test('a fresh build: app made and named, features split and built tests-first, one commit each, then the final phase', async () => {
  const s = await setup();
  const t = team();
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(out.status, 'ready');
  const project = JSON.parse(readFileSync(path.join(s.projectDir, 'project.json'), 'utf8'));
  assert.equal(project.status, 'building');
  assert.deepEqual(Object.keys(project.foundation), ['repo', 'tag', 'commit']);
  assert.deepEqual([project.approved, project.builtFromBrief], [null, null], 'only the gate records an approval');
  const b = latestBuild(s.projectDir);
  assert.equal(b.briefVersion, 1);
  assert.deepEqual(b.features.map((f) => f.status), ['merged', 'merged']);
  const appDir = path.join(s.projectDir, 'app');
  assert.deepEqual((await log(appDir, b.branch)).slice(0, 3), ['Feature 2/2: Monthly report (report)', 'Feature 1/2: Submit and list expenses (expenses)', 'Name the app: Acme Ltd']);
  assert.deepEqual(await log(appDir, 'main'), (await log(appDir, b.branch)).slice(3), 'main is untouched until the operator approves');
  const firstSteps = t.local.calls.filter((c) => /You are doing chunk 1 of/.test(c.task)).map((c) => c.task.match(/chunk 1 of \d+: (.*)/)[1]);
  assert.deepEqual(firstSteps, ['Acceptance tests', 'Acceptance tests']);
  assert.equal(s.checks.length, 1, 'one baseline check on main');
  assert.equal(s.checks[0].browser, false);
  assert.equal(s.finals.length, 1);
  assert.equal((await git(appDir, ['branch', '--list', 'conductor/*'])).stdout.trim(), '', 'feature branches are cleaned up');
});

test('refusals before anything is spent', async () => {
  for (const [over, re] of [
    [{ status: 'ready' }, /already built and approved/],
    [{ status: 'shipped' }, /already built and approved/],
  ]) {
    const s = await setup(over);
    const t = team();
    const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: s.hooks, deps: s.deps, env: {} });
    assert.equal(out.status, 'failed');
    assert.match(out.reason, re);
    assert.equal(t.author.calls.length, 0);
  }
  const s = await setup({ testCommand: null });
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: s.deps, env: {} });
  assert.match(out.reason, /TEST_DATABASE_URL is not set/);
  const m = await setup();
  const out2 = await runBuild({ factory: m.factory, slug: m.slug, baseDir: m.baseDir, team: team(), hooks: m.hooks, deps: { ...m.deps, loadBrief: () => sampleBrief({ modules: ['ocr'] }) }, env: {} });
  assert.match(out2.reason, /optional modules \(ocr\)/);
});

test('runBuild never takes the project lock: it runs under the lock its caller holds (Contract 7 §7.11)', async () => {
  const s = await setup();
  const release = lockProject(s.projectDir, 'build');   // what the build command (Task 15) does around runBuild
  try {
    const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: s.deps, env: {} });
    assert.doesNotMatch(out.reason ?? '', /busy/);
  } finally { release(); }
});

test('a red baseline stops before the split', async () => {
  const s = await setup();
  const t = team();
  const red = async () => ({ verify: { status: 'failed', summary: 'The checks FAIL', output: 'no database' }, browser: { status: 'skipped', summary: '', output: '' }, reports: [] });
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: s.hooks, deps: { ...s.deps, runAppChecks: red }, env: {} });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /The foundation does not pass its own checks on this computer/);
  assert.equal(t.author.calls.length, 0);
});

test('a crash between landing a feature and merging it: the next run merges it once and does not rebuild it', async () => {
  const s = await setup();
  let crashed = false;
  const merge = async (a) => { if (!crashed) { crashed = true; throw new Error('power cut'); } return realMerge(a); };
  const first = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, mergeFeature: merge }, env: {} });
  assert.equal(first.status, 'failed');
  assert.match(first.reason, /Conductor hit an internal problem and stopped.*conductor build acme-ltd/s);
  assert.equal(latestBuild(s.projectDir).features[0].status, 'landed');
  const t2 = team();
  const second = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t2, hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(second.status, 'ready');
  assert.equal(second.runId, first.runId, 'the same build carried on');
  assert.equal(t2.local.calls.some((c) => /\(expenses\)/.test(c.task)), false, 'feature 1 was not built again');
  const appDir = path.join(s.projectDir, 'app');
  assert.equal((await log(appDir, `build/${first.runId}`)).filter((l) => l.startsWith('Feature 1/2')).length, 1);
});

test('a feature whose checks fail is not accepted: the build stops, and the next run starts that feature again', async () => {
  const s = await setup({ testCommand: 'node -e "process.exit(1)"' });
  // councilFixRounds here is Plan 5's per-feature-run option (no bounce-back), not factory.build.councilFixRounds
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: s.deps, options: { councilFixRounds: 0 }, env: {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /Feature 1 \(Submit and list expenses\) was not accepted/);
  assert.match(out.reason, /conductor build acme-ltd/);
  const b = latestBuild(s.projectDir);
  assert.equal(b.features[0].status, 'stopped');
  const fixed = factoryConfig({ factory: { ...s.raw, build: { testCommand: 'node -e "process.exit(0)"', browserGate: false } } }, { env: {} });
  const again = await runBuild({ factory: fixed, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(again.status, 'ready');
  assert.equal(latestBuild(s.projectDir).features[0].attempts, 2);
});

test('a brief changed since the build started is refused; --new starts a fresh build', async () => {
  const s = await setup();
  const stop = { ...s.deps, runFinal: async (bctx) => { bctx.build.status = 'paused'; bctx.save(); return { status: 'paused', runId: bctx.build.runId, buildDir: bctx.buildDir, reason: 'p' }; } };
  const first = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: stop, env: {} });
  const changed = { ...s.deps, loadBrief: () => sampleBrief({ purpose: 'Something else entirely.' }) };
  const refused = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: changed, env: {} });
  assert.equal(refused.status, 'failed');
  assert.match(refused.reason, /The brief has changed since build .* started/);
  const fresh = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: changed, options: { newBuild: true }, env: {} });
  assert.notEqual(fresh.runId, first.runId);
  assert.equal(JSON.parse(readFileSync(path.join(buildDirOf(s.projectDir, first.runId), 'build.json'), 'utf8')).reason, `Replaced by build ${fresh.runId}.`);
});

test('a brief with a malformed example id is refused in plain English before anything is spent (ruling Q22)', async () => {
  const s = await setup();
  const t = team();
  const bad = sampleBrief();
  bad.features[0].acceptance[0].id = 'x';
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: s.hooks, deps: { ...s.deps, loadBrief: () => bad }, env: {} });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /has the id "x", which is not in the form feature-id#number/);
  assert.equal(t.author.calls.length, 0);
  assert.equal(s.checks.length, 0);
});

test('a damaged newest build.json is reported plainly, not skipped; --new starts afresh (ruling Q27 d)', async () => {
  const s = await setup();
  const stop = { ...s.deps, runFinal: async (bctx) => bctx.finish('paused', 'p') };
  const first = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: stop, env: {} });
  writeFileSync(path.join(buildDirOf(s.projectDir, first.runId), 'build.json'), '{ not json');
  const t = team();
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, new RegExp(`The saved state of build ${first.runId} cannot be read.*--new`));
  assert.equal(t.author.calls.length, 0);
  const fresh = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: s.deps, options: { newBuild: true }, env: {} });
  assert.equal(fresh.status, 'ready');
  assert.notEqual(fresh.runId, first.runId);
});

test('feature runs get the factory options: verify, kept workspace, the feature council, tags and the fixed first step; newBuild and approvePlan are stripped', async () => {
  const s = await setup();
  const seen = [];
  const { runTask } = await import('../src/conductor.js');
  const spy = async (a) => { seen.push(a); return runTask(a); };
  const plans = [];
  const hooks = { ...s.hooks, approvePlan: async (p) => { plans.push(p); return true; } };
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks, deps: { ...s.deps, runTask: spy }, options: { newBuild: true, approvePlan: true, councilFixRounds: 1 }, env: {} });
  assert.equal(out.status, 'ready');
  assert.deepEqual(plans, [{ summary: 'Features to build, in order:', steps: ['Submit and list expenses', 'Monthly report'] }]);
  assert.equal(seen.length, 2);
  const o = seen[0].options;
  assert.equal(o.testCommand, 'node -e "process.exit(0)"');
  assert.equal(o.keepWorkspace, true);
  assert.equal(o.council, true);
  assert.equal(o.councilFixRounds, 1);
  assert.deepEqual(o.councilMembers, ['foundation', 'correctness']);
  assert.deepEqual(o.factoryFeature, { id: 'expenses', tags: ['submit-expense#1', 'submit-expense#2'] });
  assert.equal(o.firstChunk.title, 'Acceptance tests');
  for (const k of ['newBuild', 'approvePlan', 'change']) assert.equal(k in o, false, `${k} is stripped`);
  assert.equal(seen[0].baseDir, s.baseDir);
  assert.match(seen[1].request, /^Build step 2 of 2 for Acme Ltd: Monthly report \(report\)/);
});

test('the operator not approving the feature list stops the build before any feature is built', async () => {
  const s = await setup();
  const t = team();
  const hooks = { ...s.hooks, approvePlan: async () => 'yes' };
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks, deps: s.deps, options: { approvePlan: true }, env: {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /You did not approve the list of features/);
  assert.equal(t.local.calls.length, 0);
});

test('a crash after a feature run landed but before the build recorded it: the next run takes the landed branch and does not rebuild it', async () => {
  const s = await setup();
  const { runTask } = await import('../src/conductor.js');
  let crashed = false;
  const crashy = async (a) => { const r = await runTask(a); if (!crashed) { crashed = true; throw new Error('power cut'); } return r; };
  const first = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, runTask: crashy }, env: {} });
  assert.equal(first.status, 'failed');
  assert.match(first.reason, /internal problem/);
  assert.equal(latestBuild(s.projectDir).features[0].status, 'running');
  const t2 = team();
  const second = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t2, hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(second.status, 'ready');
  assert.equal(t2.local.calls.some((c) => /\(expenses\)/.test(c.task)), false, 'feature 1 was not built again');
  const b = latestBuild(s.projectDir);
  assert.deepEqual(b.features.map((f) => [f.status, f.attempts]), [['merged', 1], ['merged', 1]]);
  const appDir = path.join(s.projectDir, 'app');
  assert.equal((await log(appDir, b.branch)).filter((l) => l.startsWith('Feature 1/2')).length, 1);
  assert.equal(existsSync(b.features[0].transcript), true);
});

test('a crash after the merge but before build.json was saved: the next run neither merges twice nor rebuilds', async () => {
  const s = await setup();
  let crashed = false;
  const merge = async (a) => { const sha = await realMerge(a); if (!crashed) { crashed = true; throw new Error('power cut'); } return sha; };
  const first = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, mergeFeature: merge }, env: {} });
  assert.equal(first.status, 'failed');
  const saved = latestBuild(s.projectDir).features[0];
  assert.equal(saved.status, 'landed');
  assert.ok(saved.landedSha && saved.baseSha, 'landedSha and expectedBase were saved before the merge (ruling Q27 c)');
  const t2 = team();
  const second = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t2, hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(second.status, 'ready');
  assert.equal(t2.local.calls.some((c) => /\(expenses\)/.test(c.task)), false);
  const appDir = path.join(s.projectDir, 'app');
  const lines = await log(appDir, `build/${first.runId}`);
  assert.equal(lines.filter((l) => l.startsWith('Feature 1/2')).length, 1);
  assert.equal(lines.filter((l) => l.startsWith('Feature 2/2')).length, 1);
});

test('a feature run that failed is resumed, not started again', async () => {
  const s = await setup();
  const t = team();
  let badPlan = true;
  t.author = fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, task) => (role === 'reviewer' ? approve() : /Split this approved brief/.test(task) ? json({ units: UNITS }) : badPlan ? { text: 'no plan here' } : json(PLAN)) });
  const first = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(first.status, 'failed');
  assert.match(first.reason, /could not get a usable plan/);
  assert.equal(latestBuild(s.projectDir).features[0].status, 'failed');
  badPlan = false;
  const { resume } = await import('../src/conductor.js');
  let resumed = 0;
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: s.hooks, deps: { ...s.deps, resume: async (a) => { resumed++; return resume(a); } }, env: {} });
  assert.equal(out.status, 'ready');
  assert.equal(resumed, 1);
  assert.equal(latestBuild(s.projectDir).features[0].attempts, 1);
});

test('a final-review concern goes to the operator; reject stops the build with the reason', async () => {
  const s = await setup();
  const t = team();
  t.reviewer = fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task) => (/member of a review council/.test(task) ? json({ findings: [] }) : /Review the whole branch/.test(task) ? { verdict: { decision: 'BLOCK', reason: 'the totals look wrong' } } : approve()) });
  const asked = [];
  const hooks = { ...s.hooks, escalate: async (e) => { asked.push(e); return 'reject'; } };
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks, deps: s.deps, env: {} });
  assert.equal(asked.length, 1);
  assert.deepEqual([asked[0].kind, asked[0].title, asked[0].options], ['feature', 'feature 1 of 2 (Submit and list expenses)', ['approve', 'reject']]);
  assert.match(asked[0].message, /^Conductor needs your decision on: feature 1 of 2 \(Submit and list expenses\)\n\nWhat happened: The final review/);
  assert.match(asked[0].message, /The concern: the totals look wrong/);
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /Feature 1 \(Submit and list expenses\) was not accepted: you did not accept the reviewer's concern\./);
});

test('a crash inside the merge after the build branch moved but before the checkout followed: the next run finishes it with one commit', async () => {
  const s = await setup();
  let crashed = false;
  // Does mergeFeature's first half (commit + move the branch ref) and dies before reset --hard: the index still holds the old base.
  const merge = async (a) => {
    if (crashed) return realMerge(a);
    crashed = true;
    const next = (await git(a.appDir, ['commit-tree', `${a.landedSha}^{tree}`, '-p', a.expectedBase, '-m', a.message])).stdout.trim();
    await git(a.appDir, ['update-ref', `refs/heads/${a.buildBranch}`, next, a.expectedBase]);
    throw new Error('power cut');
  };
  const first = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, mergeFeature: merge }, env: {} });
  assert.equal(first.status, 'failed');
  const appDir = path.join(s.projectDir, 'app');
  assert.notEqual((await git(appDir, ['status', '--porcelain'])).stdout.trim(), '', 'the checkout is stale, as after a real crash');
  const t2 = team();
  const second = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t2, hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(second.status, 'ready', second.reason);
  assert.equal(t2.local.calls.some((c) => /\(expenses\)/.test(c.task)), false);
  const lines = await log(appDir, `build/${first.runId}`);
  assert.equal(lines.filter((l) => l.startsWith('Feature 1/2')).length, 1);
  assert.equal(lines.filter((l) => l.startsWith('Feature 2/2')).length, 1);
  assert.equal((await git(appDir, ['status', '--porcelain'])).stdout.trim(), '');
});
