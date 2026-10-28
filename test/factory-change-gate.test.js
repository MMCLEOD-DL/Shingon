// Plan 11 Task 5: the change gate (Plan 8's approveBuild in change mode) and the ship guard.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  councilPassed, readCouncilReport, conflictMarkers, makeChangeGate, shipProblem,
  COUNCIL_MISSING, COUNCIL_NOT_PASSED, COUNCIL_OLDER_COMMIT, MARKERS_LEFT, NOT_APPROVED_COMMIT, NO_APPROVAL, APPROVAL_NOT_SAVED, CHECK_FAILED,
} from '../src/factory/change/gate.js';
import { git } from '../src/workspace.js';
import { makeRepo } from './helpers/gitRepo.js';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const RUN_ID = '20261027-143205-a1b2';
const council = (over = {}) => ({ status: 'approved', text: 'Council report: approved', sha: SHA, ...over });
const report = { sha: SHA, runId: RUN_ID, verdict: 'approved', round: 1 };
const reportFor = (over = {}) => ({ ...report, ...over });
const passed = (c, over = {}) => councilPassed(c, { sha: SHA, runId: RUN_ID, report: reportFor({ verdict: c?.status }), ...over });
const arg = (over = {}) => ({ summary: 'S', sha: SHA, branch: `build/${RUN_ID}`, runId: RUN_ID, council: council(), checks: {}, ...over });

const dirs = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(path.join(tmpdir(), 'change-gate-')); dirs.push(d); return d; };
// A project folder holding builds/<runId>/council-report.json (and build.json when given).
function projectWith({ rep = report, raw = null, build = null, runId = RUN_ID } = {}) {
  const projectDir = tmp();
  const buildDir = path.join(projectDir, 'builds', runId);
  mkdirSync(buildDir, { recursive: true });
  if (raw !== null) writeFileSync(path.join(buildDir, 'council-report.json'), raw);
  else if (rep) writeFileSync(path.join(buildDir, 'council-report.json'), JSON.stringify(rep));
  if (build) writeFileSync(path.join(buildDir, 'build.json'), JSON.stringify({ schema: 1, runId, ...build }));
  return projectDir;
}
const rev = async (dir, ref) => (await git(dir, ['rev-parse', ref])).stdout.trim();
async function commit(dir, files, message) {
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body);
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-q', '-m', message]);
  return rev(dir, 'HEAD');
}

test('councilPassed: approved and approved-with-warnings pass; blocked passes only when overridden; missing or older never pass', () => {
  assert.deepEqual(passed(council()), { ok: true, overridden: false });
  assert.deepEqual(passed(council({ status: 'approved-with-warnings' })), { ok: true, overridden: false });
  assert.deepEqual(passed(council({ status: 'blocked', overridden: true })), { ok: true, overridden: true });
  assert.deepEqual(passed(council({ status: 'blocked' })), { ok: false, reason: COUNCIL_NOT_PASSED });
  assert.deepEqual(councilPassed(null, { sha: SHA, runId: RUN_ID, report }), { ok: false, reason: COUNCIL_MISSING });
  assert.deepEqual(councilPassed(council(), { sha: SHA, runId: RUN_ID, report: null }), { ok: false, reason: COUNCIL_MISSING });
  assert.deepEqual(passed(council({ sha: OTHER })), { ok: false, reason: COUNCIL_OLDER_COMMIT });
  assert.deepEqual(passed(council({ status: 'paused' })), { ok: false, reason: COUNCIL_NOT_PASSED });
  assert.deepEqual(passed(council({ status: 'something-new' })), { ok: false, reason: COUNCIL_NOT_PASSED });
  assert.deepEqual(passed(council({ status: 'blocked', overridden: 'yes' })), { ok: false, reason: COUNCIL_NOT_PASSED });
});

test('councilPassed: the saved report must be this run\'s, finished, for the reviewed commit, and agree with the council (Ruling C3)', () => {
  // another run's report, or a report with no run id
  assert.deepEqual(passed(council(), { report: reportFor({ runId: '20261027-143205-ffff' }) }), { ok: false, reason: COUNCIL_MISSING });
  assert.deepEqual(passed(council(), { runId: undefined }), { ok: false, reason: COUNCIL_MISSING });
  // Plan 9's stale-marked shape
  assert.deepEqual(passed(council(), { report: { sha: SHA, runId: RUN_ID, status: 'paused', reason: 'x' } }), { ok: false, reason: COUNCIL_MISSING });
  // no verdict, or a verdict that is not the council's status
  assert.deepEqual(passed(council(), { report: { sha: SHA, runId: RUN_ID, round: 1 } }), { ok: false, reason: COUNCIL_MISSING });
  assert.deepEqual(passed(council(), { report: reportFor({ verdict: 'blocked' }) }), { ok: false, reason: COUNCIL_MISSING });
  // the report is for another commit, and no secret squash moved the council onto this one
  assert.deepEqual(passed(council(), { report: reportFor({ sha: OTHER }) }), { ok: false, reason: COUNCIL_OLDER_COMMIT });
  // after a secret squash only build.council.sha moves: the report names the pre-squash commit
  assert.deepEqual(passed(council(), { report: reportFor({ sha: OTHER }), squashedSha: SHA }), { ok: true, overridden: false });
  assert.deepEqual(passed(council(), { report: reportFor({ sha: OTHER }), squashedSha: OTHER }), { ok: false, reason: COUNCIL_OLDER_COMMIT });
  // no approved commit to compare with
  assert.deepEqual(passed(council({ sha: undefined }), { sha: undefined }), { ok: false, reason: COUNCIL_OLDER_COMMIT });
});

test('readCouncilReport reads builds/<runId>/council-report.json; missing or damaged gives null', () => {
  assert.deepEqual(readCouncilReport(projectWith(), RUN_ID), report);
  assert.equal(readCouncilReport(projectWith({ rep: null }), RUN_ID), null);
  assert.equal(readCouncilReport(projectWith({ raw: '{ not json' }), RUN_ID), null);
  assert.equal(readCouncilReport(projectWith({ raw: '[1]' }), RUN_ID), null);
  assert.equal(readCouncilReport(projectWith({ raw: 'null' }), RUN_ID), null);
  assert.equal(readCouncilReport(projectWith(), '../x'), null);
  assert.equal(readCouncilReport(projectWith(), undefined), null);
  // Ruling C3: another run's report, a stale-marked report and a report without a verdict give null
  assert.equal(readCouncilReport(projectWith({ rep: reportFor({ runId: '20261027-143205-ffff' }) }), RUN_ID), null);
  assert.equal(readCouncilReport(projectWith({ rep: { sha: SHA, runId: RUN_ID, status: 'paused', reason: 'x' } }), RUN_ID), null);
  assert.equal(readCouncilReport(projectWith({ rep: { sha: SHA, runId: RUN_ID, round: 1 } }), RUN_ID), null);
});

const gateWith = (projectDir, over = {}) => {
  const seen = { asked: [], approved: [], refused: [] };
  const gate = makeChangeGate({
    projectDir, approveBuild: async (a) => { seen.asked.push(a); return true; }, extraText: () => 'X',
    check: async () => null, onApproved: async (r) => { seen.approved.push(r); }, onRefused: (why) => { seen.refused.push(why); }, ...over,
  });
  return { gate, seen };
};

test('the gate refuses without asking when the council is missing, blocked or older, and returns false', async () => {
  for (const [c, verdict, why] of [[null, 'approved', COUNCIL_MISSING], [council({ status: 'blocked' }), 'blocked', COUNCIL_NOT_PASSED],
    [council({ sha: OTHER }), 'approved', COUNCIL_OLDER_COMMIT]]) {
    const { gate, seen } = gateWith(projectWith({ rep: reportFor({ verdict }) }));
    assert.equal(await gate(arg({ council: c })), false);
    assert.equal(seen.asked.length, 0);
    assert.equal(seen.approved.length, 0);
    assert.deepEqual(seen.refused, [why]);
    assert.match(seen.refused[0], /cannot be shipped/);
  }
});

test('the gate refuses without asking when the council report is missing, damaged, stale or another run\'s', async () => {
  for (const projectDir of [projectWith({ rep: null }), projectWith({ raw: 'oops' }),
    projectWith({ rep: { sha: SHA, runId: RUN_ID, status: 'paused', reason: 'x' } }),
    projectWith({ rep: reportFor({ runId: '20261027-143205-ffff' }) })]) {
    const { gate, seen } = gateWith(projectDir);
    assert.equal(await gate(arg()), false);
    assert.equal(seen.asked.length, 0);
    assert.deepEqual(seen.refused, [COUNCIL_MISSING]);
  }
});

test('after a secret squash the gate accepts the pre-squash report through build.json\'s squashedSha', async () => {
  const projectDir = projectWith({ rep: reportFor({ sha: OTHER }), build: { squashedSha: SHA } });
  const { gate, seen } = gateWith(projectDir);
  assert.equal(await gate(arg()), true);
  assert.equal(seen.approved.length, 1);
  // without build.json saying so, a report for another commit is refused
  const { gate: g2, seen: s2 } = gateWith(projectWith({ rep: reportFor({ sha: OTHER }) }));
  assert.equal(await g2(arg()), false);
  assert.deepEqual(s2.refused, [COUNCIL_OLDER_COMMIT]);
});

test('the gate refuses without asking when the pipeline check fails (conflict markers left)', async () => {
  const why = MARKERS_LEFT(['apps/server/src/app.ts']);
  const checked = [];
  const { gate, seen } = gateWith(projectWith(), { check: async (a) => { checked.push(a); return why; } });
  assert.equal(await gate(arg()), false);
  assert.equal(checked[0].sha, SHA);
  assert.equal(seen.asked.length, 0);
  assert.equal(seen.approved.length, 0);
  assert.deepEqual(seen.refused, [why]);
  assert.equal(why, 'The foundation merge is not finished: these files still contain both versions side by side: apps/server/src/app.ts. Nothing was added to the app.');
});

test('a check or the extra text that throws is refused with CHECK_FAILED and never asked', async () => {
  for (const over of [{ check: async () => { throw new Error('git broke'); } }, { extraText: () => { throw new Error('no text'); } },
    { check: async () => { throw new Error('x'); }, onRefused: () => { throw new Error('also broken'); } }]) {
    const { gate, seen } = gateWith(projectWith(), over);
    assert.equal(await gate(arg()), false);
    assert.equal(seen.asked.length, 0);
    assert.equal(seen.approved.length, 0);
    if (!over.onRefused) assert.deepEqual(seen.refused, [CHECK_FAILED]);
  }
  assert.equal(CHECK_FAILED, 'Conductor could not finish checking this change before asking you, so nothing was added to the app. Resume the change to try again.');
});

test('the gate waits for a slow approval save to finish before it returns true', async () => {
  let saved = false;
  const { gate } = gateWith(projectWith(), { onApproved: () => new Promise((resolve) => setTimeout(() => { saved = true; resolve(); }, 30)) });
  const out = await gate(arg());
  assert.equal(saved, true);
  assert.equal(out, true);
});

test('passing checks: the operator sees the summary plus what happens next, and the approval is saved before true is returned', async () => {
  const order = [];
  const { gate } = gateWith(projectWith(), {
    approveBuild: async (a) => { order.push('asked'); assert.equal(a.summary, 'S\n\nIf you approve:\n  X\n  Y'); assert.equal(a.sha, SHA); return true; },
    extraText: () => 'X\nY', now: () => new Date('2026-10-27T14:40:00Z'),
    onApproved: async (r) => {
      order.push('saved');
      assert.deepEqual(r, { sha: SHA, branch: `build/${RUN_ID}`, at: '2026-10-27T14:40:00.000Z', council: { status: 'approved', overridden: false, verdict: 'approved', round: 1 } });
    },
  });
  assert.equal(await gate(arg()), true);
  assert.deepEqual(order, ['asked', 'saved']);
});

test('anything but exactly true from the operator is passed back unchanged and nothing is saved', async () => {
  for (const answer of [{ note: 'bold totals' }, false, 'yes', { stop: true }, null, undefined, 1]) {
    const { gate, seen } = gateWith(projectWith(), { approveBuild: async () => answer });
    assert.equal(await gate(arg()), answer);
    assert.equal(seen.approved.length, 0);
    assert.equal(seen.refused.length, 0);
  }
});

test('an overridden council is approved but the summary says so in plain words', async () => {
  const projectDir = projectWith({ rep: reportFor({ verdict: 'blocked', round: 3 }) });
  const { gate, seen } = gateWith(projectDir);
  assert.equal(await gate(arg({ council: council({ status: 'blocked', overridden: true }) })), true);
  assert.equal(seen.asked[0].summary, 'S\n\nIf you approve:\n  X\nYou chose to ship although the council still found problems.');
  assert.deepEqual(seen.approved[0].council, { status: 'blocked', overridden: true, verdict: 'blocked', round: 3 });
});

test('if saving the approval fails, the gate returns false and records APPROVAL_NOT_SAVED', async () => {
  const { gate, seen } = gateWith(projectWith(), { onApproved: async () => { throw new Error('disk full'); } });
  assert.equal(await gate(arg()), false);
  assert.equal(seen.asked.length, 1);
  assert.deepEqual(seen.refused, [APPROVAL_NOT_SAVED]);
});

test('conflictMarkers finds files that still hold <<<<<<< or >>>>>>> lines at a commit, ignoring ======= alone', async () => {
  const repo = await makeRepo({ 'README.md': 'x\n' });
  dirs.push(repo);
  const sha = await commit(repo, {
    'a.md': 'Title\n=======\nbody\n',
    'b.ts': 'const a = 1;\n<<<<<<< ours\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> theirs\n',
    'c.ts': 'only the end\r\n>>>>>>>\r\n',
    'd.ts': 'not at line start <<<<<<< ours\n<<<<<<<<< nine\n',
  }, 'markers');
  assert.deepEqual(await conflictMarkers(repo, sha, ['a.md', 'b.ts', 'gone.ts', 'c.ts', 'd.ts']), ['b.ts', 'c.ts']);
  assert.deepEqual(await conflictMarkers(repo, sha, []), []);
  // a commit that is not in the repo is never read as "no markers"
  await assert.rejects(conflictMarkers(repo, 'c'.repeat(40), ['b.ts']));
  await assert.rejects(conflictMarkers(repo, '--help', ['b.ts']));
});

test('shipProblem: refuses with no approval, an unapproved council, or a released commit that does not contain the approved one', async () => {
  const appDir = await makeRepo({ 'README.md': 'x\n' });
  dirs.push(appDir);
  const approvedSha = await commit(appDir, { 'f.txt': 'feature\n' }, 'approved work');
  const releaseSha = await commit(appDir, { 'CHANGELOG.md': '# Changelog\n' }, 'release');
  await git(appDir, ['checkout', '-q', '-b', 'other', `${approvedSha}~1`]);
  const strayRelease = await commit(appDir, { 'CHANGELOG.md': '# other\n' }, 'stray');
  const okCouncil = { status: 'approved', overridden: false, verdict: 'approved', round: 1 };
  const run = (over = {}) => ({ approval: { sha: approvedSha, branch: `build/${RUN_ID}`, council: okCouncil }, release: { sha: releaseSha }, ...over });

  assert.equal(await shipProblem({}, { appDir }), NO_APPROVAL);
  assert.equal(await shipProblem(run({ approval: null }), { appDir }), NO_APPROVAL);
  assert.equal(await shipProblem(run({ approval: { sha: '', council: okCouncil } }), { appDir }), NO_APPROVAL);
  for (const c of [{ status: 'blocked', overridden: false }, { status: 'blocked', overridden: 'yes' }, { status: 'paused' }, { status: 'new' }, null, undefined]) {
    assert.equal(await shipProblem(run({ approval: { sha: approvedSha, council: c } }), { appDir }), COUNCIL_NOT_PASSED);
  }
  assert.equal(await shipProblem(run({ release: { sha: strayRelease } }), { appDir }), NOT_APPROVED_COMMIT);
  assert.equal(await shipProblem(run({ release: null }), { appDir }), NOT_APPROVED_COMMIT);
  assert.equal(await shipProblem(run({ release: { sha: 'c'.repeat(40) } }), { appDir }), NOT_APPROVED_COMMIT);
  assert.equal(await shipProblem(run({ release: { sha: '--help' } }), { appDir }), NOT_APPROVED_COMMIT);
  assert.equal(await shipProblem(run({ approval: { sha: '--all', council: okCouncil } }), { appDir }), NOT_APPROVED_COMMIT);

  assert.equal(await shipProblem(run(), { appDir }), null);
  assert.equal(await shipProblem(run({ release: { sha: approvedSha } }), { appDir }), null);
  assert.equal(await shipProblem(run({ approval: { sha: approvedSha, council: { status: 'blocked', overridden: true } } }), { appDir }), null);
  assert.equal(await shipProblem(run({ approval: { sha: approvedSha, council: { status: 'approved-with-warnings', overridden: false } } }), { appDir }), null);
});

test('the texts are the plan\'s, word for word', () => {
  assert.equal(COUNCIL_MISSING, 'The full council did not review this change, so it cannot be shipped. Nothing was added to the app. Check that the council is set up (conductor doctor) and run the change again.');
  assert.equal(COUNCIL_NOT_PASSED, 'The council still found problems that must be fixed, and you did not choose to ship anyway, so this change cannot be shipped. Nothing was added to the app.');
  assert.equal(COUNCIL_OLDER_COMMIT, 'The council reviewed an earlier version of this change, not the one waiting for approval, so it cannot be shipped. Nothing was added to the app. Resume the change so the council reviews the final version.');
  assert.equal(MARKERS_LEFT(['a', 'b']), 'The foundation merge is not finished: these files still contain both versions side by side: a, b. Nothing was added to the app.');
  assert.equal(NOT_APPROVED_COMMIT, 'What reached the app is not exactly what you approved, so nothing was shipped. The approved work is still on its own branch in the app.');
  assert.equal(NO_APPROVAL, 'There is no record that you approved this change, so nothing was shipped.');
  assert.equal(APPROVAL_NOT_SAVED, 'Conductor could not record your approval, so the change was not added to the app. Resume the change to try again.');
});
