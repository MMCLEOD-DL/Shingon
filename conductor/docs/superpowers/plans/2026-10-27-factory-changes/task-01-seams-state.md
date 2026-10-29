# Task 1: Seams and change-run state

This task lays the ground every other task stands on:
- **`seams.js`** is the only file that imports the `deps` functions from Plans 7–10 (`DEP_NAMES` in the index). It exports:
  - `realDeps()`;
  - `missingSeams(deps)`, so the CLI can refuse plainly if a function is missing;
  - two thin brief helpers Plan 7 does not export under these names (`loadBriefVersion`, `currentBriefVersion`);
  - the `reviseBrief` wrapper over Plan 7's session in `revise` mode.
- **`run.js`** saves and loads the change run (`<project>/builds/<runId>/change.json`, Contract 7.5) and finds the unfinished run. Run ids are Plan 8's `newRunId()`. Atomic writes are Plan 7's `writeJsonAtomic` and `createFileExclusive`. The project lock is Plan 7's `lockProject(projectDir, 'change')`; Plan 11 builds no lock of its own.
- **`test/helpers/changeFixtures.js`** builds what every later test needs: a temporary projects root, a foundation repo with release tags, a project whose `app/` was cloned from it, and stub `deps`.

**Step 0 (before writing code): check the Contract 7 names exist as merged.** Read the merged Plans 7–10 under `src/factory/` and `src/council/`.
- Confirm each import in the index's "Imported directly" block and each `DEP_NAMES` entry by exact name: `fsAtomic.js`, `projects.js`, `projectLock.js`, `brief.js`, `briefSession.js` (`importNotes`, `newSession`, `loadSession`, `saveSession`), `briefRun.js` (`runBriefSession`), `acceptance.js`, `ids.js`, `split.js`, `build.js` (`runBuild`), `council/projectCouncil.js` (`runProjectCouncil`), `ship/release.js` (`releaseApp`), Plan 10's `updateDeployment`, `deployments/store.js` (`listDeployments`), and `foundationLog.js`.
- Confirm that `runBriefSession` does **not** take `lockProject` itself. If it does, stop and raise it with the operator: Plan 11 holds the project's one lock for the whole change run, so a nested lock would always report "busy".
- If a name is missing or has a different signature, stop and raise it with the operator. Do not build it inside Plan 11.
- Record the mapping as a comment at the top of `seams.js` (the index's "Contract 7 mapping" table).

**Files:**
- Create: `src/factory/change/seams.js`, `src/factory/change/run.js`, `test/helpers/changeFixtures.js`
- Test: `test/factory-change-run.test.js`

**Interfaces:**
- Consumes:
  - Plan 7: `writeJsonAtomic`, `createFileExclusive`, `briefPaths`, `currentBriefInfo`, `validateBrief`, `importNotes`, `newSession`, `loadSession`, `saveSession`, `runBriefSession`;
  - Plan 8: `newRunId`, `RUN_ID_RE`, `runBuild`;
  - Plan 9: `runProjectCouncil`;
  - Plan 10: `releaseApp`, `updateDeployment`, `listDeployments`;
  - `makeRepo` (`test/helpers/gitRepo.js`).
- Produces: everything listed under Task 1 in the index's Shared Interfaces, plus:
  - `RUN_UNREADABLE = (runId) => \`The record of change ${runId} could not be read, so Conductor stopped rather than guess where it was. Nothing was changed.\``;
  - `NO_BRIEF_VERSION = (n) => \`Brief version ${n} could not be read, so Conductor cannot tell what the app was built from. Nothing was changed.\``;
  - `NO_APPROVED_BRIEF = 'This project has no approved brief, so there is nothing to change. Approve a brief first with "conductor brief <slug>".'`;
  - fixtures: `makeFoundation({ versions })`, `makeProject({ foundation, tag, status, deployments, builtFromBrief })`, `stubDeps(over)`, `writeBriefVersion(projectDir, n, brief)`.

- [ ] **Step 1: Write the fixtures**

`test/helpers/changeFixtures.js`:
- **`makeFoundation({ versions = ['0.1.0', '0.1.1'] })`:** a git repo (use `makeRepo`, then commits) with `foundation.json`, `package.json` (`name: 'highland-foundation'`), `package-lock.json` and `CHANGELOG.md`.
  - For each version, a commit that sets the three version fields and adds a dated changelog section, tagged `v<version>` (annotated).
  - `0.1.1`'s section holds `- **[security]** Sessions now expire after 12 hours.` and `- Tidier audit page.`.
  - Returns `{ dir, tagSha(tag) }`.
- **`makeProject({ foundation, tag = 'v0.1.0', status = 'shipped', deployments = [], builtFromBrief = 1 })`:** a projects root in `tmpdir()` holding:
  - `acme/project.json` in the Contract 7.5 shape: `{ schema: 1, slug: 'acme', client: 'Acme Ltd', createdAt, status, foundation: { repo: foundation.dir, tag, commit: foundation.tagSha(tag) }, approved: { sha: <app main>, at, runId: '20261020-090000-0a0b', briefVersion: builtFromBrief }, builtFromBrief }`;
  - `brief/` with `brief-v1.json` (via `writeBriefVersion`) and Plan 7's `current.json` pointing at it;
  - `notes/` and `builds/`;
  - `deployments/<name>.json` per deployment, in Plan 10's `Deployment` shape (`setup.step: 'done'`, `currentVersion`, `foundation`);
  - `app/`, cloned from the foundation at `tag` with `main` checked out, the remote renamed `foundation` (as in `docs/BUILDING-ON.md`), and an `app-profile.json` committed. Like Plan 8's `createApp` (Contract 7 §7.11), the fixture deletes the tags the clone inherited, sets `remote.foundation.tagOpt` to `--no-tags`, and keeps the release as `refs/foundation/<tag>`, so every `v*` tag in the app is an app release. (Plan 10 makes a real app's first release `1.0.0`; the tests' app versions such as `0.2.0` are arbitrary, which is safe because an app repo never holds foundation tags.)
  - Returns `{ projectsRoot, projectDir, appDir, factory }`, where `factory` is a `FactoryConfig`-shaped object with `projectsRoot` and `foundation: { repo: foundation.dir, tag }`.
- **`writeBriefVersion(projectDir, n, brief)`:** writes the brief (with `version: n` and example ids) to `briefPaths(projectDir).json(n)` with `writeJsonAtomic`, then points `briefPaths(projectDir).current` at it in the same format Plan 7's `saveApprovedBrief` writes. (`saveApprovedBrief` picks its own version number, so tests that need a given `n` write directly.) The helper asserts `currentBriefInfo(projectDir).version === n` before returning, so a format mismatch fails loudly.
- **`stubDeps(over = {})`:** every `DEP_NAMES` entry as a recording stub, plus `calls: []` and `now: () => new Date('2026-10-27T14:32:05Z')`. Defaults:
  - `listDeployments` reads the real `deployments/*.json` and returns Plan 10's entry shape;
  - `reviseBrief`, `runBuild`, `releaseApp` and `updateDeployment` return failures (`{ status: 'failed', reason: 'stub' }` / `{ ok: false, reason: 'stub' }` / `{ outcome: 'stub', message: 'stub' }`) unless overridden.

- [ ] **Step 2: Write the failing tests**

`test/factory-change-run.test.js`:

```js
test('createChangeRun writes builds/<runId>/change.json and loadChangeRun reads it back', ...)
  // runId matches RUN_ID_RE (Plan 8's newRunId); JSON has schema 1, kind, stage 'brief' (change) or 'prepare' (upgrade), status 'running'
test('createChangeRun never overwrites: a taken run id gets a fresh one', ...)
  // newId stub returns the same id twice, then another → the second run gets the third id; the first change.json is unchanged
test('findUnfinishedRun returns the newest running/paused/failed run and ignores done, stopped and Plan 8 build folders', ...)
  // a builds/<id>/ holding only build.json is skipped
test('loadChangeRun on a damaged change.json throws RUN_UNREADABLE, plain English, no JSON parser text', ...)
  // assert.doesNotMatch(e.message, /Unexpected token|JSON/)
test('findUnfinishedRun on a damaged change.json throws RUN_UNREADABLE (a run we cannot read might be unfinished)', ...)
test('loadBriefVersion reads brief-v<n>.json; a missing or invalid one throws NO_BRIEF_VERSION(n)', ...)
test('currentBriefVersion returns the approved version; none approved → NO_APPROVED_BRIEF; a broken current.json → its plain text', ...)
test('reviseBrief starts a revise session from the current version, or continues a saved one when notesFile is null', async () => {
  // runBriefSession stub via module injection (seams exports makeReviseBrief({ importNotes, newSession, loadSession, saveSession, runBriefSession }))
  // first call: importNotes called with notesFile; newSession called with { mode: 'revise', baseVersion: 1 }
  // second call with notesFile null and a saved revise session: loadSession used, importNotes and newSession not called
  // notesFile null and no saved session → { status: 'stopped', reason: /no unfinished brief revision/ }
});
test('missingSeams names every dep that is not a function', () => {
  assert.deepEqual(missingSeams({ ...stubDeps(), releaseApp: undefined, runBuild: 1 }), ['releaseApp', 'runBuild']);
  assert.deepEqual(missingSeams(stubDeps()), []);
});
test('realDeps provides every dep (Plans 7–10 are merged)', () => {
  assert.deepEqual(missingSeams(realDeps()), []);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/factory-change-run.test.js`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `run.js` and `seams.js`**

`run.js`:
- `createChangeRun(projectDir, fields, { now = new Date(), newId = newRunId } = {})`:
  - requires `kind`, `slug`, `mainAtStart` and `baseRef`;
  - sets `schema: 1`, `runId`, `stage` (`'brief'` for `change`, `'prepare'` for `foundation-upgrade`), `status: 'running'` and the timestamps;
  - `mkdirSync(builds/<runId>)`, then `createFileExclusive(change.json, …)`;
  - on `EEXIST`, takes a new id, at most 5 tries, then throws plain English.
- `loadChangeRun` wraps read/parse errors and a wrong `schema` in `RUN_UNREADABLE(runId)`, and checks `runId` against `RUN_ID_RE` before building any path.
- `saveChangeRun` uses `writeJsonAtomic` and sets `updatedAt`.
- `findUnfinishedRun` reads every `builds/*/change.json`. It skips folders without one (those are Plan 8 builds), keeps `status` in `running|paused|failed`, and returns the newest `createdAt` first. A damaged `change.json` throws `RUN_UNREADABLE`.

`seams.js`:
- `loadBriefVersion(projectDir, n)`: read `briefPaths(projectDir).json(n)`, `JSON.parse`, then `validateBrief(obj, { stage: 'approved' })`. Any failure throws `NO_BRIEF_VERSION(n)`.
- `currentBriefVersion(projectDir)`: `currentBriefInfo(projectDir)`. `null` throws `NO_APPROVED_BRIEF`; `{ broken }` throws `broken`; otherwise return `version`.
- `makeReviseBrief({ importNotes, newSession, loadSession, saveSession, runBriefSession })` returns `reviseBrief({ projectDir, slug, notesFile, author, io, log, operatorName, cwd })`:
  1. `saved = loadSession(projectDir, slug)`; a saved session whose `mode` is not `'revise'` → `{ status: 'stopped', reason: 'An unfinished brief draft that is not a revision is waiting for this project. Finish or discard it with "conductor brief <slug>" first.' }`;
  2. with `notesFile`: `importNotes(projectDir, notesFile)`, then `newSession({ slug, mode: 'revise', baseVersion: currentBriefVersion(projectDir), notes: [name] })` and `saveSession(projectDir, session)`, as Plan 7's `brief --revise` handler does (a saved revise session is refused with the same kind of plain sentence, telling the operator to resume instead);
  3. without `notesFile`: use `saved`, or return `{ status: 'stopped', reason: 'There is no unfinished brief revision to continue.' }`;
  4. return `runBriefSession({ projectDir, session, author, io, log, operatorName, cwd })` as it comes.
- `realDeps()` returns `{ reviseBrief: makeReviseBrief({ … Plan 7's functions }), runBuild, runProjectCouncil, releaseApp, updateDeployment, listDeployments, now: () => new Date() }`. `updateDeployment` is Plan 10's function as it is, so callers pass its options (`{ factory, say, state }`) as the second argument (Task 8).
- Also export `DEP_NAMES`, `CONTINUE_OUTCOMES` and `missingSeams` (sorted names).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/factory-change-run.test.js && npm test`
Expected: PASS, and the existing suite stays green.

- [ ] **Step 6: Commit**

```bash
git add src/factory/change/seams.js src/factory/change/run.js test/helpers/changeFixtures.js test/factory-change-run.test.js
git commit -m "feat(change): seams to Plans 7–10 and change-run state

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
