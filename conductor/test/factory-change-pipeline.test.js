// Plan 11, Task 9: the change and foundation-upgrade pipelines, resumable at every stage.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeRepo } from './helpers/gitRepo.js';
import { makeProject, stubDeps, writeBriefVersion } from './helpers/changeFixtures.js';
import { lockProject } from '../src/factory/projectLock.js';
import { RUN_ID_RE } from '../src/factory/ids.js';
import { appProfileOf } from '../src/factory/app.js';
import { loadChangeRun, saveChangeRun } from '../src/factory/change/run.js';
import { HOSTING_CHANGED } from '../src/factory/change/delta.js';
import { COUNCIL_NOT_PASSED, COUNCIL_MISSING, MARKERS_LEFT, CHECK_FAILED } from '../src/factory/change/gate.js';
import { MAIN_MOVED } from '../src/factory/change/mainline.js';
import {
  runChange, runFoundationUpgrade, resumeChange, abandonChange, askOperator, RELEASE_STILL_TO_MAKE, BRIEF_CHANGED_WHILE_PAUSED,
  NOT_BUILT_YET, NO_BUILT_FROM, UNFINISHED, NOTHING_TO_RESUME, MISSING_SEAMS, TOO_MANY_CONFLICTS,
} from '../src/factory/change/pipeline.js';

const cleanup = [];
after(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];
const g = (dir, args) => execFileSync('git', ['-C', dir, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const appMain = (appDir) => g(appDir, ['rev-parse', 'refs/heads/main']);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// ---- fixtures ----------------------------------------------------------------------------------------------

// package.json and package-lock.json keep the name and version lines apart, so the app's own name and the
// foundation's version bump never land in the same conflict hunk (the version-only rule then settles them).
const pkg = (name, v) => `${JSON.stringify({ name, description: 'The Highland foundation.', private: true, version: v }, null, 2)}\n`;
const lock = (name, v) => `${JSON.stringify({ name, lockfileVersion: 3, requires: true, version: v, packages: { '': { name, license: 'UNLICENSED', version: v } } }, null, 2)}\n`;
const fjson = (v) => `${JSON.stringify({ name: 'highland-foundation', version: v, commit: `v${v}` }, null, 2)}\n`;
const FOUNDATION_LOG = {
  '0.1.0': '## [0.1.0] - 2026-10-10\n- Release 0.1.0.\n',
  '0.1.1': '## [0.1.1] - 2026-10-11\n- **[security]** Sessions now expire after 12 hours.\n- Tidier audit page.\n',
};
const changelogOf = (versions) => `# Changelog\n\n## [Unreleased]\n\n${versions.slice().reverse().map((v) => FOUNDATION_LOG[v]).join('\n')}`;

function writeFiles(dir, files) {
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), body);
  }
}

// A foundation with v0.1.0 and v0.1.1; `extra110` / `extra111` add files to each release.
async function makeFoundationRepo({ extra110 = {}, extra111 = {} } = {}) {
  const dir = await makeRepo({ 'README.md': 'foundation\n' });
  cleanup.push(dir);
  const done = [];
  for (const [v, extra] of [['0.1.0', extra110], ['0.1.1', extra111]]) {
    done.push(v);
    writeFiles(dir, { 'foundation.json': fjson(v), 'package.json': pkg('highland-foundation', v), 'package-lock.json': lock('highland-foundation', v), 'CHANGELOG.md': changelogOf(done), ...extra });
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', `release: v${v}`]);
    g(dir, ['tag', '-a', `v${v}`, '-m', `v${v}`]);
  }
  return { dir, tagSha: (tag) => g(dir, ['rev-parse', `${tag}^{commit}`]) };
}

const ex = (id, then = 'her claims list shows Travel £12.40 dated 3 March 2026') => ({ id, given: 'Alice is signed in as Staff', when: 'she does the thing', then });
const feat = (id, title, acceptance) => ({ id, title, story: `${title}: what staff do with it.`, roles: ['Staff'], data: ['Claim'], acceptance });
const V1_FEATURES = [
  feat('submit-receipt', 'Submit receipt', [ex('submit-receipt#1'), ex('submit-receipt#2')]),
  feat('monthly-report', 'Monthly report', [ex('monthly-report#1'), ex('monthly-report#2')]),
  feat('paper-upload', 'Paper upload', [ex('paper-upload#1')]),
];
const V2_FEATURES = [
  feat('monthly-report', 'Monthly report', [ex('monthly-report#1'), ex('monthly-report#3', 'the March 2026 report shows Travel £10.33')]),
  feat('submit-receipt', 'Submit receipt', [ex('submit-receipt#1'), ex('submit-receipt#2')]),
  feat('mileage-claims', 'Mileage claims', [ex('mileage-claims#1')]),
];
const V1_SEQ = { 'submit-receipt': 2, 'monthly-report': 2, 'paper-upload': 1 };
const V2_SEQ = { 'submit-receipt': 2, 'monthly-report': 3, 'paper-upload': 1, 'mileage-claims': 1 };

// The project: shipped on foundation v0.1.0, built from brief v1, its own 0.2.0 release, two deployments on 0.2.0.
async function setup({ deployments = ['acme-cloud', 'acme-office'], released = true, status = 'shipped', foundation } = {}) {
  const f = foundation ?? await makeFoundationRepo();
  const p = await makeProject({
    foundation: f, tag: 'v0.1.0', status,
    deployments: deployments.map((name) => ({ name, host: `${name}-box`, currentVersion: '0.2.0', foundation: 'v0.1.0' })),
  });
  cleanup.push(p.projectsRoot);
  writeBriefVersion(p.projectDir, 1, { features: V1_FEATURES, exampleSeq: V1_SEQ });
  writeFiles(p.appDir, { 'apps/server/src/feature.ts': 'export const feature = 1;\n' });
  g(p.appDir, ['add', '-A']);
  g(p.appDir, ['commit', '-q', '-m', 'feat: the app feature']);
  if (released) {
    writeFiles(p.appDir, {
      'foundation.json': fjson('0.2.0'), 'package.json': pkg('acme-app', '0.2.0'), 'package-lock.json': lock('acme-app', '0.2.0'),
      'CHANGELOG.md': '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-20\n- The app feature.\n\n## [0.1.0] - 2026-10-10\n- Release 0.1.0.\n',
    });
    g(p.appDir, ['add', '-A']);
    g(p.appDir, ['commit', '-q', '-m', 'release: v0.2.0']);
    g(p.appDir, ['tag', '-a', 'v0.2.0', '-m', 'v0.2.0']);
  }
  const project = readJson(path.join(p.projectDir, 'project.json'));
  project.approved.sha = appMain(p.appDir);
  writeFileSync(path.join(p.projectDir, 'project.json'), `${JSON.stringify(project, null, 2)}\n`);
  const notesDir = mkdtempSync(path.join(tmpdir(), 'notes-'));
  cleanup.push(notesDir);
  const notesFile = path.join(notesDir, 'change-notes.md');
  writeFileSync(notesFile, 'Acme want mileage claims, a different monthly report, and no paper upload.\n');
  return { ...p, f, notesFile, cwd: notesDir, slug: 'acme' };
}

// What the stubs do, adjustable per test.
function control(over = {}) {
  return {
    v2: { features: V2_FEATURES, exampleSeq: V2_SEQ },
    council: { status: 'approved', text: 'All good.' },
    report: true, buildResults: [], commit: true, moveMain: false, leaveOnBranch: false, afterGate: null,
    gateAnswer: true, escalate: 'reject', outcomes: {}, release: null,
    ...over,
  };
}

function makeTerm(ctl) {
  const calls = [];
  const term = {
    calls, lines: [],
    say: (l) => { term.lines.push(l); },
    onEvent: () => {},
    briefIo: { say: () => {} },
    approveBuild: async (arg) => { calls.push({ name: 'approveBuild', arg }); return typeof ctl.gateAnswer === 'function' ? ctl.gateAnswer(arg) : ctl.gateAnswer; },
    escalate: async (arg) => { calls.push({ name: 'escalate', arg }); return typeof ctl.escalate === 'function' ? ctl.escalate(arg) : ctl.escalate; },
  };
  return term;
}

let counter = 0;
function makeDeps(p, ctl, over = {}) {
  const deps = stubDeps({
    reviseBrief: async ({ projectDir }) => {
      writeBriefVersion(projectDir, 2, { revisedFrom: 1, ...ctl.v2 });
      return { status: 'approved', version: 2 };
    },
    runBuild: async ({ hooks, options }) => {
      const pending = ctl.buildResults.shift();
      if (pending) return pending;
      const { runId, baseRef } = options.change;
      const branch = `build/${runId}`;
      const exists = execFileSync('git', ['-C', p.appDir, 'branch', '--list', branch], { encoding: 'utf8' }).trim() !== '';
      g(p.appDir, exists ? ['checkout', '-q', branch] : ['checkout', '-q', '-b', branch, `refs/heads/${baseRef}`]);
      if (ctl.commit) {
        writeFiles(p.appDir, { [`apps/server/src/change-${++counter}.ts`]: `export const change = ${counter};\n` });
        g(p.appDir, ['add', '-A']);
        g(p.appDir, ['commit', '-q', '-m', 'the change']);
      }
      const sha = g(p.appDir, ['rev-parse', 'HEAD']);
      if (ctl.report) {
        writeFileSync(path.join(p.projectDir, 'builds', runId, 'council-report.json'),
          JSON.stringify({ runId, sha, verdict: ctl.council.status, round: 1 }));
      }
      g(p.appDir, ['checkout', '-q', 'main']);
      if (ctl.moveMain) {
        writeFiles(p.appDir, { 'apps/server/src/hotfix.ts': 'export const hotfix = 1;\n' });
        g(p.appDir, ['add', '-A']);
        g(p.appDir, ['commit', '-q', '-m', 'someone else fixed something']);
      }
      if (ctl.leaveOnBranch) g(p.appDir, ['checkout', '-q', branch]);
      const answer = await hooks.approveBuild({
        summary: 'S', sha, branch, runId, council: { ...ctl.council, sha }, checks: { sha },
      });
      if (ctl.afterGate) return ctl.afterGate(answer);
      if (answer === true) return { status: 'approved', runId, buildDir: path.join(p.projectDir, 'builds', runId), sha, branch };
      if (answer && answer.stop) return { status: 'stopped', runId, reason: 'You stopped at the build\'s approval without deciding.' };
      return { status: 'rejected', runId, reason: 'You did not approve the build.' };
    },
    releaseApp: async ({ projectDir, bump, expectedMain }) => {
      if (ctl.release) return ctl.release({ projectDir, bump, expectedMain });
      return simulateRelease(p.appDir, bump, expectedMain);
    },
    updateDeployment: async ({ name }) => {
      const q = ctl.outcomes[name];
      const outcome = Array.isArray(q) && q.length ? q.shift() : 'updated';
      return { outcome, message: outcome === 'updated' ? 'Updated.' : 'It went wrong.' };
    },
    runProjectCouncil: async () => ({ status: 'approved', text: 'ok' }),
    ...over,
  });
  return deps;
}

// The app's release script as Plan 10 runs it: versions raised, Unreleased moved under the version, one commit, a tag.
function simulateRelease(appDir, bump, expectedMain, { reportFailure = false } = {}) {
  const main = appMain(appDir);
  if (expectedMain && main !== expectedMain) return { ok: false, reason: 'main moved' };
  const current = readJson(path.join(appDir, 'package.json')).version.split('.').map(Number);
  const version = bump === 'minor' ? `${current[0]}.${current[1] + 1}.0` : `${current[0]}.${current[1]}.${current[2] + 1}`;
  for (const file of ['package.json', 'package-lock.json', 'foundation.json']) {
    const j = readJson(path.join(appDir, file));
    j.version = version;
    if (j.packages?.['']) j.packages[''].version = version;
    writeFileSync(path.join(appDir, file), `${JSON.stringify(j, null, 2)}\n`);
  }
  const log = readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8').replace('## [Unreleased]\n', `## [Unreleased]\n\n## [${version}] - 2026-10-28\n`);
  writeFileSync(path.join(appDir, 'CHANGELOG.md'), log);
  g(appDir, ['add', '-A']);
  g(appDir, ['commit', '-q', '-m', `release: v${version}`]);
  g(appDir, ['tag', '-a', `v${version}`, '-m', `v${version}`]);
  const sha = appMain(appDir);
  if (reportFailure) return { ok: false, reason: 'Conductor stopped before it could say.' };
  return { ok: true, version, sha, tag: `v${version}` };
}

async function harness(opts = {}) {
  const p = await setup(opts.setup ?? {});
  const ctl = control(opts.ctl ?? {});
  const term = makeTerm(ctl);
  const deps = makeDeps(p, ctl, opts.deps ?? {});
  const baseDir = mkdtempSync(path.join(tmpdir(), 'base-'));
  cleanup.push(baseDir);
  const common = { factory: p.factory, slug: 'acme', team: { members: [] }, author: { name: 'author' }, term, options: { maxRounds: 2 }, baseDir, deps, cwd: p.cwd, env: {} };
  return {
    ...p, ctl, term, deps, baseDir, common,
    change: (over = {}) => runChange({ ...common, notesFile: p.notesFile, ...over }),
    upgrade: (over = {}) => runFoundationUpgrade({ ...common, toTag: 'v0.1.1', ...over }),
    resume: (over = {}) => resumeChange({ ...common, ...over }),
    callsOf: (name) => deps.calls.filter((c) => c.name === name),
    project: () => readJson(path.join(p.projectDir, 'project.json')),
  };
}

// ---- the change pipeline -----------------------------------------------------------------------------------

test('change: brief → build → council passed → gate → main → release → both deployments updated', async () => {
  const h = await harness();
  const out = await h.change();
  assert.equal(out.status, 'done', out.reason);
  const run = loadChangeRun(h.projectDir, out.runId);
  assert.match(out.runId, RUN_ID_RE);
  assert.equal(run.kind, 'change');
  assert.equal(run.stage, 'done');
  assert.equal(run.status, 'done');
  assert.deepEqual(run.brief, { from: 1, to: 2 });
  const build = h.callsOf('runBuild')[0].args[0];
  assert.deepEqual(build.options.change.units.map((u) => u.id), ['change-monthly-report', 'mileage-claims', 'remove-paper-upload']);
  assert.equal(build.options.change.baseRef, 'main');
  assert.equal(build.options.change.runId, out.runId);
  assert.equal(build.options.change.profile, null, 'a features-only change passes no profile');
  assert.equal(build.options.maxRounds, 2);
  assert.equal(h.callsOf('releaseApp')[0].args[0].bump, 'minor');
  assert.equal(h.callsOf('releaseApp')[0].args[0].expectedMain, run.changelogSha);
  assert.equal(appMain(h.appDir), run.release.sha);
  assert.match(readFileSync(path.join(h.appDir, 'CHANGELOG.md'), 'utf8'), /- Change \(brief v2\): added Mileage claims/);
  const project = h.project();
  assert.equal(project.builtFromBrief, 2);
  assert.deepEqual(project.approved, { sha: run.changelogSha, at: run.approval.at, runId: out.runId, briefVersion: 2 });
  assert.deepEqual(h.callsOf('updateDeployment').map((c) => [c.args[0].name, c.args[0].version, c.args[0].foundation]),
    [['acme-cloud', '0.3.0', 'v0.1.0'], ['acme-office', '0.3.0', 'v0.1.0']]);
  const gate = h.term.calls.find((c) => c.name === 'approveBuild').arg;
  assert.match(gate.summary, /If you approve:\n {2}Added: Mileage claims\./);
  assert.match(gate.summary, /The app becomes version 0\.3\.0\./);
  assert.match(gate.summary, /These lines are added to its changelog:\n {4}- Change \(brief v2\): added Mileage claims/);
  assert.match(gate.summary, /These deployments are then updated one at a time, each with a backup first and an automatic undo if it fails: acme-cloud \(0\.2\.0\), acme-office \(0\.2\.0\)\./);
  assert.equal(gate.approveLabel, 'approve → add to the app and update 2 deployments');
  assert.match(out.report, /Added: Mileage claims\./);
  assert.match(out.report, /The council approved it\./);
  assert.match(out.report, /The app is now version 0\.3\.0\./);
  assert.match(out.report, /acme-office: updated to 0\.3\.0/);
  // The brief step got what Plan 7's handler passes: an absolute notes file, a log and a scratch cwd.
  const revise = h.callsOf('reviseBrief')[0].args[0];
  assert.equal(revise.notesFile, h.notesFile);
  assert.ok(revise.log && revise.cwd && revise.cwd !== h.cwd);
  assert.equal(existsSync(revise.cwd), false, 'the scratch cwd is removed afterwards');
  assert.equal(revise.io, h.term.briefIo);
});

test('a relative notes file is resolved against the caller\'s folder', async () => {
  const h = await harness();
  const out = await h.change({ notesFile: 'change-notes.md' });
  assert.equal(out.status, 'done', out.reason);
  assert.equal(h.callsOf('reviseBrief')[0].args[0].notesFile, h.notesFile);
});

test('an unreadable notes file is refused before anything starts', async () => {
  const h = await harness();
  const out = await h.change({ notesFile: path.join(h.cwd, 'missing.md') });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /There is no notes file/);
  assert.equal(h.callsOf('reviseBrief').length, 0);
  assert.deepEqual(readdirSync(path.join(h.projectDir, 'builds')), []);
});

test('the council hook calls Plan 9\'s runProjectCouncil with the options and the base folder, as conductor build does (Ruling C2)', async () => {
  const h = await harness();
  await h.change();
  const hooks = h.callsOf('runBuild')[0].args[0].hooks;
  const a = { projectDir: h.projectDir, sha: 'x' };
  const r = await hooks.council(a);
  const call = h.callsOf('runProjectCouncil').at(-1);
  assert.equal(call.args[0], a);
  assert.deepEqual(call.args[1], { options: h.common.options, deps: { baseDir: h.baseDir } });
  assert.deepEqual(r, { status: 'approved', text: 'ok' }, 'the result is passed back as it is (no overridden added)');
});

test('a policy or modules change passes the new app profile to the build; a features-only change passes null', async () => {
  const policy = { hosting: 'client-box', outbound: ['azure-document-intelligence'], residency: 'uk', retention: { text: 'Claims and receipts are kept for 6 years, then deleted', days: 2190 }, backupDestination: { kind: 'client-owned', detail: "A USB disk kept in the client's office safe" }, operatorAccess: true };
  const h = await harness({ ctl: { v2: { features: V2_FEATURES, exampleSeq: V2_SEQ, policy } } });
  const out = await h.change();
  assert.equal(out.status, 'done', out.reason);
  const next = JSON.parse(readFileSync(path.join(h.projectDir, 'brief', 'brief-v2.json'), 'utf8'));
  assert.deepEqual(h.callsOf('runBuild')[0].args[0].options.change.profile, appProfileOf(next));
});

test('a blocked council that the operator did not override never reaches the operator or the app', async () => {
  const h = await harness({ ctl: { council: { status: 'blocked', text: 'A hole.' } } });
  const mainBefore = appMain(h.appDir);
  const projectBefore = h.project();
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, COUNCIL_NOT_PASSED);
  assert.equal(h.term.calls.filter((c) => c.name === 'approveBuild').length, 0);
  assert.equal(appMain(h.appDir), mainBefore);
  assert.equal(h.callsOf('releaseApp').length, 0);
  assert.equal(h.callsOf('updateDeployment').length, 0);
  assert.deepEqual(h.project(), projectBefore);
  const run = loadChangeRun(h.projectDir, out.runId);
  assert.equal(run.status, 'paused', 'a gate refusal leaves the run resumable');
  assert.equal(run.refusal, COUNCIL_NOT_PASSED);
  assert.equal(run.stage, 'build');
});

test('no council report on disk: refused at the gate as COUNCIL_MISSING', async () => {
  const h = await harness({ ctl: { report: false } });
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, COUNCIL_MISSING);
  assert.equal(h.term.calls.filter((c) => c.name === 'approveBuild').length, 0);
  assert.equal(h.callsOf('releaseApp').length, 0);
});

test('a gate refusal is resumable: resume builds again with the same run id and carries on once the council report is there', async () => {
  const h = await harness({ ctl: { report: false } });
  const out = await h.change();
  assert.equal(out.reason, COUNCIL_MISSING);
  h.ctl.report = true;
  const again = await h.resume();
  assert.equal(again.status, 'done', again.reason);
  assert.equal(again.runId, out.runId);
  const runs = h.callsOf('runBuild').map((c) => c.args[0].options.change.runId);
  assert.deepEqual(runs, [out.runId, out.runId]);
  const run = loadChangeRun(h.projectDir, out.runId);
  assert.equal(run.refusal, undefined, 'the old refusal is cleared');
});

test('a gate prompt that throws is refused with a plain reason, not taken for a rejection', async () => {
  const h = await harness({ ctl: { gateAnswer: () => { throw new Error('the terminal went away'); } } });
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /could not ask you/);
  assert.equal(loadChangeRun(h.projectDir, out.runId).status, 'paused');
});

test('an overridden council ships, and the report says the operator chose to', async () => {
  const h = await harness({ ctl: { council: { status: 'blocked', text: 'A hole.', overridden: true } } });
  const out = await h.change();
  assert.equal(out.status, 'done', out.reason);
  assert.match(out.report, /You chose to ship although the council still found problems\./);
  const gate = h.term.calls.find((c) => c.name === 'approveBuild').arg;
  assert.match(gate.summary, /You chose to ship although the council still found problems\./);
});

test('approved with warnings: the report says so', async () => {
  const h = await harness({ ctl: { council: { status: 'approved-with-warnings', text: 'Minor.' } } });
  const out = await h.change();
  assert.equal(out.status, 'done', out.reason);
  assert.match(out.report, /The council approved it with warnings\./);
});

test('the operator rejects at the gate: nothing reaches main, the new brief version is kept, builtFromBrief stays', async () => {
  const h = await harness({ ctl: { gateAnswer: false } });
  const mainBefore = appMain(h.appDir);
  const out = await h.change();
  assert.equal(out.status, 'rejected');
  assert.match(out.reason, /You did not approve the change\. The new brief \(v2\) is kept; the app is still built from brief v1\./);
  assert.equal(appMain(h.appDir), mainBefore);
  assert.equal(h.project().builtFromBrief, 1);
  assert.ok(existsSync(path.join(h.projectDir, 'brief', 'brief-v2.json')));
  assert.equal(h.callsOf('releaseApp').length, 0);
  assert.equal(loadChangeRun(h.projectDir, out.runId).status, 'stopped');
});

test('the operator stops at the gate without deciding: the run is paused, never stopped (Ruling C5)', async () => {
  const h = await harness({ ctl: { gateAnswer: { stop: true } } });
  const out = await h.change();
  assert.equal(out.status, 'paused');
  assert.equal(loadChangeRun(h.projectDir, out.runId).status, 'paused');
});

test('the operator does not approve the revised brief: stopped before any build', async () => {
  const h = await harness({ deps: { reviseBrief: async () => ({ status: 'stopped', reason: 'Stopped. Your answers so far are saved.' }) } });
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /Your answers so far are saved/);
  assert.equal(h.callsOf('runBuild').length, 0);
});

test('a brief step that throws becomes a failed, resumable run with a plain reason', async () => {
  const h = await harness({ deps: { reviseBrief: async () => { throw new Error('the model fell over.'); } } });
  const out = await h.change();
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /the model fell over\. You can resume\./);
  assert.doesNotMatch(out.reason, /over\.\./);
  assert.equal(loadChangeRun(h.projectDir, out.runId).status, 'failed');
});

test('a delta that is not a change (hosting moved) is refused before the build', async () => {
  const policy = { hosting: 'operator-server', outbound: [], residency: 'uk', retention: { text: 'Claims and receipts are kept for 6 years, then deleted', days: 2190 }, backupDestination: { kind: 'client-owned', detail: "A USB disk kept in the client's office safe" }, operatorAccess: true };
  const h = await harness({ ctl: { v2: { features: V2_FEATURES, exampleSeq: V2_SEQ, policy } } });
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, HOSTING_CHANGED);
  assert.equal(h.callsOf('runBuild').length, 0);
});

test('a project that has not been built yet, or has no builtFromBrief, is refused', async () => {
  const h = await harness({ setup: { status: 'building' } });
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, NOT_BUILT_YET);

  const h2 = await harness();
  const project = h2.project();
  project.builtFromBrief = null;
  writeFileSync(path.join(h2.projectDir, 'project.json'), JSON.stringify(project));
  const out2 = await h2.change();
  assert.equal(out2.status, 'stopped');
  assert.equal(out2.reason, NO_BUILT_FROM);
  assert.equal(h2.callsOf('reviseBrief').length, 0);
});

test('main moved while the change was being built: nothing is released or shipped, and the report says where the work is', async () => {
  const h = await harness({ ctl: { moveMain: true } });
  const projectBefore = h.project();
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.ok(out.reason.startsWith(MAIN_MOVED));
  assert.match(out.reason, new RegExp(`build/${out.runId}`));
  assert.equal(h.callsOf('releaseApp').length, 0);
  assert.equal(h.callsOf('updateDeployment').length, 0);
  assert.deepEqual(h.project(), projectBefore);
});

test('crash after the gate approved but before main moved: resume finishes without asking again or building again', async () => {
  const h = await harness({ ctl: { afterGate: () => { throw new Error('killed'); } } });
  const first = await h.change();
  assert.equal(first.status, 'failed');
  const saved = loadChangeRun(h.projectDir, first.runId);
  assert.equal(saved.stage, 'approved');
  assert.ok(saved.approval && saved.build.branch);
  const gates = h.term.calls.length;
  const builds = h.callsOf('runBuild').length;
  const out = await h.resume();
  assert.equal(out.status, 'done', out.reason);
  assert.equal(h.term.calls.filter((c) => c.name === 'approveBuild').length, 1);
  assert.equal(h.term.calls.length, gates);
  assert.equal(h.callsOf('runBuild').length, builds);
  assert.equal(h.callsOf('releaseApp').length, 1);
  assert.equal(appMain(h.appDir), loadChangeRun(h.projectDir, out.runId).release.sha);
});

test('crash after main moved but before project.json was written: resume writes it and carries on', async () => {
  const h = await harness({ ctl: { release: async () => ({ ok: false, reason: 'npm went away' }) } });
  const projectBefore = h.project();
  const first = await h.change();
  assert.equal(first.status, 'failed');
  assert.match(first.reason, /npm went away/);
  const run = loadChangeRun(h.projectDir, first.runId);
  assert.equal(run.stage, 'merged');
  assert.equal(appMain(h.appDir), run.changelogSha);
  // Put the record back to just after main moved.
  run.stage = 'approved';
  saveChangeRun(h.projectDir, run);
  writeFileSync(path.join(h.projectDir, 'project.json'), JSON.stringify(projectBefore));
  h.ctl.release = null;
  const out = await h.resume();
  assert.equal(out.status, 'done', out.reason);
  const project = h.project();
  assert.equal(project.builtFromBrief, 2);
  assert.equal(project.approved.sha, run.changelogSha);
});

test('crash after the release: resume does not release again', async () => {
  const h = await harness({ ctl: { outcomes: { 'acme-cloud': ['lost-contact'] } } });
  const first = await h.change();
  assert.equal(first.status, 'stopped');
  const run = loadChangeRun(h.projectDir, first.runId);
  assert.ok(run.release);
  run.stage = 'merged';
  delete run.deployments;
  saveChangeRun(h.projectDir, run);
  const out = await h.resume();
  assert.equal(out.status, 'done', out.reason);
  assert.equal(h.callsOf('releaseApp').length, 1);
});

test('a release that already happened but was not saved is adopted, not repeated', async () => {
  let h;
  h = await harness({ ctl: { release: () => simulateRelease(h.appDir, 'minor', null, { reportFailure: true }) } });
  const first = await h.change();
  assert.equal(first.status, 'failed');
  const run = loadChangeRun(h.projectDir, first.runId);
  assert.equal(run.stage, 'merged');
  assert.equal(run.release, undefined);
  const out = await h.resume();
  assert.equal(out.status, 'done', out.reason);
  assert.equal(h.callsOf('releaseApp').length, 1);
  const after = loadChangeRun(h.projectDir, first.runId);
  assert.deepEqual(after.release, { version: '0.3.0', sha: appMain(h.appDir), tag: 'v0.3.0' });
});

test('a release commit left untagged on top of the changelog commit is handed to releaseApp as the expected main (Ruling C4)', async () => {
  let h;
  h = await harness({
    ctl: {
      release: ({ expectedMain }) => {
        const r = simulateRelease(h.appDir, 'minor', expectedMain);
        g(h.appDir, ['tag', '-d', r.tag]);
        h.ctl.release = ({ expectedMain: em }) => {
          g(h.appDir, ['tag', '-a', r.tag, '-m', r.tag, em]);
          return { ok: true, version: r.version, sha: em, tag: r.tag };
        };
        return { ok: false, reason: 'crashed before tagging' };
      },
    },
  });
  const first = await h.change();
  assert.equal(first.status, 'failed');
  const run = loadChangeRun(h.projectDir, first.runId);
  const out = await h.resume();
  assert.equal(out.status, 'done', out.reason);
  const second = h.callsOf('releaseApp')[1].args[0];
  assert.equal(second.expectedMain, appMain(h.appDir));
  assert.notEqual(second.expectedMain, run.changelogSha);
});

test('a release that is not exactly on the changelog commit is refused: releaseProblem always checks from the changelog commit', async () => {
  let h;
  h = await harness({
    ctl: {
      release: ({ expectedMain }) => {
        // A stray commit between the changelog commit and the release.
        writeFiles(h.appDir, { 'stray.txt': 'x\n' });
        g(h.appDir, ['add', '-A']);
        g(h.appDir, ['commit', '-q', '-m', 'stray']);
        return simulateRelease(h.appDir, 'minor', null);
      },
    },
  });
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /not on the app's main line/);
  assert.equal(h.callsOf('updateDeployment').length, 0);
});

// Gets a change to stage 'merged' with main on the changelog commit and no release made (releaseApp said no once).
async function mergedWithoutRelease() {
  const h = await harness({ ctl: { release: async () => ({ ok: false, reason: 'npm went away' }) } });
  const first = await h.change();
  assert.equal(first.status, 'failed');
  h.ctl.release = null;
  return { h, runId: first.runId };
}
const tagsOf = (appDir) => g(appDir, ['tag', '--list']);

test('a stray commit on main before the release step is never released: stopped, releaseApp not called, no tag added (Ruling amending C4)', async () => {
  const { h } = await mergedWithoutRelease();
  writeFiles(h.appDir, { 'apps/server/src/stray.ts': 'export const stray = 1;\n' });
  g(h.appDir, ['add', '-A']);
  g(h.appDir, ['commit', '-q', '-m', 'unreviewed work']);
  const tags = tagsOf(h.appDir);
  const out = await h.resume();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /main line moved after the change was added/);
  assert.equal(h.callsOf('releaseApp').length, 1);
  assert.equal(tagsOf(h.appDir), tags);
  assert.equal(h.callsOf('updateDeployment').length, 0);
});

test('a fake release commit that also touches code is never released (Ruling amending C4)', async () => {
  const { h } = await mergedWithoutRelease();
  for (const file of ['package.json', 'package-lock.json']) {
    const j = readJson(path.join(h.appDir, file));
    j.version = '0.3.0';
    writeFileSync(path.join(h.appDir, file), `${JSON.stringify(j, null, 2)}\n`);
  }
  writeFiles(h.appDir, { 'apps/server/src/sneaky.ts': 'export const sneaky = 1;\n' });
  g(h.appDir, ['add', '-A']);
  g(h.appDir, ['commit', '-q', '-m', 'release: v0.3.0']);
  const tags = tagsOf(h.appDir);
  const out = await h.resume();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /main line moved after the change was added/);
  assert.equal(h.callsOf('releaseApp').length, 1);
  assert.equal(tagsOf(h.appDir), tags);
});

test('an untagged "release" commit that also changes package.json scripts is never released (Ruling (Tasks 7, 9))', async () => {
  const { h } = await mergedWithoutRelease();
  const r = simulateRelease(h.appDir, 'minor', null);
  g(h.appDir, ['tag', '-d', r.tag]);
  g(h.appDir, ['reset', '-q', '--soft', 'HEAD~1']);
  const j = readJson(path.join(h.appDir, 'package.json'));
  j.scripts = { postinstall: 'node steal.js' };
  writeFileSync(path.join(h.appDir, 'package.json'), `${JSON.stringify(j, null, 2)}\n`);
  g(h.appDir, ['add', '-A']);
  g(h.appDir, ['commit', '-q', '-m', 'release: v0.3.0']);
  const tags = tagsOf(h.appDir);
  const out = await h.resume();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /main line moved after the change was added/);
  assert.equal(h.callsOf('releaseApp').length, 1);
  assert.equal(tagsOf(h.appDir), tags);
});

test('a release that changes dependencies is refused by the release check and nothing is shipped', async () => {
  let h;
  h = await harness({
    ctl: {
      release: ({ bump, expectedMain }) => {
        const j = readJson(path.join(h.appDir, 'package.json'));
        j.dependencies = { 'left-pad': '1.0.0' };
        writeFileSync(path.join(h.appDir, 'package.json'), `${JSON.stringify(j, null, 2)}\n`);
        return simulateRelease(h.appDir, bump, expectedMain);
      },
    },
  });
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /changed more than the version numbers in package\.json/);
  assert.equal(h.callsOf('updateDeployment').length, 0);
});

test('a genuine release commit left untagged by a crash is adopted through releaseApp', async () => {
  const { h } = await mergedWithoutRelease();
  const r = simulateRelease(h.appDir, 'minor', null);
  g(h.appDir, ['tag', '-d', r.tag]);
  h.ctl.release = ({ expectedMain }) => {
    g(h.appDir, ['tag', '-a', r.tag, '-m', r.tag, expectedMain]);
    return { ok: true, version: r.version, sha: expectedMain, tag: r.tag };
  };
  const out = await h.resume();
  assert.equal(out.status, 'done', out.reason);
  assert.equal(h.callsOf('releaseApp')[1].args[0].expectedMain, r.sha);
});

// Final review item 2: between "main has the change" and "the release exists" a drop would leave no way forward.
test('abandon is refused once main has the change but before the release (stage merged): resume makes the release', async () => {
  const { h, runId } = await mergedWithoutRelease();
  assert.equal(loadChangeRun(h.projectDir, runId).stage, 'merged');
  const projectBefore = h.project();
  const dropped = await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps });
  assert.deepEqual(dropped, { status: 'stopped', runId: null, reason: RELEASE_STILL_TO_MAKE('acme') });
  assert.equal(RELEASE_STILL_TO_MAKE('acme'), 'The change is already on the app\'s main line, so it cannot be dropped. Resume it to make the release and update the deployments (conductor change acme --resume); nothing more ships until you do.');
  assert.equal(loadChangeRun(h.projectDir, runId).status, 'failed');
  assert.deepEqual(h.project(), projectBefore);
  assert.equal((await h.resume()).status, 'done');
});

test('abandon is refused at stage approved once main has reached the changelog commit, and the project record is left alone', async () => {
  const { h, runId } = await mergedWithoutRelease();
  const run = loadChangeRun(h.projectDir, runId);
  const projectAfter = h.project();
  const before = { ...projectAfter, builtFromBrief: 1, approved: { ...projectAfter.approved, briefVersion: 1, sha: run.mainAtStart } };
  writeFileSync(path.join(h.projectDir, 'project.json'), JSON.stringify(before));
  run.stage = 'approved';
  saveChangeRun(h.projectDir, run);
  const dropped = await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps });
  assert.equal(dropped.status, 'stopped');
  assert.equal(dropped.runId, null);
  assert.equal(dropped.reason, RELEASE_STILL_TO_MAKE('acme'));
  assert.equal(h.project().builtFromBrief, 1);
  assert.equal(loadChangeRun(h.projectDir, runId).status, 'failed');
});

test('on resume a saved changelog commit that does not sit on the approved work is refused', async () => {
  const { h, runId } = await mergedWithoutRelease();
  const run = loadChangeRun(h.projectDir, runId);
  run.stage = 'approved';
  run.changelogSha = run.mainAtStart;
  saveChangeRun(h.projectDir, run);
  const out = await h.resume();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /does not sit directly on the work you approved/);
  assert.equal(h.callsOf('releaseApp').length, 1);
});

test('a ready app that never had its own release ends at merged and is told to ship with conductor ship (Ruling C4)', async () => {
  const h = await harness({ setup: { released: false, status: 'ready', deployments: [] } });
  const out = await h.change();
  assert.equal(out.status, 'done', out.reason);
  const gate = h.term.calls.find((c) => c.name === 'approveBuild').arg;
  assert.doesNotMatch(gate.approveLabel, /update \d+ deployment/);
  assert.match(gate.approveLabel, /nothing is shipped yet/);
  assert.match(gate.approveLabel, /conductor ship/);
  assert.match(out.report, /conductor ship acme/);
  assert.equal(h.callsOf('releaseApp').length, 0);
  const run = loadChangeRun(h.projectDir, out.runId);
  assert.equal(run.stage, 'merged');
  assert.equal(h.project().builtFromBrief, 2);
  assert.equal(appMain(h.appDir), run.changelogSha);
});

test('a deployment rolled back: the run pauses at shipping; resume asks; "no" leaves it; "yes" retries it and carries on', async () => {
  const h = await harness({ ctl: { outcomes: { 'acme-cloud': ['rolled-back', 'updated'] } } });
  const first = await h.change();
  assert.equal(first.status, 'stopped');
  assert.match(first.reason, /acme-cloud: the new version failed its health check/);
  let run = loadChangeRun(h.projectDir, first.runId);
  assert.equal(run.stage, 'shipping');
  assert.equal(run.status, 'paused');
  assert.equal(h.callsOf('updateDeployment').length, 1);

  const no = await h.resume();
  assert.equal(no.status, 'stopped');
  assert.match(no.reason, /You chose not to try acme-cloud again/);
  assert.equal(h.callsOf('updateDeployment').length, 1);
  const asked = h.term.calls.filter((c) => c.name === 'escalate').at(-1).arg;
  assert.equal(asked.kind, 'change');
  assert.equal(asked.title, 'retry a deployment');
  assert.deepEqual(asked.options, ['approve', 'reject']);

  h.ctl.escalate = 'approve';
  const yes = await h.resume();
  assert.equal(yes.status, 'done', yes.reason);
  assert.deepEqual(h.callsOf('updateDeployment').map((c) => c.args[0].name), ['acme-cloud', 'acme-cloud', 'acme-office']);
  assert.equal(h.callsOf('releaseApp').length, 1);
  run = loadChangeRun(h.projectDir, first.runId);
  assert.equal(run.status, 'done');
});

test('the ship passes the caller\'s ship state through unchanged, and a retry question without a terminal is "no"', async () => {
  const h = await harness({ ctl: { outcomes: { 'acme-cloud': ['rolled-back'] } } });
  const shipState = {};
  await h.change({ shipState });
  const call = h.callsOf('updateDeployment')[0];
  assert.equal(call.args[1].state, shipState);
  const term = { say: () => {}, approveBuild: async () => true, briefIo: {} };
  const out = await h.resume({ term });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /You chose not to try acme-cloud again/);
});

test('askOperator: true only for exactly "approve"', async () => {
  const term = (answer) => ({ escalate: async () => answer });
  assert.equal(await askOperator(term('approve'), { title: 't', message: 'm' }), true);
  const t = { escalate: async (q) => { t.q = q; return 'approve'; } };
  await askOperator(t, { title: 't', message: 'm' });
  assert.deepEqual(t.q, { kind: 'change', title: 't', message: 'm', options: ['approve', 'reject'] });
  assert.equal(await askOperator(term('Approve'), { title: 't', message: 'm' }), false);
  assert.equal(await askOperator(term(true), { title: 't', message: 'm' }), false);
  assert.equal(await askOperator({ escalate: async () => { throw new Error('x'); } }, { title: 't', message: 'm' }), false);
  assert.equal(await askOperator({}, { title: 't', message: 'm' }), false);
  assert.equal(await askOperator(undefined, { title: 't', message: 'm' }), false);
});

test('a paused build: resume calls runBuild again with the same change.runId', async () => {
  const h = await harness({ ctl: { buildResults: [{ status: 'paused', reason: 'The council paused.' }] } });
  const first = await h.change();
  assert.equal(first.status, 'paused');
  assert.equal(first.reason, 'The council paused.');
  const out = await h.resume();
  assert.equal(out.status, 'done', out.reason);
  const ids = h.callsOf('runBuild').map((c) => c.args[0].options.change.runId);
  assert.deepEqual(ids, [first.runId, first.runId]);
  assert.equal(h.callsOf('reviseBrief').length, 1, 'the brief is not revised again');
});

test('one unfinished change at a time: a new change is refused while one is paused; --abandon clears it', async () => {
  const h = await harness({ ctl: { buildResults: [{ status: 'paused', reason: 'The council paused.' }], leaveOnBranch: true } });
  const first = await h.change();
  assert.equal(first.status, 'paused');
  const again = await h.change();
  assert.equal(again.status, 'stopped');
  assert.equal(again.reason, UNFINISHED(first.runId, 'change'));
  const dropped = await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps });
  assert.equal(dropped.status, 'stopped');
  assert.match(dropped.reason, /Nothing reached the app's main line\./);
  assert.equal(loadChangeRun(h.projectDir, first.runId).status, 'stopped');
  assert.equal(loadChangeRun(h.projectDir, first.runId).reason, 'You dropped this change.');
  const none = await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps });
  assert.equal(none.reason, NOTHING_TO_RESUME);
  assert.equal((await h.resume()).reason, NOTHING_TO_RESUME);
});

test('a build left on its own branch by an abandoned change does not stop the next change', async () => {
  const h = await harness({ ctl: { gateAnswer: { stop: true }, leaveOnBranch: true } });
  const first = await h.change();
  assert.equal(first.status, 'paused');
  g(h.appDir, ['checkout', '-q', `build/${first.runId}`]);
  await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps });
  h.ctl.gateAnswer = true;
  h.ctl.leaveOnBranch = false;
  // brief v2 is already approved; the new change revises it to v3.
  h.ctl.v2 = null;
  h.deps.reviseBrief = async ({ projectDir }) => {
    writeBriefVersion(projectDir, 3, { revisedFrom: 2, features: V2_FEATURES, exampleSeq: V2_SEQ });
    return { status: 'approved', version: 3 };
  };
  const out = await h.change();
  assert.equal(out.status, 'done', out.reason);
  assert.deepEqual(loadChangeRun(h.projectDir, out.runId).brief, { from: 1, to: 3 });
  assert.equal(h.project().builtFromBrief, 3);
});

test('abandoning at the brief stage discards the open revision', async () => {
  const h = await harness({
    deps: {
      reviseBrief: async ({ projectDir }) => {
        writeFileSync(path.join(projectDir, 'brief', 'session.json'), '{}');
        return { status: 'paused', reason: 'No AI model can write the brief right now.' };
      },
    },
  });
  const first = await h.change();
  assert.equal(first.status, 'paused');
  const dropped = await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps });
  assert.match(dropped.reason, /Nothing reached the app's main line\./);
  assert.equal(existsSync(path.join(h.projectDir, 'brief', 'session.json')), false);
});

test('abandoning after main moved says the main line already has the change', async () => {
  const h = await harness({ ctl: { outcomes: { 'acme-cloud': ['rolled-back'] } } });
  await h.change();
  const dropped = await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps });
  assert.match(dropped.reason, /The app's main line already has this change; the deployments not yet updated stay on their current version\./);
});

test('brief resume adopts a newer brief approved after the run started (Ruling C10)', async () => {
  const h = await harness({ deps: { reviseBrief: async () => ({ status: 'paused', reason: 'No AI model can write the brief right now.' }) } });
  const first = await h.change();
  assert.equal(first.status, 'paused');
  // The session approved v2 and cleared itself, but the run never heard.
  writeBriefVersion(h.projectDir, 2, { revisedFrom: 1, features: V2_FEATURES, exampleSeq: V2_SEQ, approvedAt: '2026-10-27T15:00:00.000Z' });
  h.deps.reviseBrief = async () => { throw new Error('must not be called'); };
  const out = await h.resume();
  assert.equal(out.status, 'done', out.reason);
  assert.deepEqual(loadChangeRun(h.projectDir, out.runId).brief, { from: 1, to: 2 });
});

test('runChange never takes the project lock: it runs under the lock its caller holds (Contract 7 §7.11)', async () => {
  const h = await harness();
  const release = lockProject(h.projectDir, 'change');
  try {
    const out = await h.change();
    assert.equal(out.status, 'done', out.reason);
    assert.equal(h.callsOf('reviseBrief').length, 1);
  } finally { release(); }
});

test('a missing dep is refused before anything starts', async () => {
  const h = await harness();
  h.deps.releaseApp = undefined;
  const out = await h.change();
  assert.equal(out.status, 'failed');
  assert.equal(out.reason, MISSING_SEAMS(['releaseApp']));
  assert.equal(h.callsOf('reviseBrief').length, 0);
  assert.deepEqual(readdirSync(path.join(h.projectDir, 'builds')), []);
  assert.equal((await h.resume()).reason, MISSING_SEAMS(['releaseApp']));
  assert.equal((await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps })).reason, MISSING_SEAMS(['releaseApp']));
});

test('a brief draft already open is not taken over by a new change', async () => {
  const h = await harness();
  writeFileSync(path.join(h.projectDir, 'brief', 'session.json'), JSON.stringify({
    schema: 1, slug: 'acme', mode: 'revise', baseVersion: 1, notes: [], stage: 'draft', draft: null, pending: [], answers: [],
    changeRequests: [], problems: [], attempts: 0, rounds: 0, costUsd: 0, approving: null, startedAt: 'x', updatedAt: 'x',
  }));
  const out = await h.change();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /unfinished brief draft/);
  assert.equal(h.callsOf('reviseBrief').length, 0);
  assert.deepEqual(readdirSync(path.join(h.projectDir, 'builds')), []);
});

test('an unknown project is a plain stop', async () => {
  const h = await harness();
  const out = await h.change({ slug: 'nobody' });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /There is no project called "nobody"/);
});

test('the texts are as specified', () => {
  assert.equal(NOT_BUILT_YET, 'This project has not been built and approved yet, so there is nothing to change. Build it first with "conductor build <slug>".');
  assert.equal(NO_BUILT_FROM, 'This project does not record which brief version the app was built from, so Conductor cannot tell what a change would add. Nothing was changed.');
  assert.equal(UNFINISHED('20261027-143205-a1b2', 'change'), 'An earlier change (20261027-143205-a1b2) is not finished. Continue it with --resume, or drop it with --abandon, before starting another.');
  assert.equal(UNFINISHED('20261027-143205-a1b2', 'foundation-upgrade'), 'An earlier foundation upgrade (20261027-143205-a1b2) is not finished. Continue it with --resume, or drop it with --abandon, before starting another.');
  assert.equal(NOTHING_TO_RESUME, 'There is no unfinished change for this project.');
  assert.equal(MISSING_SEAMS(['a', 'b']), 'This Conductor is missing parts it needs for changes (a, b). Update Conductor; nothing was changed.');
  const files = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
  const q = TOO_MANY_CONFLICTS(12, files);
  assert.equal(q.title, 'the foundation upgrade');
  assert.equal(q.message, `Merging the foundation release left 12 files with both versions side by side (${files.slice(0, 10).join(', ')}, …). Conductor can try to resolve them, which uses your subscription, or you can stop and merge by hand. Approve to let Conductor try.`);
  assert.doesNotMatch(TOO_MANY_CONFLICTS(2, ['a', 'b']).message, /…/);
});

// ---- the foundation upgrade --------------------------------------------------------------------------------

test('foundation upgrade with no code conflicts: merged, built from the upgrade branch, patch release, shipped with the new foundation tag', async () => {
  const h = await harness();
  const out = await h.upgrade();
  assert.equal(out.status, 'done', out.reason);
  const run = loadChangeRun(h.projectDir, out.runId);
  assert.equal(run.kind, 'foundation-upgrade');
  const build = h.callsOf('runBuild')[0].args[0];
  assert.match(build.options.change.baseRef, /^factory\/upgrade-v0\.1\.1-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.deepEqual(build.options.change.units.map((u) => u.change), ['foundation-upgrade']);
  assert.equal(build.options.change.profile, null);
  assert.equal(h.callsOf('releaseApp')[0].args[0].bump, 'patch');
  assert.ok(h.callsOf('updateDeployment').every((c) => c.args[0].foundation === 'v0.1.1'));
  assert.deepEqual(h.callsOf('updateDeployment').map((c) => c.args[0].version), ['0.2.1', '0.2.1']);
  const project = h.project();
  assert.deepEqual(project.foundation, { repo: h.f.dir, tag: 'v0.1.1', commit: h.f.tagSha('v0.1.1') });
  assert.equal(project.builtFromBrief, 1);
  assert.equal(project.approved.briefVersion, 1);
  assert.equal(project.approved.sha, run.changelogSha);
  assert.match(readFileSync(path.join(h.appDir, 'CHANGELOG.md'), 'utf8'), /\*\*\[security\]\*\* Sessions now expire after 12 hours\. \(foundation 0\.1\.1\)/);
  const gate = h.term.calls.find((c) => c.name === 'approveBuild').arg;
  assert.match(gate.summary, /The foundation goes from v0\.1\.0 to v0\.1\.1\./);
  assert.match(gate.summary, /Security fixes this brings in:\n {4}- Sessions now expire after 12 hours\. \(0\.1\.1\)/);
  assert.match(gate.summary, /The app becomes version 0\.2\.1\./);
  assert.match(out.report, /The app is now version 0\.2\.1\./);
  assert.equal(h.callsOf('reviseBrief').length, 0);
});

test('foundation reads use the project\'s foundation repo, never the app folder', async () => {
  // The app folder carries no release tags at all (createApp removed them), so a read from it would fail.
  const h = await harness();
  assert.equal(g(h.appDir, ['tag', '--list', 'v0.1.*']), '');
  const out = await h.upgrade();
  assert.equal(out.status, 'done', out.reason);
});

test('foundation upgrade whose conflicts were not resolved is refused at the gate (markers left)', async () => {
  const f = await makeFoundationRepo({ extra110: { 'apps/server/src/feature.ts': 'export const base = 0;\n' }, extra111: { 'apps/server/src/feature.ts': 'export const fixed = 2;\n' } });
  const h = await harness({ setup: { foundation: f }, ctl: { commit: false } });
  const out = await h.upgrade();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, MARKERS_LEFT(['apps/server/src/feature.ts']));
  assert.equal(h.term.calls.filter((c) => c.name === 'approveBuild').length, 0);
  assert.equal(h.callsOf('releaseApp').length, 0);
  assert.equal(h.project().foundation.tag, 'v0.1.0');
  assert.equal(loadChangeRun(h.projectDir, out.runId).status, 'paused');
});

test('foundation upgrade with more than 20 conflicted files asks first; no terminal answer means stop, nothing spent', async () => {
  const base = {}; const next = {}; const app = {};
  for (let i = 0; i < 21; i++) {
    base[`apps/server/src/f${i}.ts`] = 'export const v = 0;\n';
    next[`apps/server/src/f${i}.ts`] = 'export const v = 1;\n';
    app[`apps/server/src/f${i}.ts`] = 'export const v = 2;\n';
  }
  const f = await makeFoundationRepo({ extra110: base, extra111: next });
  const h = await harness({ setup: { foundation: f } });
  writeFiles(h.appDir, app);
  g(h.appDir, ['add', '-A']);
  g(h.appDir, ['commit', '-q', '-m', 'app edits']);
  const term = { say: () => {}, approveBuild: async () => true, briefIo: {} };
  const out = await h.upgrade({ term });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /nothing was built/);
  assert.equal(h.callsOf('runBuild').length, 0);

  // With a terminal, the question is asked; a yes carries on to the build.
  const h2 = await harness({ setup: { foundation: f }, ctl: { escalate: 'approve', commit: false, buildResults: [{ status: 'paused', reason: 'later' }] } });
  writeFiles(h2.appDir, app);
  g(h2.appDir, ['add', '-A']);
  g(h2.appDir, ['commit', '-q', '-m', 'app edits']);
  const out2 = await h2.upgrade();
  assert.equal(out2.status, 'paused');
  const q = h2.term.calls.find((c) => c.name === 'escalate').arg;
  assert.equal(q.title, 'the foundation upgrade');
  assert.match(q.message, /left 21 files with both versions side by side/);
  assert.equal(h2.callsOf('runBuild').length, 1);
});

test('foundation upgrade to the tag the project is already on is refused before anything is changed', async () => {
  const h = await harness();
  const before = g(h.appDir, ['for-each-ref']);
  const out = await h.upgrade({ toTag: 'v0.1.0' });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /already on the foundation's v0\.1\.0/);
  assert.deepEqual(readdirSync(path.join(h.projectDir, 'builds')), []);
  assert.equal(g(h.appDir, ['for-each-ref']), before);
});

test('a foundation upgrade is refused while the brief is ahead of what the app was built from (Ruling C11)', async () => {
  const h = await harness();
  writeBriefVersion(h.projectDir, 2, { revisedFrom: 1, features: V2_FEATURES, exampleSeq: V2_SEQ });
  const out = await h.upgrade();
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /brief version 2/i);
  assert.deepEqual(readdirSync(path.join(h.projectDir, 'builds')), []);
});

test('an upgrade gate refusal after a check that throws is plain and resumable', async () => {
  const f = await makeFoundationRepo({ extra110: { 'apps/server/src/feature.ts': 'export const base = 0;\n' }, extra111: { 'apps/server/src/feature.ts': 'export const fixed = 2;\n' } });
  const h = await harness({ setup: { foundation: f } });
  // The approval waits on a commit the app does not have: the marker check cannot read it.
  h.deps.runBuild = async ({ hooks, options }) => {
    const sha = 'f'.repeat(40);
    writeFileSync(path.join(h.projectDir, 'builds', options.change.runId, 'council-report.json'), JSON.stringify({ runId: options.change.runId, sha, verdict: 'approved' }));
    const answer = await hooks.approveBuild({ summary: 'S', sha, branch: 'b', runId: options.change.runId, council: { status: 'approved', sha }, checks: { sha } });
    return answer === true ? { status: 'approved', sha } : { status: 'rejected', reason: 'no' };
  };
  const out = await h.upgrade();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, CHECK_FAILED);
  assert.equal(loadChangeRun(h.projectDir, out.runId).status, 'paused');
});

test('resume of an upgrade whose merge branch was landed but not saved adopts it; a foundation record that differs stops', async () => {
  const h = await harness({ ctl: { buildResults: [{ status: 'paused', reason: 'later' }] } });
  const first = await h.upgrade();
  assert.equal(first.status, 'paused');
  const forget = () => {
    const run = loadChangeRun(h.projectDir, first.runId);
    delete run.upgrade;
    run.stage = 'prepare';
    run.baseRef = 'main';
    saveChangeRun(h.projectDir, run);
    return run;
  };
  const saved = loadChangeRun(h.projectDir, first.runId).upgrade;
  forget();
  // The app's record of v0.1.1 now names another commit than the foundation's tag.
  g(h.appDir, ['update-ref', 'refs/foundation/v0.1.1', h.f.tagSha('v0.1.0')]);
  const bad = await h.resume();
  assert.equal(bad.status, 'stopped');
  assert.match(bad.reason, /records a different version of the foundation's v0\.1\.1 than the foundation now has/);

  const h2 = await harness({ ctl: { buildResults: [{ status: 'paused', reason: 'later' }] } });
  const one = await h2.upgrade();
  const kept = loadChangeRun(h2.projectDir, one.runId).upgrade;
  const run = loadChangeRun(h2.projectDir, one.runId);
  delete run.upgrade;
  run.stage = 'prepare';
  saveChangeRun(h2.projectDir, run);
  const out = await h2.resume();
  assert.equal(out.status, 'done', out.reason);
  assert.equal(loadChangeRun(h2.projectDir, one.runId).upgrade.mergeSha, kept.mergeSha);
  assert.ok(saved.branch);
});

test('UNFINISHED names a foundation upgrade', async () => {
  const h = await harness({ ctl: { buildResults: [{ status: 'paused', reason: 'later' }] } });
  const first = await h.upgrade();
  assert.equal(first.status, 'paused');
  const out = await h.change();
  assert.equal(out.reason, UNFINISHED(first.runId, 'foundation-upgrade'));
  const resumed = await h.resume();
  assert.equal(resumed.status, 'done', resumed.reason);
  assert.equal(h.project().foundation.tag, 'v0.1.1');
});

// ---- final review fix wave ----------------------------------------------------------------------------------

test('item 4: a brief approved while the change was paused stops the build plainly; nothing is built', async () => {
  const h = await harness({ ctl: { buildResults: [{ status: 'paused', reason: 'The council paused.' }] } });
  const first = await h.change();
  assert.equal(first.status, 'paused');
  writeBriefVersion(h.projectDir, 3, { revisedFrom: 2, features: V2_FEATURES, exampleSeq: V2_SEQ });
  const out = await h.resume();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, BRIEF_CHANGED_WHILE_PAUSED({ kind: 'change', slug: 'acme', current: 3, built: 2 }));
  assert.equal(out.reason, 'The approved brief changed while this change was paused (it is now version 3; the change was being built for version 2), so nothing was built. Drop this change with "conductor change acme --abandon", then start it again.');
  assert.equal(h.callsOf('runBuild').length, 1);
  assert.equal(loadChangeRun(h.projectDir, first.runId).status, 'paused');
  assert.equal((await abandonChange({ factory: h.factory, slug: 'acme', deps: h.deps })).runId, first.runId);
});

test('item 4: a foundation upgrade stops the same way when the brief moved on while it was paused', async () => {
  const h = await harness({ ctl: { buildResults: [{ status: 'paused', reason: 'later' }] } });
  const first = await h.upgrade();
  assert.equal(first.status, 'paused');
  writeBriefVersion(h.projectDir, 2, { revisedFrom: 1, features: V2_FEATURES, exampleSeq: V2_SEQ });
  const out = await h.resume();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, BRIEF_CHANGED_WHILE_PAUSED({ kind: 'foundation-upgrade', slug: 'acme', current: 2, built: 1 }));
  assert.match(out.reason, /^The approved brief changed while this foundation upgrade was paused/);
  assert.equal(h.callsOf('runBuild').length, 1);
});

test('item 5: a paused build\'s "conductor build" hint becomes the change resume hint', async () => {
  const h = await harness({ ctl: { buildResults: [{ status: 'paused', reason: 'The council hit a problem it could not get past (no model), so the build paused. Run "conductor build acme" to try again.' }] } });
  const out = await h.change();
  assert.equal(out.status, 'paused');
  assert.equal(out.reason, 'The council hit a problem it could not get past (no model), so the build paused. Run "conductor change acme --resume" to try again.');
});

test('item 5: a build stopped by a rejected escalation is paused and says how to resume', async () => {
  const h = await harness({ ctl: { buildResults: [{ status: 'stopped', reason: 'You stopped the build because the council still found problems that must be fixed. The build is kept.' }] } });
  const out = await h.change();
  assert.equal(out.status, 'paused');
  assert.equal(out.reason, 'You stopped the build because the council still found problems that must be fixed. The build is kept. Resume it with "conductor change acme --resume".');
  assert.equal(loadChangeRun(h.projectDir, out.runId).status, 'paused');
  // A reason that already names the resume command is not given it twice.
  const h2 = await harness({ ctl: { buildResults: [{ status: 'stopped', reason: 'You stopped at the build\'s approval without deciding. Run "conductor change acme --resume" to be asked again.' }] } });
  assert.equal((await h2.change()).reason, 'You stopped at the build\'s approval without deciding. Run "conductor change acme --resume" to be asked again.');
});

test('item 8: on resume a saved changelog commit that changes more than CHANGELOG.md is refused; main does not move', async () => {
  const { h, runId } = await mergedWithoutRelease();
  const run = loadChangeRun(h.projectDir, runId);
  // Back to "approved, main not moved yet", with a saved changelog commit that also adds code.
  g(h.appDir, ['reset', '-q', '--hard', run.mainAtStart]);
  const tree = g(h.appDir, ['rev-parse', `${run.changelogSha}^{tree}`]);
  const scratch = mkdtempSync(path.join(tmpdir(), 'idx-'));
  cleanup.push(scratch);
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, 'index') };
  execFileSync('git', ['-C', h.appDir, 'read-tree', tree], { env });
  const blob = execFileSync('git', ['-C', h.appDir, 'hash-object', '-w', '--stdin'], { input: 'export const sneaky = 1;\n', encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', h.appDir, 'update-index', '--add', '--cacheinfo', `100644,${blob},apps/server/src/sneaky.ts`], { env });
  const sneakyTree = execFileSync('git', ['-C', h.appDir, 'write-tree'], { env, encoding: 'utf8' }).trim();
  const sneaky = g(h.appDir, ['commit-tree', sneakyTree, '-p', run.approval.sha, '-m', 'changelog: change from brief v2']);
  run.changelogSha = sneaky;
  run.stage = 'approved';
  run.status = 'failed';
  saveChangeRun(h.projectDir, run);
  const out = await h.resume();
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, 'The saved changelog commit changes more than the changelog, so Conductor stopped rather than add something else to the app.');
  assert.equal(appMain(h.appDir), run.mainAtStart);
});

test('item 3: an upgrade passes the target foundation (tag and commit) to the change build', async () => {
  const h = await harness();
  const out = await h.upgrade();
  assert.equal(out.status, 'done', out.reason);
  const change = h.callsOf('runBuild')[0].args[0].options.change;
  assert.deepEqual(change.foundation, { tag: 'v0.1.1', commit: h.f.tagSha('v0.1.1') });
  // A change request builds on the foundation the project already records: nothing is passed.
  const h2 = await harness();
  assert.equal((await h2.change()).status, 'done');
  assert.equal(h2.callsOf('runBuild')[0].args[0].options.change.foundation, undefined);
});
