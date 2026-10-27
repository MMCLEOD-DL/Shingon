# Task 9: The change pipeline and resume

This task joins Tasks 1–8 into the two commands' library functions and the resume path. The run is a stage machine saved in `change.json` after **every** step, so a crash or Ctrl-C at any point resumes without asking the gate again once the approved work has landed, without a second release, and without updating a box twice (Review Focus 3).

```
change:   brief ─┐
                 ├─▶ build ─▶ approved ─▶ merged ─▶ released ─▶ shipping ─▶ done
upgrade:  prepare┘   (Plan 8 loop + Plan 9 council + change gate)
```

| Stage | Work (in order) | Saved before moving on | Stops as |
|---|---|---|---|
| `brief` | `from = project.builtFromBrief ?? currentBriefVersion()`; `deps.reviseBrief`; `briefDelta(v[from], v[to])`; `deltaProblem`; `buildItems` | `brief: { from, to }`, `delta`, `items` | not approved → `stopped`; paused/failed → same status, resumable |
| `prepare` | `releaseTags`, `upgradeTargetProblem`, read changelog at the tag, `prepareUpgradeMerge`; > 20 conflicts asks | `upgrade`, `baseRef = upgrade.branch`, `items = [upgradeItem]` | refusal → `stopped` |
| `build` | `deps.buildFeatures` (first time) or `deps.resumeBuild`, with the change gate as `approveResult` | `build: { status, branch, workspaceDir, reason }`; the gate saves `approval` and moves the stage to `approved` | rejected → `rejected`; gate refusal → `stopped` with `run.refusal`; paused/failed → resumable |
| `approved` | find the landed branch (from `build.branch`, or any app branch at `approval.sha` after a crash); check it is exactly `approval.sha`; `commitChangelog`; `advanceMain` | `changelogSha`; then `project.builtFromBrief = brief.to` (change) or `project.foundation.tag = toTag` (upgrade) | `MAIN_MOVED`, `NOT_APPROVED_COMMIT` → `stopped` |
| `merged` | `deps.releaseApp({ bump })` unless the release already exists; `releaseProblem` | `release: { version, sha }` | release failed → `failed` (resumable); release check fails → `stopped` |
| `released` / `shipping` | `shipUpdate` | `deployments[name]` after each box | a box did not update → run `paused` at `shipping` (resume asks before retrying); outcome `stopped` |
| `done` | write the final report | `status: 'done'` | — |

**Files:**
- Create: `src/factory/change/pipeline.js`
- Test: `test/factory-change-pipeline.test.js`

**Interfaces:**
- Consumes: everything in Tasks 1–8 (index Shared Interfaces); `fakeParticipant`, `approve` (`test/helpers/fakes.js`).
- Produces:
  - `runChange`, `runFoundationUpgrade`, `resumeChange` (index), and `abandonChange({ projectDir, deps }) -> Promise<ChangeOutcome>`;
  - `askOperator(term, { title, message }) -> Promise<boolean>`: builds `{ kind: 'change', title, message, options: ['approve', 'reject'] }`, calls `term.escalate`, returns `true` only for exactly `'approve'`, `false` on anything else or a throw;
  - the gate argument also carries `approveLabel: \`approve → add to the app and update ${n} deployment${n === 1 ? '' : 's'}\`` (Task 11 shows it);
  - texts:
    - `NOT_BUILT_YET = 'This project has not been built yet, so there is nothing to change. Build it first with "conductor build <slug>".'`
    - `UNFINISHED(runId, kind)` = `` `An earlier ${kind === 'change' ? 'change' : 'foundation upgrade'} (${runId}) is not finished. Continue it with --resume, or drop it with --abandon, before starting another.` ``
    - `NOTHING_TO_RESUME = 'There is no unfinished change for this project.'`
    - `TOO_MANY_CONFLICTS(n, files)` question: title `the foundation upgrade`, message `` `Merging the foundation release left ${n} files with both versions side by side (${first 10 files}${n > 10 ? ', …' : ''}). Conductor can try to resolve them, which uses your subscription, or you can stop and merge by hand. Approve to let Conductor try.` ``
    - `MISSING_SEAMS(names)` = `` `This Conductor is missing parts it needs for changes (${names.join(', ')}). Update Conductor; nothing was changed.` ``

- [ ] **Step 1: Write the failing tests**

Fixtures from Task 1: a foundation with `v0.1.0` and `v0.1.1`, a project on `v0.1.0`, `builtFromBrief: 1`, whose app has made one release of its own (`0.2.0`, as in Task 6's fixture), and two deployments `acme-cloud` and `acme-office`, both on `0.2.0`. Stubs:
- `reviseBrief` writes `brief-v2.json` (Task 3's example `next`) and returns `{ status: 'approved', version: 2 }`; `loadBriefVersion` reads `brief-v<n>.json`;
- `buildFeatures` simulates Plan 8: it commits the change on a branch of the app starting from `baseRef`, calls `hooks.approveResult({ summary: 'S', files, diff: '', council, sha })` with a configurable council report, then lands a `conductor/…` branch at `sha` when the answer is `true` and returns `{ status: 'landed', branch }`, or `{ status: 'rejected', note }`;
- `releaseApp` makes a release commit on the app's `main` (version fields, changelog `Unreleased` moved under the new version) and tags it, returning `{ ok: true, version, sha }`;
- `updateDeployment` records calls and returns `updated`;
- `term` records `say` lines, answers `approveResult` with `true`, and `escalate` with `'reject'` unless set.

```js
test('change: brief → build → council passed → gate → main → release → both deployments updated', async () => {
  const out = await runChange({ projectDir, notesFile, team, term, config, deps });
  assert.equal(out.status, 'done');
  const run = loadChangeRun(projectDir, out.runId);
  assert.equal(run.stage, 'done');
  assert.deepEqual(run.brief, { from: 1, to: 2 });
  assert.deepEqual(deps.calls.find((c) => c.name === 'buildFeatures').arg.features.map((f) => f.id), ['mileage-claims', 'monthly-report', 'remove-paper-upload']);
  assert.equal(deps.calls.find((c) => c.name === 'buildFeatures').arg.baseRef, 'main');
  assert.equal(deps.calls.find((c) => c.name === 'releaseApp').arg.bump, 'minor');
  assert.equal(await appMain(appDir), run.release.sha);
  assert.match(readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'), /- Change \(brief v2\): added Mileage claims/);
  assert.equal(JSON.parse(readFileSync(path.join(projectDir, 'project.json'), 'utf8')).builtFromBrief, 2);
  assert.deepEqual(deps.calls.filter((c) => c.name === 'updateDeployment').map((c) => [c.arg.name, c.arg.version]), [['acme-cloud', '0.3.0'], ['acme-office', '0.3.0']]);
  const gate = term.calls.find((c) => c.name === 'approveResult').arg;
  assert.match(gate.summary, /If you approve:\n {2}Added: Mileage claims\./);
  assert.match(gate.summary, /The app becomes version 0\.3\.0\./);
  assert.match(gate.summary, /These deployments are then updated one at a time, each with a backup first and an automatic undo if it fails: acme-cloud \(0\.2\.0\), acme-office \(0\.2\.0\)\./);
  assert.equal(gate.approveLabel, 'approve → add to the app and update 2 deployments');
  assert.match(out.report, /acme-office: updated to 0\.3\.0/);
});

test('the full council options reach the build; a build without the council is refused before anything is spent', async () => {
  // projectCouncilOptions returns { council: true, councilScope: 'whole-app', … } → those keys are in buildFeatures' options
  // projectCouncilOptions returns {} → out.status 'stopped', reason COUNCIL_MISSING, buildFeatures never called
});

test('a blocked council that the operator did not override never reaches the operator or the app', async () => {
  // buildFeatures passes council { verdict: 'blocked', overridden: false }
  // term.approveResult is never called; out.status 'stopped'; out.reason === COUNCIL_NOT_PASSED
  // app main unchanged; releaseApp and updateDeployment never called; project.json builtFromBrief still 1
});

test('an overridden council ships, and the report says the operator chose to', ...)
test('the operator rejects at the gate: nothing reaches main, the new brief version is kept, builtFromBrief stays', ...)
  // out.status 'rejected'; out.reason /You did not approve the change\. The new brief \(v2\) is kept; the app is still built from brief v1\./
test('the operator does not approve the revised brief: stopped before any build', ...)
test('a delta that is not a change (hosting moved) is refused before the build', ...)   // HOSTING_CHANGED, no buildFeatures call
test('a project that has not been built yet is refused', ...)                         // status 'building' → NOT_BUILT_YET
test('main moved while the change was being built: nothing is released or shipped, and the report says where the work is', ...)
  // buildFeatures commits to app main before landing → out.status 'stopped', reason MAIN_MOVED; no releaseApp call

test('crash after the gate approved but before main moved: resume finishes without asking again', async () => {
  // deps.commitChangelog… simulate: run stage 'approved' with approval and build.branch saved, then call resumeChange
  // term.approveResult not called during resume; buildFeatures/resumeBuild not called; main advanced; release made once
});
test('crash after landing but before the build outcome was saved: resume finds the landed branch by the approved commit', ...)
  // run.stage 'approved', no build.branch, a conductor/… branch at approval.sha in the app → carries on; resumeBuild not called
test('crash after the release: resume does not release again', ...)               // run.release set → releaseApp not called
test('a release that already happened but was not saved is adopted, not repeated', ...)
  // run.stage 'merged', no run.release, but app main has a release commit tagged v<expectedVersion> → adopted after releaseProblem; releaseApp not called
test('a deployment rolled back: the run pauses at shipping; resume asks; "no" leaves it; "yes" retries it and carries on', ...)
test('one unfinished change at a time: a new change is refused while one is paused; --abandon clears it', ...)
  // runChange while a paused run exists → UNFINISHED(runId, 'change'); abandonChange → status 'stopped'; runChange then starts
test('a second command on the same project while one is running is refused by the lock', ...)

test('foundation upgrade with no code conflicts: merged, built from the upgrade branch, patch release, shipped with the new foundation tag', async () => {
  const out = await runFoundationUpgrade({ projectDir, toTag: 'v0.1.1', team, term, config, deps });
  assert.equal(out.status, 'done');
  const build = deps.calls.find((c) => c.name === 'buildFeatures').arg;
  assert.match(build.baseRef, /^factory\/upgrade-v0\.1\.1-upgrade-/);
  assert.deepEqual(build.features.map((f) => f.change), ['foundation-upgrade']);
  assert.equal(deps.calls.find((c) => c.name === 'releaseApp').arg.bump, 'patch');
  assert.ok(deps.calls.filter((c) => c.name === 'updateDeployment').every((c) => c.arg.foundation === 'v0.1.1'));
  assert.equal(JSON.parse(readFileSync(path.join(projectDir, 'project.json'), 'utf8')).foundation.tag, 'v0.1.1');
  assert.match(readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'), /\*\*\[security\]\*\* Sessions now expire after 12 hours\. \(foundation 0\.1\.1\)/);
  const gate = term.calls.find((c) => c.name === 'approveResult').arg;
  assert.match(gate.summary, /Security fixes this brings in:\n {4}- Sessions now expire after 12 hours\. \(0\.1\.1\)/);
});
test('foundation upgrade whose conflicts were not resolved is refused at the gate (markers left)', ...)
  // buildFeatures lands the merge commit unchanged (markers still there) → gate refuses: MARKERS_LEFT([...]); not asked; nothing released
test('foundation upgrade with more than 20 conflicted files asks first; no terminal answer means stop, nothing spent', ...)
test('foundation upgrade to the tag the project is already on is refused before anything is changed', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-pipeline.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/pipeline.js`**

- Every entry point: `missingSeams(deps)` → `failed` with `MISSING_SEAMS`; take the project lock (release it in `finally`); `findUnfinishedRun` → `UNFINISHED` (new runs) or the run to continue (`resumeChange`).
- New runs: project `status` must be `ready` or `shipped` (`NOT_BUILT_YET`); `appCheckoutProblem`; `mainAtStart = appMain(appDir)`; `createChangeRun`.
- `stepBrief`, `stepPrepare`, `stepBuild`, `stepMerge`, `stepRelease`, `stepShip` are private functions that each take `(ctx, run)`, do their row of the table, set `run.stage`, `saveChangeRun`, and return `null` to continue or a `ChangeOutcome` to stop. `drive(ctx, run)` loops over them by stage. Any throw becomes `failed` with `` `Conductor hit a problem during the ${stageWords[run.stage]} and stopped: ${plain message}. You can resume.` `` and the detail stays in `change.json` (`reason`), redacted.
- For an upgrade, `prepareUpgradeMerge`'s `mainAtStart` must equal `run.mainAtStart` (recorded when the run was created), else `stopped` with `MAIN_MOVED`.
- `stageWords = { brief: 'brief step', prepare: 'foundation merge', build: 'build', approved: 'step that adds the change to the app', merged: 'release', released: 'shipping', shipping: 'shipping' }`.
- Build options: `{ ...config.options, ...deps.projectCouncilOptions({ projectDir, brief }) }`; if `options.council !== true` → `stopped` with `COUNCIL_MISSING` before calling Plan 8.
- Gate wiring: `makeChangeGate({ approveResult: (a) => term.approveResult({ ...a, approveLabel }), extraText, check, onApproved })` where:
  - `extraText` gives `deltaText(delta)` (change) or `` `The foundation goes from ${fromTag} to ${toTag}.` `` then `Security fixes this brings in:` and one line per fix, `` `  - ${line} (${version})` `` (upgrade; `makeChangeGate` indents every line by two more spaces); then `` `The app becomes version ${expectedVersion}.` ``, `These lines are added to its changelog:` with the lines, and the deployments sentence (or `NO_DEPLOYMENTS`);
  - `check` returns `null` for a change; for an upgrade it runs `conflictMarkers(arg.workspaceDir, arg.sha, upgrade.conflicts)` (the commit is not in the app until it lands; Task 4 put `workspaceDir` in the gate argument) and returns `MARKERS_LEFT(files)` when any are left, or a refusal if `arg.workspaceDir` is missing (fail closed);
  - `onApproved` adds `expectedVersion`, `changelogLines`, `deployments` (names), saves `approval`, sets `stage = 'approved'`, saves.
  - `expectedVersion = nextVersion(appVersionAt(appDir, mainAtStart), bump)`; `bump` is `minor` for a change and `patch` for an upgrade.
- After `approved`: `findLandedBranch` = `build.branch` if it points at `approval.sha`, else the first of `git for-each-ref --points-at <approval.sha> refs/heads/conductor/` in the app; none and the build is not finished → `deps.resumeBuild`.
- Release adoption on resume: if `run.release` is missing but `appMain !== changelogSha` and `refs/tags/v<expectedVersion>` points at `appMain`, treat `{ version: expectedVersion, sha: appMain }` as the release and run `releaseProblem` on it.
- The final report (`ChangeOutcome.report`): what changed, the council line (`The council approved it.` / `… approved it with warnings.` / `You chose to ship although the council still found problems.`), `` `The app is now version ${version}.` ``, then `shipReport`.
- `abandonChange`: the unfinished run gets `status: 'stopped'`, `reason: 'You dropped this change.'`; the outcome says what is left: before `merged` "Nothing reached the app's main line."; at or after `merged` "The app's main line already has this change; the deployments not yet updated stay on their current version."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-pipeline.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/pipeline.js test/factory-change-pipeline.test.js
git commit -m "feat(change): the change and foundation-upgrade pipelines, resumable at every stage"
```
