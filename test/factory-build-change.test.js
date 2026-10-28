// Plan 11 Task 4: Plan 8's runBuild in change mode (options.change) — a change built on a live app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { runBuild, NOT_LIVE_YET, BASE_REF_MISSING } from '../src/factory/build.js';
import { latestBuild, loadBuild, buildDirOf, newBuild } from '../src/factory/buildState.js';
import { saveProject, loadProject } from '../src/factory/projects.js';
import { lockProject } from '../src/factory/projectLock.js';
import { appProfileOf } from '../src/factory/app.js';
import { runTask as realRunTask } from '../src/conductor.js';
import { git } from '../src/workspace.js';
import { sampleBrief } from './helpers/factoryFixtures.js';
import { team, setup } from './helpers/buildHarness.js';

const RUN_ID = '20261027-143205-a1b2';
const green = { verify: { status: 'passed', summary: 'ok', output: '' }, browser: { status: 'passed', summary: 'ok', output: '' }, reports: [] };
const rev = async (dir, ref) => (await git(dir, ['rev-parse', ref])).stdout.trim();
const approvedCouncil = async () => ({ status: 'approved', text: 'Council report: approved' });

const UNIT_ADDED = {
  id: 'report-by-team', title: 'Monthly report by team', covers: ['monthly-report'], acceptance: ['monthly-report#1'],
  instructions: 'Add team totals to the monthly report.', dependsOn: [], kind: 'feature', change: 'added', retire: [],
};
const UNIT_CHANGED = {
  id: 'expenses-change', title: 'Change expense entry', covers: ['submit-expense'], acceptance: [],
  instructions: 'Stop asking for the VAT. Tests tagged [submit-expense#3] prove an example the client no longer wants: change or remove those tests only.',
  dependsOn: [], kind: 'fix', change: 'changed', retire: ['submit-expense#3'],
};
const change = (over = {}) => ({ runId: RUN_ID, baseRef: 'main', units: [UNIT_ADDED], profile: null, ...over });

// A project built and approved through Plan 8's normal path, then marked as the test needs.
async function live({ status = 'ready' } = {}) {
  const s = await setup();
  const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: team(), hooks: s.hooks, deps: { ...s.deps, runAppChecks: async () => green }, env: {} });
  assert.equal(out.status, 'ready');
  s.firstRunId = out.runId;
  s.appDir = path.join(s.projectDir, 'app');
  s.projectJson = path.join(s.projectDir, 'project.json');
  if (status !== 'ready') saveProject(s.projectDir, { ...loadProject(s.projectDir), status });
  return s;
}

const run = (s, { change: c = change(), hooks = {}, deps = {}, t = team() } = {}) => runBuild({
  factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t,
  hooks: { ...s.hooks, council: approvedCouncil, ...hooks }, deps: { ...s.deps, runAppChecks: async () => green, ...deps },
  options: { change: c }, env: {},
});

const buildsOf = (s) => readdirSync(path.join(s.projectDir, 'builds')).sort();

async function sideBranch(appDir) {
  await git(appDir, ['checkout', '-q', '-b', 'side']);
  writeFileSync(path.join(appDir, 'side.txt'), 'side\n');
  await git(appDir, ['add', 'side.txt']);
  await git(appDir, ['commit', '-q', '-m', 'side work']);
  await git(appDir, ['checkout', '-q', 'main']);
  return rev(appDir, 'side');
}

test('without options.change, a ready or shipped project is still refused', async () => {
  for (const status of ['ready', 'shipped']) {
    const s = await setup({ status });
    const t = team();
    const out = await runBuild({ factory: s.factory, slug: s.slug, baseDir: s.baseDir, team: t, hooks: s.hooks, deps: s.deps, env: {} });
    assert.equal(out.status, 'failed');
    assert.match(out.reason, /^Acme Ltd is already built and approved\. Changes to a finished app go through "conductor change acme-ltd"\.$/);
    assert.equal(t.author.calls.length, 0);
  }
});

test('change mode refuses a project that is not ready or shipped', async () => {
  for (const status of ['briefing', 'building']) {
    const s = await setup({ status });
    const t = team();
    const out = await run(s, { t });
    assert.deepEqual([out.status, out.reason], ['failed', NOT_LIVE_YET]);
    assert.equal(t.author.calls.length, 0);
  }
  assert.equal(NOT_LIVE_YET, 'This project has not been built and approved yet, so there is nothing to change. Build it first with "conductor build <slug>".');
});

test('change mode: no createApp, no split, no project.json write; the build branch starts from baseRef', async () => {
  for (const status of ['ready', 'shipped']) {
    const s = await live({ status });
    const sideSha = await sideBranch(s.appDir);
    const before = readFileSync(s.projectJson, 'utf8');
    const t = team();
    const out = await run(s, { change: change({ baseRef: 'side' }), t });
    assert.equal(out.status, 'approved', out.reason);
    assert.equal(readFileSync(s.projectJson, 'utf8'), before);
    assert.equal(t.author.calls.filter((c) => /Split this approved brief/.test(c.task)).length, 0, 'no split');
    const build = loadBuild(buildDirOf(s.projectDir, RUN_ID));
    assert.equal(build.kind, 'change');
    assert.equal(build.startSha, sideSha);
    assert.deepEqual(build.units.map((u) => u.id), ['report-by-team']);
    assert.equal(await rev(s.appDir, `${build.branch}~1`), sideSha, 'the build branch starts from baseRef');
  }
});

test('change mode never moves main; the gate is told the sha, branch, council and checks; the app is back on main', async () => {
  const s = await live();
  const mainBefore = await rev(s.appDir, 'main');
  let seen;
  const out = await run(s, { hooks: { approveBuild: async (a) => { seen = a; return true; } } });
  assert.equal(out.status, 'approved', out.reason);
  assert.deepEqual(Object.keys(out).sort(), ['branch', 'buildDir', 'runId', 'sha', 'status']);
  assert.equal(await rev(s.appDir, 'main'), mainBefore);
  assert.equal(out.sha, await rev(s.appDir, `build/${RUN_ID}`));
  assert.equal(out.branch, `build/${RUN_ID}`);
  assert.equal(out.runId, RUN_ID);
  assert.equal(seen.sha, out.sha);
  assert.equal(seen.branch, 'build/20261027-143205-a1b2');
  assert.equal(seen.runId, RUN_ID);
  assert.match(seen.summary, /Monthly report by team: done/);
  assert.equal(seen.council.sha, out.sha);
  assert.equal(seen.checks.sha, out.sha);
  assert.equal((await git(s.appDir, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim(), 'main');
  assert.equal((await git(s.appDir, ['status', '--porcelain'])).stdout.trim(), '');
  const build = loadBuild(buildDirOf(s.projectDir, RUN_ID));
  assert.deepEqual([build.status, build.phase], ['approved', 'done']);
});

test('a blocked council the operator approves past is saved as overridden and passed to the gate', async () => {
  const s = await live();
  let seen;
  const out = await run(s, { hooks: {
    council: async () => ({ status: 'blocked', text: 'Council report: blocked' }),
    escalate: async () => 'approve',
    approveBuild: async (a) => { seen = a; return true; },
  } });
  assert.equal(out.status, 'approved', out.reason);
  assert.equal(seen.council.overridden, true);
  assert.equal(seen.council.status, 'blocked');
  assert.equal(loadBuild(buildDirOf(s.projectDir, RUN_ID)).council.overridden, true);
});

test("the operator's feedback note still becomes a fix unit in change mode; false is rejected with main unchanged", async () => {
  const s = await live();
  const mainBefore = await rev(s.appDir, 'main');
  const before = readFileSync(s.projectJson, 'utf8');
  const answers = [{ note: 'Make the team totals bold.' }, false];
  const t = team();
  const out = await run(s, { t, hooks: { approveBuild: async () => answers.shift() } });
  assert.equal(out.status, 'rejected');
  assert.ok(t.local.calls.some((c) => /Make the team totals bold\./.test(c.task)));
  assert.deepEqual(loadBuild(buildDirOf(s.projectDir, RUN_ID)).features.map((f) => f.id), ['report-by-team', 'feedback-1']);
  assert.equal(await rev(s.appDir, 'main'), mainBefore);
  assert.equal(readFileSync(s.projectJson, 'utf8'), before);
});

test('calling runBuild again on an approved change build returns the same outcome without asking', async () => {
  const s = await live();
  const first = await run(s);
  assert.equal(first.status, 'approved', first.reason);
  let asked = 0;
  let checked = 0;
  const again = await run(s, {
    hooks: { approveBuild: async () => { asked++; return false; }, council: async () => { asked++; return { status: 'blocked', text: 'x' }; } },
    deps: { runAppChecks: async () => { checked++; return green; } },
  });
  assert.deepEqual(again, first);
  assert.deepEqual([asked, checked], [0, 0]);
});

test('a profile that differs from app-profile.json is committed on the build branch before any feature; an equal one is not', async () => {
  const s = await live();
  const startSha = await rev(s.appDir, 'main');
  const profile = { schema: 1, modules: [], policy: { outbound: ['postmark'], residency: 'uk-eu' } };
  const out = await run(s, { change: change({ profile }) });
  assert.equal(out.status, 'approved', out.reason);
  const commits = (await git(s.appDir, ['rev-list', '--reverse', `${startSha}..build/${RUN_ID}`])).stdout.trim().split('\n');
  assert.equal(commits.length, 2);
  assert.equal((await git(s.appDir, ['log', '-1', '--format=%s', commits[0]])).stdout.trim(), 'Update the app profile from the brief');
  assert.deepEqual((await git(s.appDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', commits[0]])).stdout.trim().split('\n'), ['app-profile.json']);
  assert.equal((await git(s.appDir, ['show', `${commits[0]}:app-profile.json`])).stdout, JSON.stringify(profile, null, 2) + '\n');

  const e = await live();
  const eStart = await rev(e.appDir, 'main');
  const p = appProfileOf(sampleBrief());
  const equal = { policy: { residency: p.policy.residency, outbound: p.policy.outbound }, modules: p.modules, schema: 1 };   // same, keys reordered
  const out2 = await run(e, { change: change({ profile: equal }) });
  assert.equal(out2.status, 'approved', out2.reason);
  const subjects = (await git(e.appDir, ['log', '--format=%s', `${eStart}..build/${RUN_ID}`])).stdout.trim().split('\n');
  assert.deepEqual(subjects, ['Feature 1/1: Monthly report by team (report-by-team)']);
});

test('runBuild takes no project lock in change mode either (Contract 7 §7.11)', async () => {
  const s = await live();
  const release = lockProject(s.projectDir, 'change');
  try {
    const out = await run(s);
    assert.equal(out.status, 'approved', out.reason);
    assert.doesNotMatch(out.reason ?? '', /busy|in use|already/i);
  } finally { release(); }
});

test('a missing baseRef, an option-like baseRef or a bad run id is refused before anything is created', async () => {
  const s = await live();
  const builds = buildsOf(s);
  const t = team();
  for (const baseRef of ['nope', '-x', 'main~1', 'main^', 'a:b', 'ma@{in', 'a..b', '', 42]) {
    const out = await run(s, { change: change({ baseRef }), t });
    assert.deepEqual([out.status, out.reason], ['failed', BASE_REF_MISSING(baseRef)], String(baseRef));
  }
  assert.equal(BASE_REF_MISSING('nope'), 'There is no branch called nope in the app, so the change build did not start.');
  for (const runId of ['x', '../x', '20261027-143205-A1B2']) {
    const out = await run(s, { change: change({ runId }), t });
    assert.equal(out.status, 'failed');
    assert.match(out.reason, /run id .* is not one Conductor made, so the change build did not start\./);
  }
  assert.deepEqual(buildsOf(s), builds);
  assert.equal(t.author.calls.length + t.local.calls.length, 0);
  assert.equal((await git(s.appDir, ['branch', '--list', 'build/*'])).stdout.trim().split('\n').length, 1, 'only the first build branch');
});

test('units with unknown acceptance ids, duplicate ids or over-long instructions are refused', async () => {
  const s = await live();
  const builds = buildsOf(s);
  const t = team();
  const cases = [
    [[], /there are no build steps/i],
    ['nope', /there are no build steps/i],
    [[{ ...UNIT_ADDED, acceptance: ['monthly-report#9'] }], /monthly-report#9/],
    [[UNIT_ADDED, { ...UNIT_CHANGED, id: UNIT_ADDED.id }], /report-by-team.*more than once/],
    [[{ ...UNIT_ADDED, instructions: 'x'.repeat(2001) }], /2001 characters/],
    // a fix unit's instructions would be clipped to fit the request: refused, so no retired tag is lost
    [[{ ...UNIT_CHANGED, instructions: 'y'.repeat(2000) }, ...Array.from({ length: 70 }, (_, i) => ({ ...UNIT_CHANGED, id: `c${i}-${'x'.repeat(34)}` }))], /too long/],
    [[{ ...UNIT_ADDED, id: '' }], /has no id/],
    [[{ ...UNIT_ADDED, retire: 'x' }], /retired/],
  ];
  for (const [units, re] of cases) {
    const out = await run(s, { change: change({ units }), t });
    assert.equal(out.status, 'failed');
    assert.match(out.reason, /^The change could not be turned into build steps: .* Nothing was built\.$/s);
    assert.match(out.reason, re);
  }
  assert.deepEqual(buildsOf(s), builds);
  assert.equal(t.author.calls.length + t.local.calls.length, 0);
});

test('latestBuild ignores change builds, so conductor build does not pick one up', async () => {
  const s = await live();
  const out = await run(s);
  assert.equal(out.status, 'approved', out.reason);
  const b = latestBuild(s.projectDir);
  assert.equal(b.runId, s.firstRunId);
  assert.equal(b.kind, 'build');
  assert.equal(newBuild({ runId: 'r', slug: 'a', client: 'A', briefHash: 'h', briefVersion: 1, foundation: null }).kind, 'build');
  assert.equal(newBuild({ runId: 'r', slug: 'a', client: 'A', briefHash: 'h', briefVersion: 1, foundation: null, kind: 'change' }).kind, 'change');
});

test("each feature run is told the unit's retired tags", async () => {
  const s = await live();
  const seen = [];
  const out = await run(s, { change: change({ units: [UNIT_CHANGED, UNIT_ADDED] }), deps: { runTask: (a) => { seen.push(a.options.factoryFeature); return realRunTask(a); } } });
  assert.equal(out.status, 'approved', out.reason);
  assert.deepEqual(seen.map((f) => f.id), ['expenses-change', 'report-by-team']);
  assert.deepEqual(seen[0].retire, UNIT_CHANGED.retire);
  assert.deepEqual(seen[1].retire, []);
  assert.deepEqual(seen[1].tags, ['monthly-report#1']);
});

test('a secret squash in change mode lands on the commit the build branch started from, not on main (Ruling C6)', async () => {
  const s = await live();
  const sideSha = await sideBranch(s.appDir);
  const mainBefore = await rev(s.appDir, 'main');
  const out = await run(s, { change: change({ baseRef: 'side', units: [UNIT_CHANGED, UNIT_ADDED] }), hooks: { council: async () => ({ status: 'approved', text: 'ok', secretSeen: true }) } });
  assert.equal(out.status, 'approved', out.reason);
  assert.equal(await rev(s.appDir, `${out.sha}^`), sideSha);
  assert.equal((await git(s.appDir, ['rev-list', '--count', `${sideSha}..${out.sha}`])).stdout.trim(), '1');
  assert.equal(await rev(s.appDir, 'main'), mainBefore);
  const build = loadBuild(buildDirOf(s.projectDir, RUN_ID));
  assert.deepEqual([build.squashedSha, build.council.sha, build.checks.sha], [out.sha, out.sha, out.sha]);
});

test('in change mode a stop tells the operator to carry on with conductor change --resume', async () => {
  const s = await live();
  const out = await run(s, { hooks: { approveBuild: async () => ({ stop: true }) } });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /run "conductor change acme-ltd --resume" to be asked again\./);
  assert.doesNotMatch(out.reason, /conductor build/);
  const again = await run(s);
  assert.equal(again.status, 'approved', again.reason);
  assert.equal(again.runId, RUN_ID);
});

test('fix round: an approved change build re-called after its base branch is deleted and the brief changed returns the same outcome with zero asks', async () => {
  const s = await live();
  await sideBranch(s.appDir);
  const first = await run(s, { change: change({ baseRef: 'side' }) });
  assert.equal(first.status, 'approved', first.reason);
  assert.ok(first.sha);
  await git(s.appDir, ['branch', '-D', 'side']);
  let asked = 0;
  const again = await run(s, {
    change: change({ baseRef: 'side', units: [] }),
    hooks: { approveBuild: async () => { asked++; return false; }, council: async () => { asked++; return { status: 'blocked', text: 'x' }; } },
    deps: { runAppChecks: async () => { asked++; return green; }, loadBrief: () => ({ ...sampleBrief(), purpose: 'Something else entirely.' }) },
  });
  assert.deepEqual(again, first);
  assert.equal(asked, 0);
});

// A change build stopped at its baseline, then left as a crash between writing app-profile.json and committing it would.
async function crashedBeforeProfileCommit(profile) {
  const s = await live();
  const red = { ...green, verify: { status: 'failed', summary: 'red', output: '' } };
  const stopped = await run(s, { change: change({ profile }), deps: { runAppChecks: async () => red } });
  assert.equal(stopped.status, 'failed');
  await git(s.appDir, ['checkout', '-q', '-b', `build/${RUN_ID}`, 'main']);
  writeFileSync(path.join(s.appDir, 'app-profile.json'), JSON.stringify(profile) + '\n');   // the wanted content, other formatting
  return s;
}

test('fix round: a resume after a crash before the profile commit commits the written profile instead of stopping', async () => {
  const profile = { schema: 1, modules: [], policy: { outbound: ['postmark'], residency: 'uk-eu' } };
  const s = await crashedBeforeProfileCommit(profile);
  const start = await rev(s.appDir, 'main');
  const out = await run(s, { change: change({ profile }) });
  assert.equal(out.status, 'approved', out.reason);
  const commits = (await git(s.appDir, ['rev-list', '--reverse', `${start}..build/${RUN_ID}`])).stdout.trim().split('\n');
  assert.equal((await git(s.appDir, ['log', '-1', '--format=%s', commits[0]])).stdout.trim(), 'Update the app profile from the brief');
  assert.deepEqual((await git(s.appDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', commits[0]])).stdout.trim().split('\n'), ['app-profile.json']);
  assert.equal((await git(s.appDir, ['show', `${commits[0]}:app-profile.json`])).stdout, JSON.stringify(profile, null, 2) + '\n');
});

test('fix round: any other change in the app folder at that point still stops the build', async () => {
  const profile = { schema: 1, modules: [], policy: { outbound: ['postmark'], residency: 'uk-eu' } };
  for (const extra of ['other-file', 'wrong-profile']) {
    const s = await crashedBeforeProfileCommit(profile);
    if (extra === 'other-file') writeFileSync(path.join(s.appDir, 'stray.txt'), 'x\n');
    else writeFileSync(path.join(s.appDir, 'app-profile.json'), JSON.stringify({ ...profile, modules: ['payments'] }) + '\n');
    const out = await run(s, { change: change({ profile }) });
    assert.equal(out.status, 'failed', extra);
    assert.match(out.reason, /^The app folder has changes Conductor did not make, so it stopped\./, extra);
    assert.match(out.reason, /conductor change acme-ltd --resume/);
  }
});

// Final review item 3: a foundation upgrade's council base and gate summary use the foundation it brings in.
test('change.foundation: the council is handed the target foundation and the gate summary names its tag; project.json is not written', async () => {
  const s = await live();
  const projectBefore = readFileSync(s.projectJson, 'utf8');
  const target = { tag: 'v0.1.1', commit: 'a'.repeat(40) };
  let councilArgs;
  let seen;
  const out = await run(s, {
    change: change({ foundation: target }),
    hooks: { council: async (a) => { councilArgs = a; return { status: 'approved', text: 'ok' }; }, approveBuild: async (a) => { seen = a; return true; } },
  });
  assert.equal(out.status, 'approved', out.reason);
  assert.deepEqual(councilArgs.foundation, target);
  assert.match(seen.summary, /on foundation v0\.1\.1$/m);
  assert.equal(readFileSync(s.projectJson, 'utf8'), projectBefore);
  // Without it (a change request, or a normal build) nothing is added to the council's arguments.
  const s2 = await live();
  let plain;
  await run(s2, { hooks: { council: async (a) => { plain = a; return { status: 'approved', text: 'ok' }; }, approveBuild: async () => true } });
  assert.equal('foundation' in plain, false);
});

test('change.foundation must name a release tag and a full commit', async () => {
  const s = await live();
  for (const foundation of [{ tag: 'v0.1.1' }, { tag: '--x', commit: 'a'.repeat(40) }, { tag: 'v0.1.1', commit: 'HEAD' }, 'v0.1.1']) {
    const out = await run(s, { change: change({ foundation }) });
    assert.equal(out.status, 'failed');
    assert.equal(out.reason, 'The foundation release for the change was not passed in a form Conductor can read, so the change build did not start.');
  }
});
