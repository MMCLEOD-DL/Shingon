# Task 8: The build loop

`runBuild` drives one build of one project: refusals before any spend (index Ruling 10), then the phases `setup` → `split` → `features` → `final`, saving `build.json` after every step that matters. `conductor build <slug>` (and `conductor resume` inside the project folder, Task 15) calls it; when an unfinished build exists, it carries on from where it stopped.

- **setup:**
  1. `createApp` (pinned commit).
  2. Record `project.json.foundation = { repo, tag, commit }` when missing (Contract 7 §7.5), and set `status: 'building'`.
  3. Run a **baseline** `runAppChecks` on `main` (browser off). It must pass before anything is spent.
  4. Check out `build/<runId>` from `main`.
  5. `nameApp`: the BRAND line and `app-profile.json`, in one commit.
  6. `build.baseSha` = the build branch head.
- **split:** `runSplit`; the units are saved; with `options.approvePlan` the operator confirms the list (`hooks.approvePlan`).
- **features:** one Conductor run per unit (index Rulings 1, 7, 8), resumed when its workspace is unfinished, restarted when it was stopped or rejected, merged as one commit when landed.
- **final:** `deps.runFinal(bctx)` (Task 9). It returns either an outcome or `{ next: 'features' }` after appending fix units.

**Files:**
- Create: `src/factory/build.js`
- Test: `test/factory-build.test.js`

**Interfaces:**
- Consumes: `factoryConfig` (Plan 7, extended in Task 1); `readProject`, `saveProject` (`src/factory/projects.js`, Plan 7); `lockProject` (`src/factory/projectLock.js`, Plan 7); `loadBrief`, `renderBrief`, `currentBriefInfo` (`src/factory/brief.js`, Plan 7, defaults of `deps`); `createApp`, `nameApp` (Task 2); `featureRequest`, `acceptanceStep` (Task 3); `runSplit`, `briefProblems` (Task 4); `FEATURE_COUNCIL` (Task 5); `runAppChecks`, `testDatabaseProblem`, `VERIFY_COMMAND` (Task 6); everything in Task 7; `runTask`, `resume` (`src/conductor.js`); `RunLog` (`src/runlog.js`); `git` (`src/workspace.js`); `newRunId` (Task 1).
- Produces:
  - `runBuild({ factory, slug, team, hooks, options = {}, baseDir, warnings = [], env = process.env, deps = {} }) -> Promise<BuildOutcome>`
  - `deps` defaults: `{ runTask, resume, runAppChecks, loadBrief, renderBrief, currentBriefInfo, mergeFeature, runFinal: (bctx) => import('./buildFinal.js').then((m) => m.runFinal(bctx)), now: () => new Date() }`
  - `options.newBuild: true` (from `--new`, Task 15) abandons an unfinished build (marked `stopped`, reason `Replaced by build <new runId>.`) and starts a new one. It is a `runBuild` argument, not a `DEFAULT_OPTIONS` key: strip it before passing options to `runTask`.
  - **Seam for Plan 11 (not built here):** Contract 7 §7.7 reserves `options.change = { runId, baseRef, units }`. Plan 11 adds it, and with it:
    - the setup phase skips app creation and naming;
    - the split phase is skipped, and `units` is used as given;
    - the `ready`/`shipped` refusal is lifted for that call only.
    - To keep that change small, the phases are separate inner functions (`setupPhase`, `splitPhase`, `featuresPhase`, `finalPhase`) called in turn. The option is stripped with `newBuild` before `runTask`.
    - This plan neither reads nor validates `options.change`.
  - `options.councilFixRounds` is Plan 5's per-run option: the council bounce-back inside one feature run. The whole-app council's cap is `factory.build.councilFixRounds` (Task 9).
  - **`bctx`** (handed to `runFinal`): `{ factory, slug, projectDir, appDir, buildDir, project, brief, build, team, hooks, options, baseDir, warnings, env, deps, save(), emit(type, data), progress(text), runFeatures() }`. `save()` writes `build.json`; `emit` writes `build-log.jsonl` and calls `hooks.onEvent`; `progress` calls `hooks.onProgress?.(text)`.
  - Feature run options: `{ ...options, testCommand: factory.build.testCommand ?? VERIFY_COMMAND, keepWorkspace: true, council: true, councilMembers: [...FEATURE_COUNCIL], factoryFeature: { id: unit.id, tags: unit.acceptance }, firstChunk: acceptanceStep({ brief, unit }) }`.
  - Commit message on the build branch: `Feature <k>/<n>: <title> (<id>)`; fix units: `Fix <k>/<n>: <title>`.

- [ ] **Step 1: Write the failing tests**

Create `test/factory-build.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { runBuild } from '../src/factory/build.js';
import { factoryConfig } from '../src/factory/config.js';
import { latestBuild, buildDirOf } from '../src/factory/buildState.js';
import { mergeFeature as realMerge } from '../src/factory/buildState.js';
import { git } from '../src/workspace.js';
import { fakeParticipant, approve } from './helpers/fakes.js';
import { makeFoundationRepo, makeProject, sampleBrief } from './helpers/factoryFixtures.js';

const UNITS = [
  { id: 'expenses', title: 'Submit and list expenses', covers: ['submit-expense'], acceptance: ['submit-expense#1', 'submit-expense#2'], instructions: 'Add expenses.', dependsOn: [] },
  { id: 'report', title: 'Monthly report', covers: ['monthly-report'], acceptance: ['monthly-report#1'], instructions: 'Add the report.', dependsOn: ['expenses'] },
];
const json = (o) => ({ text: '```json\n' + JSON.stringify(o) + '\n```' });
const PLAN = { summary: 'S', chunks: [{ title: 'Build it', instructions: 'write the code' }] };

function team({ local } = {}) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, task) => (role === 'reviewer' ? approve() : /Split this approved brief/.test(task) ? json({ units: UNITS }) : json(PLAN)) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task) => (/member of a review council/.test(task) ? json({ findings: [] }) : approve()) }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: local ?? ((role, task, c, opts) => {
      const step = task.match(/You are doing chunk \d+ of \d+: (.*)/)[1];
      const id = task.match(/^Build step \d+ of \d+ for Acme Ltd: .* \(([a-z-]+)\)/m)[1];
      mkdirSync(path.join(opts.cwd, 'apps/server/test', id), { recursive: true });
      if (step === 'Acceptance tests') {
        const tags = [...new Set(task.match(/\[[a-z-]+#\d+\]/g))];
        writeFileSync(path.join(opts.cwd, 'apps/server/test', id, 'accept.test.ts'), tags.map((t) => `it('${t} works', () => {});`).join('\n') + '\n');
      } else writeFileSync(path.join(opts.cwd, `${id}.ts`), 'export {};\n');
      return { text: 'done' };
    }) }),
  };
}

async function setup({ status = 'briefing', testCommand = 'node -e "process.exit(0)"' } = {}) {
  const repo = await makeFoundationRepo();
  const { projectsRoot, projectDir, slug } = makeProject({ status });
  const raw = { projectsRoot, foundation: { repo, tag: 'v0.1.0' }, build: { testCommand, browserGate: false } };
  const factory = factoryConfig({ factory: raw }, { env: {} });
  const checks = [];
  const finals = [];
  const deps = {
    loadBrief: () => sampleBrief(), renderBrief: (b) => `# ${b.client}`, currentBriefInfo: () => ({ version: 1, approvedAt: '2026-10-27T10:00:00Z', approvedBy: 'operator' }),
    runAppChecks: async (o) => { checks.push(o); return { verify: { status: 'passed', summary: 'ok', output: '' }, browser: { status: 'skipped', summary: '', output: '' }, reports: [] }; },
    runFinal: async (bctx) => { finals.push(bctx); return { status: 'ready', runId: bctx.build.runId, buildDir: bctx.buildDir }; },
  };
  const hooks = { escalate: async () => 'reject', approveBuild: async () => true };
  return { repo, raw, projectsRoot, projectDir, slug, factory, deps, hooks, checks, finals };
}
const log = async (dir, ref) => (await git(dir, ['log', '--format=%s', ref])).stdout.trim().split('\n');

test('a fresh build: app made and named, features split and built tests-first, one commit each, then the final phase', async () => {
  const s = await setup();
  const t = team();
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: t, hooks: s.hooks, deps: s.deps, env: {} });
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
    const out = await runBuild({ factory: s.factory, slug: s.slug, team: t, hooks: s.hooks, deps: s.deps, env: {} });
    assert.equal(out.status, 'failed');
    assert.match(out.reason, re);
    assert.equal(t.author.calls.length, 0);
  }
  const s = await setup({ testCommand: null });
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: s.hooks, deps: s.deps, env: {} });
  assert.match(out.reason, /TEST_DATABASE_URL is not set/);
  const m = await setup();
  const out2 = await runBuild({ factory: m.factory, slug: m.slug, team: team(), hooks: m.hooks, deps: { ...m.deps, loadBrief: () => sampleBrief({ modules: ['ocr'] }) }, env: {} });
  assert.match(out2.reason, /optional modules \(ocr\)/);
});

test('a red baseline stops before the split', async () => {
  const s = await setup();
  const t = team();
  const red = async () => ({ verify: { status: 'failed', summary: 'The checks FAIL', output: 'no database' }, browser: { status: 'skipped', summary: '', output: '' }, reports: [] });
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: t, hooks: s.hooks, deps: { ...s.deps, runAppChecks: red }, env: {} });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /The foundation does not pass its own checks on this computer/);
  assert.equal(t.author.calls.length, 0);
});

test('a crash between landing a feature and merging it: the next run merges it once and does not rebuild it', async () => {
  const s = await setup();
  let crashed = false;
  const merge = async (a) => { if (!crashed) { crashed = true; throw new Error('power cut'); } return realMerge(a); };
  const first = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: s.hooks, deps: { ...s.deps, mergeFeature: merge }, env: {} });
  assert.equal(first.status, 'failed');
  assert.match(first.reason, /Conductor hit an internal problem and stopped.*conductor build acme-ltd/s);
  assert.equal(latestBuild(s.projectDir).features[0].status, 'landed');
  const t2 = team();
  const second = await runBuild({ factory: s.factory, slug: s.slug, team: t2, hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(second.status, 'ready');
  assert.equal(second.runId, first.runId, 'the same build carried on');
  assert.equal(t2.local.calls.some((c) => /\(expenses\)/.test(c.task)), false, 'feature 1 was not built again');
  const appDir = path.join(s.projectDir, 'app');
  assert.equal((await log(appDir, `build/${first.runId}`)).filter((l) => l.startsWith('Feature 1/2')).length, 1);
});

test('a feature whose checks fail is not accepted: the build stops, and the next run starts that feature again', async () => {
  const s = await setup({ testCommand: 'node -e "process.exit(1)"' });
  // councilFixRounds here is Plan 5's per-feature-run option (no bounce-back), not factory.build.councilFixRounds
  const out = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: s.hooks, deps: s.deps, options: { councilFixRounds: 0 }, env: {} });
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /Feature 1 \(Submit and list expenses\) was not accepted/);
  assert.match(out.reason, /conductor build acme-ltd/);
  const b = latestBuild(s.projectDir);
  assert.equal(b.features[0].status, 'stopped');
  const fixed = factoryConfig({ factory: { ...s.raw, build: { testCommand: 'node -e "process.exit(0)"', browserGate: false } } }, { env: {} });
  const again = await runBuild({ factory: fixed, slug: s.slug, team: team(), hooks: s.hooks, deps: s.deps, env: {} });
  assert.equal(again.status, 'ready');
  assert.equal(latestBuild(s.projectDir).features[0].attempts, 2);
});

test('a brief changed since the build started is refused; --new starts a fresh build', async () => {
  const s = await setup();
  const stop = { ...s.deps, runFinal: async (bctx) => { bctx.build.status = 'paused'; bctx.save(); return { status: 'paused', runId: bctx.build.runId, buildDir: bctx.buildDir, reason: 'p' }; } };
  const first = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: s.hooks, deps: stop, env: {} });
  const changed = { ...s.deps, loadBrief: () => sampleBrief({ purpose: 'Something else entirely.' }) };
  const refused = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: s.hooks, deps: changed, env: {} });
  assert.equal(refused.status, 'failed');
  assert.match(refused.reason, /The brief has changed since build .* started/);
  const fresh = await runBuild({ factory: s.factory, slug: s.slug, team: team(), hooks: s.hooks, deps: changed, options: { newBuild: true }, env: {} });
  assert.notEqual(fresh.runId, first.runId);
  assert.equal(JSON.parse(readFileSync(path.join(buildDirOf(s.projectDir, first.runId), 'build.json'), 'utf8')).reason, `Replaced by build ${fresh.runId}.`);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-build.test.js`
Expected: FAIL (`Cannot find module '../src/factory/build.js'`).

- [ ] **Step 3: Implement refusals, the lock and build selection**

In `runBuild`, before anything is spent, in this order (each returns `{ status: 'failed', runId: null, buildDir: null, reason }`):
1. `readProject(factory.projectsRoot, slug)` (its own plain message on a missing project).
2. `project.status` `ready` or `shipped` → `<client> is already built and approved. Changes to a finished app will go through "conductor change", which is not available yet.` (Plan 11 lifts this for `options.change` only.)
3. `deps.loadBrief(projectDir)` (Plan 7's plain message when none is approved), then `briefProblems(brief)` joined by spaces.
4. `testDatabaseProblem({ testCommand: factory.build.testCommand, env })`.
5. `release = lockProject(projectDir, 'build')` (Plan 7; its own "busy: a <kind> is running (pid …, since …)" message becomes the `reason`). Everything after this runs in `try { … } finally { release() }`.

Then: `latest = latestBuild(projectDir)`. When `latest` is unfinished (`running`, `paused`, `failed`, `stopped`) and `options.newBuild` is not set: its `briefHash` must equal `hashBrief(brief)`, else refuse `The brief has changed since build <runId> started, so Conductor will not mix the two. Run "conductor build <slug> --new" to start a fresh build from the current brief.`; carry on with it (`status: 'running'`, `emit('build-start', { runId, slug, resumed: true })`). Otherwise (`newBuild`, or nothing unfinished) mark an unfinished `latest` as `stopped` with `Replaced by build <new runId>.` and create `newBuild({ runId: newRunId(deps.now()), slug, client: brief.client, briefHash: hashBrief(brief), briefVersion: deps.currentBriefInfo(projectDir)?.version ?? null, foundation, now })`. The gate copies `briefVersion` into `project.json.approved.briefVersion` and `builtFromBrief` (Task 9, Contract 7 §7.5).

- [ ] **Step 4: Implement the phases**

- **setup** (re-entrant; each step checks whether it was already done):
  - `createApp({ projectDir, foundation: project.foundation?.tag ? project.foundation : factory.foundation, expectCommit: project.foundation?.commit ?? null })`; record `foundation: { repo, tag, commit }` on the project when its `tag` is null, `status: 'building'`, `saveProject`; `build.foundation` = the same.
  - When `build.baseline` is unset: `deps.runAppChecks({ appDir, sha: <main>, workDir: <buildDir>/check, reportsDir: <buildDir>/baseline, testCommand: factory.build.testCommand, browser: false, env })`. Not `passed` → `finish('failed', 'The foundation does not pass its own checks on this computer, so building on it would hide problems. <verify.summary> The output is in <buildDir>/build-log.jsonl.')` (the output itself goes to the build log only). Save `build.baseline = { status, summary }`.
  - The app checkout must be clean (`status --porcelain`, else the `mergeFeature` dirty message); `checkout -q build/<runId>` when the branch exists, otherwise `checkout -q -b build/<runId> main`.
  - `nameApp({ appDir, brief })` (the BRAND line and `app-profile.json`, Task 2); `build.baseSha = rev-parse HEAD`; `phase = 'split'`; save.
- **split:** a split workspace is a scratch clone of the app (`git clone --no-hardlinks <appDir> <baseDir>/split-<runId>`, removed afterwards, Ruling 8) with a `RunLog` at `<buildDir>/split`; `runSplit({ team, hooks, log, cwd, options: { ...DEFAULT_OPTIONS, ...options }, usage: build.usage, renderBrief: deps.renderBrief }, brief)`. `paused`/`failed`/`stopped` → `finish` with that status and reason. Save `units`, `features = units.map((u) => ({ id: u.id, title: u.title, status: 'pending', attempts: 0, workspaceDir: null, branch: null, landedSha: null, baseSha: null, mergedSha: null, transcript: null, notes: [], councilText: null, gateReason: null }))`, any `note` into `build.notes`, `emit('build-split', …)`. With `options.approvePlan`: `hooks.approvePlan({ summary: 'Features to build, in order:', steps: units.map((u) => u.title) })` must return exactly `true`, else `finish('stopped', 'You did not approve the list of features, so nothing was built.')`. `phase = 'features'`; save.
- **features:** `runFeatures()` walks `build.features` from the first that is not `merged`, calling `progress('Feature <k> of <n>: <title>')` and `emit('build-feature', …)`. For each:
  1. The app checkout must be clean and on `build.branch`; `head` = its tip. When `f.baseSha` is set and differs from `head` while `f.status !== 'landed'`, fail with the `mergeFeature` "not where Conductor left it" message.
  2. `state = f.workspaceDir ? readRunState(f.workspaceDir) : null`.
     - `state?.status === 'landed'` → it landed before a crash: take `state.branch` and `state.landing.sha`.
     - `state?.status` in `running`/`failed`/`paused` → `deps.resume({ workspaceDir, repoDir: appDir, team, hooks: featureHooks, options: runOpts, warnings })`.
     - otherwise → archive any old workspace (`archiveFeatureRun`), `f.attempts += 1`, `f.baseSha = head`, save, then `deps.runTask({ repoDir: appDir, request: featureRequest({ brief, units: build.units, index }), team, hooks: featureHooks, options: runOpts, baseDir, warnings })`.
  3. `featureHooks` = the caller's hooks with: `onEvent` that records `f.workspaceDir` on the run's `start` event and saves at once, adds every `result` event's `costUsd` to `build.usage.costUsd` (saved at the end of the feature), and forwards the event; `approveResult` as below; `confirmLocalFallback` that asks the caller's hook once per process and remembers a `true`.
  4. Outcome: `landed` → `f.status = 'landed'`, `branch`, `landedSha` (from `readRunState(out.workspaceDir).landing.sha`), `f.notes` = that state's `notes`, its `warnings` added to `build.warnings` (no duplicates), save; `deps.mergeFeature({ appDir, buildBranch: build.branch, landedBranch, landedSha, expectedBase: f.baseSha, message })` → `f.mergedSha`, `f.status = 'merged'`; `f.transcript = archiveFeatureRun(…)`; save; `emit('build-feature-done', …)`. `paused` → `finish('paused', out.reason)`. `failed` → `finish('failed', out.reason)`. `rejected`/`stopped` → `f.status = 'stopped'`; `finish('stopped', 'Feature <k> (<title>) was not accepted: <f.gateReason ?? out.reason> Fix the cause, then run "conductor build <slug>" to try that feature again.')`.
- **The feature gate (`approveResult`)**, fail closed (Ruling 7): keep `f.councilText = council?.text ?? null` and the run's notes; `tests?.passed !== true` → `gateReason = 'its checks (npm run verify) still fail.'`, return `false`; `council?.verdict === 'blocked' && !council.overridden` → `gateReason = 'the feature council still found problems.'`, `false`; `finalReview.decision === 'BLOCK'` → `hooks.escalate({ kind: 'feature', title: \`feature <k> of <n> (<title>)\`, options: ['approve', 'reject'], message })` where `message` reads `Conductor needs your decision on: feature <k> of <n> (<title>)\n\nWhat happened: The final review of this feature raised a concern, although its checks pass.\n\nThe concern: <finalReview.reason>\n\nApprove to add the feature to the build, or reject to stop the build here (you can carry on later).`; only `'approve'` returns `true` (else `gateReason = 'you did not accept the reviewer\'s concern.'`). Otherwise `true`.
- **final:** `phase = 'final'`; `r = await deps.runFinal(bctx)`; `{ next: 'features' }` → back to the features phase (fix units were appended); otherwise return `r`.
- `finish(status, reason)` sets `build.status`, `build.reason`, saves, emits `build-finish`, and returns the outcome. A throw anywhere after the lock: emit `build-error` with the detail, `finish('failed', 'Conductor hit an internal problem and stopped. The build so far is kept; run "conductor build <slug>" to carry on. Details are in <buildDir>/build-log.jsonl.')`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/factory-build.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/build.js test/factory-build.test.js
git commit -m "feat(factory): conductor build drives one Conductor run per feature, resumably

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
