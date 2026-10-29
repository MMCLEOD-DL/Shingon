# Task 9: The change pipeline and resume

This task joins Tasks 1–8 into the two commands' library functions and the resume path. The run is a stage machine saved in `change.json` after **every** step. So a crash or Ctrl-C at any point resumes without asking the gate again once the approval is saved, without a second release, and without updating a box twice (Review Focus 3).

```
change:   brief ─┐
                 ├─▶ build ─▶ approved ─▶ merged ─▶ released ─▶ shipping ─▶ done
upgrade:  prepare┘   (Plan 8 runBuild change mode + Plan 9 council + change gate)
```

| Stage | Work (in order) | Saved before moving on | Stops as |
|---|---|---|---|
| `brief` | `from = project.builtFromBrief`; `deps.reviseBrief` (notes file on the first try, `null` on resume); `briefDelta(loadBriefVersion(from), loadBriefVersion(to))`; `deltaProblem`; `buildUnits`; `profile = profileChanged ? appProfileOf(next) : null` | `brief: { from, to }`, `delta`, `units`, `profile` | brief not approved → `stopped`; paused/failed → same status, resumable |
| `prepare` | `releaseTags`, `upgradeTargetProblem`, `readChangelogAt` + `changesBetween` + `securityFixesSince` (versions passed without the leading `v`: Plan 10's `parseVersion` is strict semver), `prepareUpgradeMerge`; > 20 conflicts asks | `upgrade`, `baseRef = upgrade.branch`, `units = [upgradeUnit]` | refusal → `stopped` |
| `build` | `deps.runBuild` with `options.change = { runId, baseRef, units, profile }`, `hooks.council = (a) => deps.runProjectCouncil(a, { options })` (Plan 9's `runProjectCouncil(args, { options, deps })`, as Plan 9 Task 13 wires it for `conductor build`), `hooks.approveBuild` = the change gate (calling it again on resume carries on Plan 8's `build.json`) | the gate saves `approval` and `build: { branch, sha }` and moves the stage to `approved`; then `build.status` from the outcome | `rejected` with `run.refusal` → `stopped` with the refusal; `rejected` otherwise → `rejected`; paused/failed/stopped → same status, resumable |
| `approved` | `refs/heads/<build.branch>` must equal `approval.sha`; `commitChangelog`; `advanceMain(mainAtStart → changelogSha)`; `saveProject` | `changelogSha`; then `project.json`: `approved = { sha: changelogSha, at, runId, briefVersion }`, plus `builtFromBrief = brief.to` (change) or `foundation = { repo, tag: toTag, commit: tagSha }` (upgrade) | `MAIN_MOVED`, `NOT_APPROVED_COMMIT` → `stopped` |
| `merged` | `deps.releaseApp({ projectDir, bump, runId })` unless the release already exists (adoption); `releaseProblem` | `release: { version, sha, tag }` | release failed → `failed` (resumable); release check fails → `stopped` |
| `released` / `shipping` | `shipUpdate` | `deployments[name]` after each box | a box did not update → run `paused` at `shipping` (resume asks before retrying); outcome `stopped` |
| `done` | write the final report | `status: 'done'` | — |

**Files:**
- Create: `src/factory/change/pipeline.js`
- Test: `test/factory-change-pipeline.test.js`

**Interfaces:**
- Consumes:
  - everything in Tasks 1–8 (index Shared Interfaces);
  - Plan 7's `projectDir`, `readProject`, `loadProject` and `saveProject` (not `lockProject`: the CLI handler holds the lock, Contract 7 §7.11);
  - Plan 8's `appProfileOf` (Task 4);
  - Plan 10's `securityFixesSince`;
  - `fakeParticipant`, `approve` (`test/helpers/fakes.js`).
- Produces:
  - `runChange`, `runFoundationUpgrade`, `resumeChange`, `abandonChange` (index);
  - `askOperator(term, { title, message }) -> Promise<boolean>`: builds `{ kind: 'change', title, message, options: ['approve', 'reject'] }`, calls `term.escalate`, and returns `true` only for exactly `'approve'` (`false` on anything else or a throw);
  - the `approveBuild` argument passed on to `term.approveBuild` also carries `approveLabel: \`approve → add to the app and update ${n} deployment${n === 1 ? '' : 's'}\`` (Task 11 shows it);
  - texts:
    - `NOT_BUILT_YET = 'This project has not been built and approved yet, so there is nothing to change. Build it first with "conductor build <slug>".'`
    - `NO_BUILT_FROM = 'This project does not record which brief version the app was built from, so Conductor cannot tell what a change would add. Nothing was changed.'`
    - `UNFINISHED(runId, kind)` = `` `An earlier ${kind === 'change' ? 'change' : 'foundation upgrade'} (${runId}) is not finished. Continue it with --resume, or drop it with --abandon, before starting another.` ``
    - `NOTHING_TO_RESUME = 'There is no unfinished change for this project.'`
    - `TOO_MANY_CONFLICTS(n, files)` question: title `the foundation upgrade`, message `` `Merging the foundation release left ${n} files with both versions side by side (${first 10 files}${n > 10 ? ', …' : ''}). Conductor can try to resolve them, which uses your subscription, or you can stop and merge by hand. Approve to let Conductor try.` ``
    - `MISSING_SEAMS(names)` = `` `This Conductor is missing parts it needs for changes (${names.join(', ')}). Update Conductor; nothing was changed.` ``

- [ ] **Step 1: Write the failing tests**

Fixtures from Task 1:
- a foundation with `v0.1.0` and `v0.1.1`;
- a project on `v0.1.0`, `status: 'shipped'`, `builtFromBrief: 1`, whose app has made one release of its own (`0.2.0`, as in Task 6's fixture);
- two deployments, `acme-cloud` and `acme-office`, both on `0.2.0`.

Stubs:
- `reviseBrief` writes brief v2 (Task 3's example `next`, via `writeBriefVersion`) and returns `{ status: 'approved', version: 2 }`.
- `runBuild` simulates Plan 8's change mode:
  - it checks out `build/<change.runId>` in the app from `refs/heads/<change.baseRef>` and commits the change;
  - it writes `builds/<runId>/council-report.json` (configurable verdict);
  - it calls `hooks.approveBuild({ summary: 'S', sha, branch, runId, council: { status, text, sha, overridden }, checks: { sha } })` with a configurable council;
  - it checks the app back out to `main` and returns `{ status: 'approved', runId, buildDir, sha, branch }` when the answer is `true`, or `{ status: 'rejected', reason }` otherwise.
- `releaseApp` makes a release commit on the app's `main` (version fields, changelog `Unreleased` moved under the new version) and tags it, returning `{ ok: true, version, sha, tag }`.
- `updateDeployment` records calls and returns `updated`.
- `term` records `say` lines, answers `approveBuild` with `true`, and answers `escalate` with `'reject'` unless set.

```js
test('change: brief → build → council passed → gate → main → release → both deployments updated', async () => {
  const out = await runChange({ factory, slug: 'acme', notesFile, team, author, term, options: {}, baseDir, deps });
  assert.equal(out.status, 'done');
  const run = loadChangeRun(projectDir, out.runId);
  assert.match(out.runId, RUN_ID_RE);
  assert.equal(run.kind, 'change');
  assert.equal(run.stage, 'done');
  assert.deepEqual(run.brief, { from: 1, to: 2 });
  const build = deps.calls.find((c) => c.name === 'runBuild').arg;
  assert.deepEqual(build.options.change.units.map((u) => u.id), ['change-monthly-report', 'mileage-claims', 'remove-paper-upload']);
  assert.equal(build.options.change.baseRef, 'main');
  assert.equal(build.options.change.runId, out.runId);
  assert.equal(build.hooks.council, deps.runProjectCouncil);
  assert.equal(deps.calls.find((c) => c.name === 'releaseApp').arg.bump, 'minor');
  assert.equal(await appMain(appDir), run.release.sha);
  assert.match(readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'), /- Change \(brief v2\): added Mileage claims/);
  const project = JSON.parse(readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  assert.equal(project.builtFromBrief, 2);
  assert.deepEqual(project.approved, { sha: run.changelogSha, at: run.approval.at, runId: out.runId, briefVersion: 2 });
  assert.deepEqual(deps.calls.filter((c) => c.name === 'updateDeployment').map((c) => [c.arg.name, c.arg.version]), [['acme-cloud', '0.3.0'], ['acme-office', '0.3.0']]);
  const gate = term.calls.find((c) => c.name === 'approveBuild').arg;
  assert.match(gate.summary, /If you approve:\n {2}Added: Mileage claims\./);
  assert.match(gate.summary, /The app becomes version 0\.3\.0\./);
  assert.match(gate.summary, /These deployments are then updated one at a time, each with a backup first and an automatic undo if it fails: acme-cloud \(0\.2\.0\), acme-office \(0\.2\.0\)\./);
  assert.equal(gate.approveLabel, 'approve → add to the app and update 2 deployments');
  assert.match(out.report, /acme-office: updated to 0\.3\.0/);
});

test('a policy or modules change passes the new app profile to the build; a features-only change passes null', ...)
  // next with outbound ['azure-document-intelligence'] → options.change.profile deepEqual appProfileOf(next)
test('a blocked council that the operator did not override never reaches the operator or the app', async () => {
  // runBuild passes council { status: 'blocked' } → term.approveBuild never called; out.status 'stopped'; out.reason === COUNCIL_NOT_PASSED
  // app main unchanged; releaseApp and updateDeployment never called; project.json builtFromBrief still 1 and approved unchanged
});
test('no council report on disk: refused at the gate as COUNCIL_MISSING', ...)
test('an overridden council ships, and the report says the operator chose to', ...)
test('the operator rejects at the gate: nothing reaches main, the new brief version is kept, builtFromBrief stays', ...)
  // out.status 'rejected'; out.reason /You did not approve the change\. The new brief \(v2\) is kept; the app is still built from brief v1\./
test('the operator does not approve the revised brief: stopped before any build', ...)
test('a delta that is not a change (hosting moved) is refused before the build', ...)   // HOSTING_CHANGED, no runBuild call
test('a project that has not been built yet, or has no builtFromBrief, is refused', ...)  // status 'building' → NOT_BUILT_YET; builtFromBrief null → NO_BUILT_FROM
test('main moved while the change was being built: nothing is released or shipped, and the report says where the work is', ...)
  // runBuild commits to app main before returning → out.status 'stopped', reason MAIN_MOVED, mentions build/<runId>; no releaseApp call; project.json unchanged

test('crash after the gate approved but before main moved: resume finishes without asking again or building again', async () => {
  // run stage 'approved' with approval and build.branch saved → resumeChange
  // term.approveBuild not called; runBuild not called; main advanced; release made once
});
test('crash after main moved but before project.json was written: resume writes it and carries on', ...)
  // changelogSha saved, main === changelogSha, project.json still old → approved and builtFromBrief written; advanceMain treats main === to as done
test('crash after the release: resume does not release again', ...)               // run.release set → releaseApp not called
test('a release that already happened but was not saved is adopted, not repeated', ...)
  // run.stage 'merged', no run.release, but app main has a release commit tagged v<expectedVersion> → adopted after releaseProblem; releaseApp not called
test('a deployment rolled back: the run pauses at shipping; resume asks; "no" leaves it; "yes" retries it and carries on', ...)
test('a paused build: resume calls runBuild again with the same change.runId', ...)
test('one unfinished change at a time: a new change is refused while one is paused; --abandon clears it', ...)
  // runChange while a paused run exists → UNFINISHED(runId, 'change'); abandonChange → status 'stopped'; runChange then starts
test('runChange never takes the project lock: it runs under the lock its caller holds (Contract 7 §7.11)', ...)
  // lockProject(projectDir, 'change') held by the test (as Task 11's handler does) → runChange still reaches the brief step; no busy text
test('a missing dep is refused before anything starts', ...)                      // MISSING_SEAMS(['releaseApp'])

test('foundation upgrade with no code conflicts: merged, built from the upgrade branch, patch release, shipped with the new foundation tag', async () => {
  const out = await runFoundationUpgrade({ factory, slug: 'acme', toTag: 'v0.1.1', team, author, term, options: {}, baseDir, deps });
  assert.equal(out.status, 'done');
  const build = deps.calls.find((c) => c.name === 'runBuild').arg;
  assert.match(build.options.change.baseRef, /^factory\/upgrade-v0\.1\.1-\d{8}-\d{6}-[0-9a-f]{4}$/);
  assert.deepEqual(build.options.change.units.map((u) => u.change), ['foundation-upgrade']);
  assert.equal(build.options.change.profile, null);
  assert.equal(deps.calls.find((c) => c.name === 'releaseApp').arg.bump, 'patch');
  assert.ok(deps.calls.filter((c) => c.name === 'updateDeployment').every((c) => c.arg.foundation === 'v0.1.1'));
  const project = JSON.parse(readFileSync(path.join(projectDir, 'project.json'), 'utf8'));
  assert.deepEqual(project.foundation, { repo: f.dir, tag: 'v0.1.1', commit: f.tagSha('v0.1.1') });
  assert.equal(project.builtFromBrief, 1);
  assert.match(readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'), /\*\*\[security\]\*\* Sessions now expire after 12 hours\. \(foundation 0\.1\.1\)/);
  const gate = term.calls.find((c) => c.name === 'approveBuild').arg;
  assert.match(gate.summary, /Security fixes this brings in:\n {4}- Sessions now expire after 12 hours\. \(0\.1\.1\)/);
});
test('foundation upgrade whose conflicts were not resolved is refused at the gate (markers left)', ...)
  // runBuild leaves the merge commit unchanged (markers still there) → gate refuses: MARKERS_LEFT([...]); not asked; nothing released
test('foundation upgrade with more than 20 conflicted files asks first; no terminal answer means stop, nothing spent', ...)
test('foundation upgrade to the tag the project is already on is refused before anything is changed', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-pipeline.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/pipeline.js`**

- **Every entry point:**
  - `missingSeams(deps)` → `failed` with `MISSING_SEAMS`;
  - `readProject(factory.projectsRoot, slug)` (Plan 7's plain "no such project" error becomes a `stopped` outcome);
  - no lock: the `change`/`foundation-upgrade` handler (Task 11) holds `lockProject(projectDir, 'change')` around the whole call (Contract 7 §7.11), so `runChange`, `runFoundationUpgrade`, `resumeChange` and `abandonChange` never take it, and nothing they call (`reviseBrief`, `runBuild`) does either;
  - `findUnfinishedRun` → `UNFINISHED` (new runs), or the run to continue (`resumeChange`; none → `NOTHING_TO_RESUME`).
- **New runs:**
  - project `status` must be `ready` or `shipped` and `approved` set (`NOT_BUILT_YET`);
  - a change also needs `builtFromBrief` (`NO_BUILT_FROM`);
  - then `appCheckoutProblem`, `mainAtStart = appMain(appDir)` and `createChangeRun` (run id from Plan 8's `newRunId`).
- **Stage steps:** `stepBrief`, `stepPrepare`, `stepBuild`, `stepMerge`, `stepRelease` and `stepShip` are private functions. Each takes `(ctx, run)`, does its row of the table, sets `run.stage`, calls `saveChangeRun`, and returns `null` to continue or a `ChangeOutcome` to stop. `drive(ctx, run)` loops over them by stage.
- **Failures:** any throw becomes `failed` with `` `Conductor hit a problem during the ${stageWords[run.stage]} and stopped: ${plain message}. You can resume.` ``. The detail stays in `change.json` (`reason`), redacted. `stageWords = { brief: 'brief step', prepare: 'foundation merge', build: 'build', approved: 'step that adds the change to the app', merged: 'release', released: 'shipping', shipping: 'shipping' }`.
- **Brief step:** `deps.reviseBrief({ projectDir, slug, notesFile: run.notesFile on the first try, else null, author: ctx.author, io: term.briefIo, log, operatorName: factory.operatorName, cwd })`.
- **Prepare step (upgrade):**
  - foundation repo = `project.foundation.repo`; `null` → `NOT_BUILT_YET`;
  - `prepareUpgradeMerge`'s `mainAtStart` must equal `run.mainAtStart`, else `stopped` with `MAIN_MOVED`;
  - `scratchDir = builds/<runId>/merge`.
- **Build step:**
  ```js
  deps.runBuild({ factory, slug, team, baseDir, warnings, env,
    hooks: { escalate: term.escalate, onEvent: term.onEvent, onProgress: term.say, council: (a) => deps.runProjectCouncil(a, { options }), approveBuild: gate },
    options: { ...options, change: { runId: run.runId, baseRef: run.baseRef, units: run.units, profile: run.profile ?? null } } })
  ```
  The outcome maps as follows:
  - `approved`, with `outcome.sha === run.approval.sha`, → stage `approved`;
  - `approved` with a different sha → `stopped` with `NOT_APPROVED_COMMIT`;
  - `rejected` with `run.refusal` → `stopped` with the refusal; `rejected` otherwise → `rejected`;
  - the rest → the same status.
- **Gate wiring:** `gate = makeChangeGate({ projectDir, approveBuild: (a) => term.approveBuild({ ...a, approveLabel }), extraText, check, onApproved, onRefused })`, where:
  - `extraText` gives `deltaText(delta)` for a change. For an upgrade it gives `` `The foundation goes from ${fromTag} to ${toTag}.` ``, then `Security fixes this brings in:` and one line per fix, `` `  - ${line} (${version})` `` (`makeChangeGate` indents every line by two more spaces). Both then add `` `The app becomes version ${expectedVersion}.` ``, `These lines are added to its changelog:` with the lines, and the deployments sentence (or `NO_DEPLOYMENTS`).
  - `check` returns `null` for a change. For an upgrade it runs `conflictMarkers(appDir, arg.sha, upgrade.conflicts)` (the build branch lives in the app) and returns `MARKERS_LEFT(files)` when any are left.
  - `onApproved` adds `expectedVersion`, `changelogLines` and `deployments` (names), saves `approval` and `build: { branch, sha }`, sets `stage = 'approved'`, and saves.
  - `onRefused` saves `run.refusal`.
  - `expectedVersion = nextVersion(appVersionAt(appDir, mainAtStart), bump)`; `bump` is `minor` for a change and `patch` for an upgrade.
- **Approved step:**
  - check `refs/heads/<approval.branch>` equals `approval.sha` (else `NOT_APPROVED_COMMIT`), unless `changelogSha` is already saved;
  - `commitChangelog({ appDir, sha: approval.sha, lines: approval.changelogLines, scratchDir: builds/<runId>/changelog, message })`;
  - `advanceMain`. On `MAIN_MOVED`, the outcome reason adds `` ` The approved work is on the branch ${approval.branch}.` ``;
  - then `saveProject` with `approved` and `builtFromBrief`/`foundation` (idempotent: it writes the same values again on resume).
- **Release adoption on resume:** if `run.release` is missing but `appMain !== changelogSha` and `refs/tags/v<expectedVersion>` points at `appMain`, treat `{ version: expectedVersion, sha: appMain, tag: 'v' + expectedVersion }` as the release and run `releaseProblem` on it.
- **Ship step:** `shipUpdate({ projectDir, projectsRoot: factory.projectsRoot, slug, run, version: release.version, foundation: project.foundation.tag, deps, factory, say: term.say, state: ctx.shipState, ask: (q) => askOperator(term, { title: 'retry a deployment', message: q }), save: (r) => saveChangeRun(projectDir, r) })`. `ctx.shipState` is the object the CLI handler made (Task 11); Plan 10's `updateDeployment` keeps it current, so a Ctrl-C mid-update can call Plan 10's `interruptShip(shipState)` (Contract 7 §7.11).
- **The final report** (`ChangeOutcome.report`):
  - what changed;
  - the council line: `The council approved it.`, `The council approved it with warnings.` or `You chose to ship although the council still found problems.`;
  - `` `The app is now version ${version}.` ``;
  - then `shipReport`.
- **`abandonChange`:** the unfinished run gets `status: 'stopped'`, `reason: 'You dropped this change.'`. The outcome says what is left: before `merged`, "Nothing reached the app's main line."; at or after `merged`, "The app's main line already has this change; the deployments not yet updated stay on their current version." Its caller (Task 11's handler) holds the project lock.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-pipeline.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/pipeline.js test/factory-change-pipeline.test.js
git commit -m "feat(change): the change and foundation-upgrade pipelines, resumable at every stage

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
