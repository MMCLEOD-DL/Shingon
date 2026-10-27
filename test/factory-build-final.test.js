import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runBuild } from '../src/factory/build.js';
import { latestBuild, saveBuild, buildDirOf } from '../src/factory/buildState.js';
import { saveProject } from '../src/factory/projects.js';
import { git } from '../src/workspace.js';
import { squashBuild } from '../src/factory/buildFinal.js';
import { team, setup } from './helpers/buildHarness.js';

const green = { verify: { status: 'passed', summary: 'ok', output: '' }, browser: { status: 'passed', summary: 'ok', output: '' }, reports: [] };
const rev = async (dir, ref) => (await git(dir, ['rev-parse', ref])).stdout.trim();
const gate = (answers) => { const seen = []; return { seen, approveBuild: async (a) => { seen.push(a.summary); return answers.shift(); } }; };

test('approved: main moves to the build, the project is ready, the summary says what was built and what was not checked', async () => {
  const s = await setup();
  const g = gate([true]);
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: { ...s.hooks, ...g }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  const appDir = path.join(s.projectDir, 'app');
  const b = latestBuild(s.projectDir);
  assert.equal(await rev(appDir, 'main'), await rev(appDir, b.branch));
  const project = JSON.parse(readFileSync(path.join(s.projectDir, 'project.json'), 'utf8'));
  assert.equal(project.status, 'ready');
  assert.deepEqual(Object.keys(project.approved).sort(), ['at', 'briefVersion', 'runId', 'sha']);
  assert.deepEqual([project.approved.sha, project.approved.runId, project.approved.briefVersion, project.builtFromBrief],
    [await rev(appDir, 'main'), b.runId, 1, 1]);
  assert.equal((await git(appDir, ['tag', '--points-at', 'main'])).stdout.trim(), '', 'the gate does not cut a release');
  const summary = g.seen[0];
  assert.match(summary, /What was built \(2 features\):\n {2}1\. Submit and list expenses: done\n {2}2\. Monthly report: done/);
  assert.match(summary, /All checks pass/);
  assert.match(summary, /The full council review is not part of this version of Conductor yet/);
  assert.match(summary, /See it running: conductor preview acme-ltd/);
});

test('red whole-app checks become one fix feature, then the checks run again on the new tip', async () => {
  const s = await setup();
  const seen = [];
  const checks = async (o) => { seen.push(o); return seen.length === 2 ? { ...green, browser: { status: 'failed', summary: 'x', output: 'phone layout scrolls sideways' } } : green; };
  const t = team();
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: { ...s.hooks, ...gate([true]) }, deps: { ...s.deps, runAppChecks: checks }, env: {} });
  assert.equal(out.status, 'ready');
  const b = latestBuild(s.projectDir);
  assert.deepEqual(b.features.map((f) => f.id), ['expenses', 'report', 'fix-1']);
  assert.ok(t.local.calls.some((c) => /Make the whole-app checks pass again/.test(c.task) && /phone layout scrolls sideways/.test(c.task)));
  assert.equal(seen.length, 3, 'baseline, red final, green final');
  assert.match(seen[0].reportsDir, /baseline$/);
  assert.notEqual(seen[1].sha, seen[2].sha);
  assert.match((await git(path.join(s.projectDir, 'app'), ['log', '-1', '--format=%s', b.branch])).stdout, /^Fix 3\/3: Make the whole-app checks pass again/);
});

test('the council hook: blocked with a fix → fix feature → council again → approved; its text is in the summary', async () => {
  const s = await setup();
  const calls = [];
  const council = async (a) => { calls.push(a); return calls.length === 1
    ? { status: 'blocked', text: 'Council report: blocked', fix: { title: 'Council fixes, round 1', instructions: 'Hide the totals from members.' } }
    : { status: 'approved', text: 'Council report: approved, nothing to fix' }; };
  const g = gate([true]);
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: { ...s.hooks, ...g, council }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  assert.equal(calls.length, 2);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['appDir', 'brief', 'checks', 'factory', 'onEvent', 'policy', 'projectDir', 'runId', 'sha', 'slug', 'team']);
  assert.equal(calls[0].checks.sha, calls[0].sha, 'the council gets the checks for the same commit');
  assert.equal(calls[0].checks.verify.status, 'passed');
  assert.match(g.seen[0], /Council report: approved, nothing to fix/);
});

test('council fixes have their own cap (factory.build.councilFixRounds), separate from the red-checks cap', async () => {
  const s = await setup();
  const factory = { ...s.factory, build: { ...s.factory.build, fixRounds: 0, councilFixRounds: 2 } };
  let n = 0;
  const council = async () => ({ status: 'blocked', text: `Council report ${++n}: blocked`, fix: { title: `Council fixes, round ${n}`, instructions: 'Hide the totals.' } });
  const escalations = [];
  const hooks = { ...s.hooks, ...gate([true]), council, escalate: async (a) => { escalations.push(a); return 'reject'; } };
  const out = await runBuild({ factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'stopped');
  const b = latestBuild(s.projectDir);
  assert.deepEqual([b.councilFixRounds, b.fixRounds], [2, 0]);
  assert.deepEqual(b.features.map((f) => f.id), ['expenses', 'report', 'fix-1', 'fix-2']);
  assert.equal(escalations.length, 1, 'blocked at the cap goes to the operator');
  assert.equal(escalations[0].kind, 'council');
});

test('secretSeen: the build branch becomes one commit with the same files before the gate', async () => {
  const s = await setup();
  const council = async () => ({ status: 'approved', text: 'Council report: approved', secretSeen: true });
  const g = gate([true]);
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: { ...s.hooks, ...g, council }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  const appDir = path.join(s.projectDir, 'app');
  const b = latestBuild(s.projectDir);
  const tag = (await git(appDir, ['rev-parse', 'refs/foundation/v0.1.0^{commit}'])).stdout.trim();   // ruling Q6
  assert.equal((await git(appDir, ['rev-list', '--count', `${tag}..main`])).stdout.trim(), '1');
  assert.equal(b.squashedSha, await rev(appDir, 'main'));
  assert.match(g.seen[0], /combined into one commit/);
});

test('operator feedback becomes a fix feature and the gate is asked again; reject leaves main alone', async () => {
  const s = await setup();
  const g = gate([{ note: 'Make the report totals bold.' }, false]);
  const t = team();
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: { ...s.hooks, ...g }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'rejected');
  assert.equal(g.seen.length, 2);
  assert.ok(t.local.calls.some((c) => /Make the report totals bold\./.test(c.task)));
  const appDir = path.join(s.projectDir, 'app');
  assert.notEqual(await rev(appDir, 'main'), await rev(appDir, latestBuild(s.projectDir).branch));
  const project = JSON.parse(readFileSync(path.join(s.projectDir, 'project.json'), 'utf8'));
  assert.deepEqual([project.status, project.approved], ['building', null]);
  assert.match(out.reason, /You did not approve the build\. The app's main branch is unchanged/);
});

test('a crash after main moved but before the build was saved: the next run finishes without asking again', async () => {
  const s = await setup();
  const pause = async (bctx) => { bctx.build.phase = 'gate'; bctx.build.status = 'paused'; bctx.save(); return { status: 'paused', runId: bctx.build.runId, buildDir: bctx.buildDir, reason: 'p' }; };
  await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, runFinal: pause }, env: {} });
  const appDir = path.join(s.projectDir, 'app');
  const b = latestBuild(s.projectDir);
  await git(appDir, ['update-ref', 'refs/heads/main', await rev(appDir, b.branch)]);
  const g = gate([]);
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: { ...s.hooks, ...g }, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  assert.equal(g.seen.length, 0);
  assert.equal(JSON.parse(readFileSync(path.join(s.projectDir, 'project.json'), 'utf8')).approved.sha, await rev(appDir, 'main'));
});

test('red verify still red after the fix rounds stops the build; a red browser gate at the cap goes to the operator', async () => {
  const s = await setup();
  const factory = { ...s.factory, build: { ...s.factory.build, fixRounds: 1 } };
  const red = { ...green, verify: { status: 'failed', summary: 'The main checks failed.', output: 'lint: 3 problems' } };
  let n = 0;
  const out = await runBuild({ factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: { ...s.hooks, ...gate([true]) }, deps: { ...s.deps, runAppChecks: async () => (++n === 1 ? green : red) }, env: {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /The whole-app checks still fail after 1 round of fixes.*The checks FAIL: lint: 3 problems\. The build is kept/);
  assert.deepEqual(latestBuild(s.projectDir).features.map((f) => f.id), ['expenses', 'report', 'fix-1']);

  const b = await setup();
  const asked = [];
  const g = gate([true]);
  const browserRed = { ...green, browser: { status: 'failed', summary: 'The browser checks failed.', output: 'phone layout scrolls sideways\nmore' } };
  let m = 0;
  const hooks = { ...b.hooks, ...g, escalate: async (a) => { asked.push(a); return 'approve'; } };
  const out2 = await runBuild({ factory: { ...b.factory, build: { ...b.factory.build, fixRounds: 0 } }, slug: b.slug, baseDir: b.baseDir, team: team(), hooks, deps: { ...b.deps, runAppChecks: async () => (++m === 1 ? green : browserRed) }, env: {} });
  assert.equal(out2.status, 'ready');
  assert.deepEqual([asked.length, asked[0].kind, asked[0].title, asked[0].options], [1, 'build', 'the browser checks', ['approve', 'reject']]);
  assert.match(asked[0].message, /The first failure: phone layout scrolls sideways\n/);
  assert.match(g.seen[0], /The browser checks failed and you approved the build anyway\./);
});

test('a council hook that gives no usable answer counts as blocked and goes to the operator', async () => {
  const s = await setup();
  const asked = [];
  const hooks = { ...s.hooks, ...gate([true]), council: async () => ({ status: 'fine' }), escalate: async (a) => { asked.push(a); return 'reject'; } };
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /the council still found problems/);
  assert.match(asked[0].message, /The council gave no usable answer/);
});

test('squashBuild is re-entrant and refuses a branch that moved', async () => {
  const s = await setup();
  const pause = async (bctx) => bctx.finish('paused', 'p');
  await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, runFinal: pause }, env: {} });
  const appDir = path.join(s.projectDir, 'app');
  const b = latestBuild(s.projectDir);
  const sha = await rev(appDir, b.branch);
  const onto = await rev(appDir, 'main');
  const args = { appDir, branch: b.branch, sha, onto, message: 'one' };
  const first = await squashBuild(args);
  assert.equal(await rev(appDir, `${first}^{tree}`), await rev(appDir, `${sha}^{tree}`));
  assert.equal(await rev(appDir, `${first}^`), onto);
  assert.equal(await squashBuild(args), first, 'a second call returns the same commit');
  await git(appDir, ['update-ref', `refs/heads/${b.branch}`, onto]);
  await assert.rejects(squashBuild(args), /is not where Conductor left it/);
});

test('review fix 1: a stop on red checks drops the cached result, so the retry runs the checks again', async () => {
  for (const kind of ['verify', 'browser']) {
    const s = await setup();
    const factory = { ...s.factory, build: { ...s.factory.build, fixRounds: 0 } };
    const red = kind === 'verify'
      ? { ...green, verify: { status: 'failed', summary: 'The main checks failed.', output: 'no database' } }
      : { ...green, browser: { status: 'failed', summary: 'The browser checks failed.', output: 'no browser' } };
    let n = 0;
    const first = await runBuild({ factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: { ...s.hooks, ...gate([true]) }, deps: { ...s.deps, runAppChecks: async () => (++n === 1 ? green : red) }, env: {} });
    assert.equal(first.status, 'stopped', kind);
    assert.equal(latestBuild(s.projectDir).checks, null, `${kind}: the red result is not kept`);
    let calls = 0;
    const g = gate([true]);
    const again = await runBuild({ factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: { ...s.hooks, ...g }, deps: { ...s.deps, runAppChecks: async () => { calls++; return green; } }, env: {} });
    assert.equal(again.status, 'ready', kind);
    assert.equal(again.runId, first.runId);
    assert.deepEqual([calls, g.seen.length], [1, 1]);
    assert.deepEqual(latestBuild(s.projectDir).features.map((f) => f.id), ['expenses', 'report'], `${kind}: no fix units at the cap`);
  }
});

test('review fix 2: a crash after project.json said ready but before the build was finished is tidied on the next run', async () => {
  const s = await setup();
  const pause = async (bctx) => bctx.finish('paused', 'p');
  await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, runFinal: pause }, env: {} });
  const appDir = path.join(s.projectDir, 'app');
  const b = latestBuild(s.projectDir);
  const sha = await rev(appDir, b.branch);
  await git(appDir, ['update-ref', 'refs/heads/main', sha]);
  const project = JSON.parse(readFileSync(path.join(s.projectDir, 'project.json'), 'utf8'));
  saveProject(s.projectDir, { ...project, status: 'ready', approved: { sha, at: '2026-10-27T12:00:00.000Z', runId: b.runId, briefVersion: 1 }, builtFromBrief: 1 });
  saveBuild(buildDirOf(s.projectDir, b.runId), { ...b, phase: 'gate', status: 'running' });
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /already built and approved/);
  const after = latestBuild(s.projectDir);
  assert.deepEqual([after.status, after.phase], ['ready', 'done']);
});

test('review fix 3 and 4: a council fix without a title and instructions is no fix; the log records the status as saved', async () => {
  const s = await setup();
  const asked = [];
  const council = async () => ({ status: 'blocked', text: 'Council report: blocked', fix: { instructions: 'Hide the totals.' } });
  const hooks = { ...s.hooks, ...gate([true]), council, escalate: async (a) => { asked.push(a); return 'reject'; } };
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'stopped');
  const b = latestBuild(s.projectDir);
  assert.deepEqual([asked.length, b.councilFixRounds, b.features.length], [1, 0, 2]);

  const g = await setup();
  const hooks2 = { ...g.hooks, ...gate([true]), council: async () => ({ status: 'fine' }), escalate: async () => 'reject' };
  await runBuild({ factory: g.factory, slug: g.slug, baseDir: g.baseDir, team: team(), hooks: hooks2, deps: { ...g.deps, runAppChecks: async () => green }, env: {} });
  const events = readFileSync(path.join(buildDirOf(g.projectDir, latestBuild(g.projectDir).runId), 'build-log.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.type === 'build-council');
  assert.deepEqual(events.map((e) => e.status), ['blocked']);
});
