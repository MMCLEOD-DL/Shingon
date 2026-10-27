# Task 4: Plan 8's `runBuild` in change mode

Contract 7.7 makes Plan 8's `runBuild({ factory, slug, team, hooks, options })` the single build entry point. Plan 11 owns one addition to it: **`options.change = { runId, baseRef, units, profile }`**. With it, `runBuild` builds a change on an app that already exists and is live.

(This file kept its old name, `task-04-core-baseref.md`, so links stay stable. The draft's core edits, `baseRef` in `Workspace.create` and `sha` in the core gate argument, are dropped. Plan 8 checks out `build/<runId>` in the app folder itself, so a base branch for that checkout is enough. No core file is edited.)

**What change mode does, against Plan 8's normal path:**

| Normal build (Plan 8) | Change mode (`options.change` set) |
|---|---|
| refuses `ready`/`shipped` projects | refuses anything **but** `ready`/`shipped` (`NOT_LIVE_YET`); the `ready`/`shipped` refusal is lifted only here |
| takes **no** lock: the `build`/`resume` handler holds `lockProject(projectDir, 'build')` (Contract 7 §7.11) | takes **no** lock either: Plan 11's `change`/`foundation-upgrade` handler holds `lockProject(projectDir, 'change')`, the project's one lock |
| finds or creates the build from `latestBuild` | loads or creates `builds/<change.runId>/build.json` with `kind: 'change'` (resume = call again with the same `runId`) |
| `createApp`, records `project.json.foundation`, sets `status: 'building'`, `nameApp` | none of these; `project.json` is never written in change mode |
| baseline `runAppChecks` on `main` | the same |
| checks out `build/<runId>` from `main` | checks out `build/<runId>` from `refs/heads/<change.baseRef>` |
| — | if `change.profile` differs from `app-profile.json` at that commit: write it with `appProfileOf`'s format (`JSON.stringify(profile, null, 2) + '\n'`, as Plan 8's `nameApp` writes it) and commit only that file on the build branch, message `Update the app profile from the brief` |
| `runSplit` | skipped: `build.units = change.units`, features from them, phase `features` |
| features, final checks, council, fix rounds, escalations | the same. Each feature's `factoryFeature` also carries the unit's `retire` ids |
| gate `true`: `main` moves to the build tip, `status: 'ready'` | gate `true`: `main` **not** moved, `project.json` **not** touched; the app folder is checked back out to `main` (clean); `build.status = 'approved'`, `phase = 'done'`; return `{ status: 'approved', runId, buildDir, sha, branch }` |
| — | called again on an `approved` change build: return the same outcome without asking (resume after a crash) |

**Also, in both modes:**
- `hooks.approveBuild` is called with `{ summary, sha, branch, runId, council: build.council, checks: build.checks }`. The build command's terminal gate reads only `summary`, so its behaviour is unchanged.
- `build.council` saves the hook result with the `sha` it reviewed (Plan 8 already does) and `overridden: true` when the operator approved past a blocked council.
- `latestBuild(projectDir)` ignores builds with `kind: 'change'`, so `conductor build` and `conductor resume` never pick up a change run. Plan 11's `--resume` continues those.
- `appProfileOf(brief) -> { schema: 1, modules, policy: { outbound, residency } }` is already exported from Plan 8's `src/factory/app.js` (used by `nameApp`, Contract 7 §7.11). Plan 11 imports it; nothing to move.
- The Foundation rules member (`src/council/foundationRules.js`) accepts the **removal or change** of a test whose title carries one of `factoryFeature.retire`'s tags. Dropping any other tag still blocks with its locked finding, as today.

**Files:**
- Modify: `src/factory/build.js`, `src/factory/buildFinal.js`, `src/factory/buildState.js`, `src/council/foundationRules.js` (Plan 8's)
- Test: `test/factory-build-change.test.js` (new; uses Plan 8's `test/helpers/buildHarness.js`), `test/council-foundation-rules.test.js` (append one; use Plan 8's file name for that member's tests)

**Interfaces:**
- Consumes: Plan 8's `runBuild`, `runFinal`, `newBuild`, `latestBuild`, `loadBuild`, `saveBuild`, `buildDirOf`, `runAppChecks`, `featureRequest`, `appProfileOf`, `RUN_ID_RE`, `MAX_INSTRUCTIONS`; `acceptanceIds` (Plan 7); `git` from `src/workspace.js`.
- Produces: the index's Task 4 block, and these texts:
  - `NOT_LIVE_YET = 'This project has not been built and approved yet, so there is nothing to change. Build it first with "conductor build <slug>".'`
  - `` BASE_REF_MISSING(baseRef) = `There is no branch called ${baseRef} in the app, so the change build did not start.` ``
  - `` BAD_CHANGE_UNITS(problems) = `The change could not be turned into build steps: ${problems.join(' ')} Nothing was built.` ``

- [ ] **Step 1: Write the failing tests**

`test/factory-build-change.test.js` uses Plan 8's harness. `setup()` gives a built project. The test marks it `ready` with `approved` set, and stubs `runAppChecks`, the council hook and `runTask`, as Plan 8's own tests do.

```js
const change = (over = {}) => ({ runId: '20261027-143205-a1b2', baseRef: 'main', units: [UNIT_ADDED], profile: null, ...over });

test('without options.change, a ready or shipped project is still refused', ...)
  // Plan 8's existing refusal text, unchanged
test('change mode refuses a project that is not ready or shipped', ...)        // status 'building' → NOT_LIVE_YET
test('change mode: no createApp, no split, no project.json write; the build branch starts from baseRef', async () => {
  const before = readFileSync(projectJson, 'utf8');
  const out = await runBuild({ …, options: { change: change({ baseRef: 'side' }) } });
  assert.equal(out.status, 'approved');
  assert.equal(readFileSync(projectJson, 'utf8'), before);
  assert.equal(s.calls.filter((c) => c.name === 'createApp' || c.name === 'runSplit').length, 0);
  const build = loadBuild(buildDirOf(projectDir, '20261027-143205-a1b2'));
  assert.equal(build.kind, 'change');
  assert.equal((await git(appDir, ['rev-parse', `${build.branch}~1`])).stdout.trim(), sideSha, 'the build branch starts from baseRef');
});
test('change mode never moves main; the gate is told the sha, branch, council and checks; the app is back on main', async () => {
  const mainBefore = await rev(appDir, 'main');
  let seen;
  const out = await runBuild({ …, hooks: { …, approveBuild: async (a) => { seen = a; return true; } }, options: { change: change() } });
  assert.equal(await rev(appDir, 'main'), mainBefore);
  assert.equal(seen.sha, out.sha);
  assert.equal(seen.branch, 'build/20261027-143205-a1b2');
  assert.equal(seen.council.sha, out.sha);
  assert.equal(seen.checks.sha, out.sha);
  assert.equal((await git(appDir, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim(), 'main');
});
test('a blocked council the operator approves past is saved as overridden and passed to the gate', ...)
test('the operator\'s feedback note still becomes a fix unit in change mode; false is rejected with main unchanged', ...)
test('calling runBuild again on an approved change build returns the same outcome without asking', ...)
test('a profile that differs from app-profile.json is committed on the build branch before any feature; an equal one is not', ...)
  // first commit after baseRef changes only app-profile.json; its content equals JSON of change.profile
test('runBuild takes no project lock in change mode either (Contract 7 §7.11)', ...)
  // with lockProject(projectDir, 'change') held by the test, as Plan 11's handler does: change mode runs to the gate; no busy text
test('a missing baseRef, an option-like baseRef or a bad run id is refused before anything is created', ...)
  // 'nope' → BASE_REF_MISSING('nope'); '-x', 'main~1' → BASE_REF_MISSING; runId 'x' → plain refusal; builds/ unchanged
test('units with unknown acceptance ids, duplicate ids or over-long instructions are refused', ...)   // BAD_CHANGE_UNITS
test('latestBuild ignores change builds, so conductor build does not pick one up', ...)
test('each feature run is told the unit\'s retired tags', ...)
  // runTask stub sees options.factoryFeature.retire deepEqual UNIT_CHANGED.retire
```

Append to the Foundation rules member's tests:

```js
test('removing a test tagged with a retired id is allowed; removing any other tagged test still blocks', ...)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-build-change.test.js`
Expected: the new tests FAIL; Plan 8's tests still pass.

- [ ] **Step 3: Implement**

- **`runBuild`** (`build.js`), when `options.change` is set:
  - Validate before anything is created: `runId` matches `RUN_ID_RE`; `baseRef` passes `git check-ref-format refs/heads/<baseRef>`, does not start with `-`, contains none of `~^:@{`, and `refs/heads/<baseRef>` exists in the app (`BASE_REF_MISSING`).
  - Validate `units`: non-empty, unique ids, every `acceptance` id in `acceptanceIds(brief)`, every `instructions` at most `MAX_INSTRUCTIONS`, and `featureRequest` within its budget for each index. Problems go to `BAD_CHANGE_UNITS`.
  - Project status must be `ready` or `shipped` (`NOT_LIVE_YET`). (No lock is taken in either mode; Plan 8's `runBuild` never takes one.)
  - Load `builds/<runId>/build.json` or create it with `newBuild({ …, kind: 'change' })`, `units`, and features from the units. `briefHash` is checked on resume as Plan 8 does.
  - Setup: the baseline checks as today, then `git checkout -q -b build/<runId> refs/heads/<baseRef>` in the app, then the profile commit when `change.profile` is set and differs (compare canonical JSON with the file at that commit). Then `build.baseSha` and `phase: 'features'`.
  - Each feature's `factoryFeature` gains `retire: unit.retire ?? []`.
- **`runFinal`** (`buildFinal.js`):
  - pass `{ summary, sha, branch: build.branch, runId, council: build.council, checks: build.checks }` to `approveBuild` in both modes;
  - set `build.council.overridden = true` on an operator approve past a blocked council (if Plan 8 does not already);
  - in change mode, on exactly `true`: no `update-ref`, no `saveProject`; `git checkout -q main`; `build.status = 'approved'`, `phase = 'done'`; save; return the change outcome;
  - at the top of `runFinal` in change mode, a build already `approved` returns that outcome straight away.
- **`buildState.js`:** `newBuild` takes `kind` (default `'build'`); `latestBuild` skips `kind: 'change'`.
- **`foundationRules.js`:** in the dropped-tag check, a dropped tag in `factoryFeature.retire` is not a finding.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite, Plan 8's tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/factory/build.js src/factory/buildFinal.js src/factory/buildState.js src/council/foundationRules.js test/factory-build-change.test.js test/council-foundation-rules.test.js
git commit -m "feat(factory): runBuild change mode for live apps (no app creation, no split, main left to the change gate)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
