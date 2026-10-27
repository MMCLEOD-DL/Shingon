# Task 1: Seams, change-run state and project lock

This task lays the ground every other task stands on:
- **`seams.js`** is the only file that imports from Plans 7–10. It exports `realDeps()` with the names in the index's `ChangeDeps`, and `missingSeams(deps)` so the CLI can refuse plainly if a name is not there.
- **`run.js`** saves and loads the change run (`<project>/builds/<runId>/change.json`), makes run ids, finds the unfinished run, and holds the project lock.
- **`test/helpers/changeFixtures.js`** builds what every later test needs: a temporary projects root, a foundation repo with release tags, a project whose `app/` was cloned from it, and a stub `deps`.

**Step 0 (before writing code): reconcile the seams with what merged.** Read the merged Plans 7–10 (`src/factory/…`). For each name in `SEAM_NAMES`, find the real export that does that job and map it in `realDeps()` (a thin wrapper is fine when the argument shape differs). If a capability is genuinely missing (for example Plan 8's loop cannot start from a named branch, or Plan 10 has no "update an existing deployment" function), **stop and raise it with the operator**: do not build it inside Plan 11. Write down every mapping as a comment in `seams.js`.

**Files:**
- Create: `src/factory/change/seams.js`, `src/factory/change/run.js`, `test/helpers/changeFixtures.js`
- Test: `test/factory-change-run.test.js`

**Interfaces:**
- Consumes: Plans 7–10's modules (in `seams.js` only); `slugify` is not needed.
- Produces: everything listed under Task 1 in the index's Shared Interfaces, plus:
  - `PROJECT_BUSY({ command, host, pid, lockFile })` returns `` `Another Conductor command (${command}, started on ${host}, process ${pid}) is working on this project. Wait for it to finish. If it crashed, remove ${lockFile} and try again.` ``;
  - `RUN_UNREADABLE = (runId) => \`The record of change ${runId} could not be read, so Conductor stopped rather than guess where it was. Nothing was changed.\``;
  - fixtures: `makeFoundation({ versions })`, `makeProject({ foundation, tag, status, deployments })`, `stubDeps(over)`.

- [ ] **Step 1: Write the fixtures**

`test/helpers/changeFixtures.js`:
- `makeFoundation({ versions = ['0.1.0', '0.1.1'] })`: a git repo (use `makeRepo` then commits) with `foundation.json`, `package.json`, `package-lock.json` and `CHANGELOG.md`; for each version a commit that sets the three version fields and adds a dated changelog section, tagged `v<version>` (annotated). `0.1.1`'s section holds `- **[security]** Sessions now expire after 12 hours.` and `- Tidier audit page.`. Returns `{ dir, tagSha(tag) }`.
- `makeProject({ foundation, tag = 'v0.1.0', status = 'shipped', deployments = [] })`: a projects root in `tmpdir()` with `<slug>/project.json` (`{ schema: 1, slug: 'acme', client: 'Acme Ltd', createdAt, foundation: { repo: foundation.dir, tag }, status, builtFromBrief: 1 }`), `brief/`, `notes/`, `builds/`, `deployments/<name>.json` per deployment (Contract 4 shape), and `app/` cloned from the foundation at `tag` with `main` checked out and the remote renamed `foundation` (as `docs/BUILDING-ON.md`). Returns `{ projectsRoot, projectDir, appDir }`.
- `stubDeps(over = {})`: every `SEAM_NAMES` entry as a recording stub with safe defaults (`loadProject` reads the real `project.json`; `saveProject` writes it atomically; `listDeployments` reads `deployments/*.json`; `releaseApp`/`updateDeployment` return failures unless overridden), plus `calls: []` and `now: () => new Date('2026-10-27T14:32:05Z')`.

- [ ] **Step 2: Write the failing tests**

`test/factory-change-run.test.js`:

```js
test('createChangeRun writes builds/<runId>/change.json atomically and loadChangeRun reads it back', ...)
  // assert file exists, JSON has schema 1, stage 'brief' (change) or 'prepare' (upgrade), status 'running';
  // assert no '*.tmp' file is left in the folder
test('newRunId: change-YYYYMMDD-HHMMSS in UTC, and -2 when that folder already exists', ...)
  // 'change-20261027-143205', then 'change-20261027-143205-2'
test('findUnfinishedRun returns the newest running/paused/failed run and ignores done and stopped', ...)
test('loadChangeRun on a damaged change.json throws RUN_UNREADABLE, plain English, no JSON parser text', ...)
  // assert.doesNotMatch(e.message, /Unexpected token|JSON/)
test('acquireProjectLock: a second acquire throws PROJECT_BUSY; release() lets it be taken again', ...)
test('acquireProjectLock takes over a lock left by a dead process on the same host, and never one from another host', ...)
  // lock file { pid: 999999 (not running), host: os.hostname() } → taken over;
  // { pid: 999999, host: 'other-box' } → PROJECT_BUSY
test('missingSeams names every seam that is not a function', () => {
  assert.deepEqual(missingSeams({ ...stubDeps(), releaseApp: undefined, buildFeatures: 1 }), ['buildFeatures', 'releaseApp']);
  assert.deepEqual(missingSeams(stubDeps()), []);
});
test('realDeps provides every seam (Plans 7–10 are merged)', () => {
  assert.deepEqual(missingSeams(realDeps()), []);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test test/factory-change-run.test.js`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement `run.js` and `seams.js`**

- `writeJsonAtomic(file, obj)`: `mkdirSync(dirname, { recursive: true })`, write `${file}.<random>.tmp` with `openSync`/`writeSync`/`fsyncSync`/`closeSync`, then `renameSync`; on any error remove the temp file and rethrow.
- `newRunId`: kind prefix `change` or `upgrade`, then `YYYYMMDD-HHMMSS` from `now` in UTC; add `-2` … `-9` while `builds/<id>` exists; throw plain-English after `-9`.
- `createChangeRun(projectDir, fields)` requires `kind`, `runId`, `slug`, `mainAtStart`, `baseRef`; sets `schema: 1`, `stage` (`'brief'` for `change`, `'prepare'` for `foundation-upgrade` unless given), `status: 'running'`, timestamps.
- `loadChangeRun` wraps read/parse errors and a wrong `schema` in `RUN_UNREADABLE(runId)`.
- `findUnfinishedRun` reads every `builds/*/change.json` (skipping folders without one — those belong to Plan 8 builds), keeps `status` in `running|paused|failed`, newest `createdAt` first. A damaged `change.json` throws `RUN_UNREADABLE` (fail closed: a run we cannot read might be unfinished).
- `acquireProjectLock`: create `<projectDir>/.conductor-lock` with `openSync(…, 'wx')` holding `{ pid, host, startedAt, command }`. On `EEXIST` read it: same host and `process.kill(pid, 0)` throws `ESRCH` → remove and retry once; otherwise throw `PROJECT_BUSY`. The returned `release()` removes the file only if it still holds this pid.
- `seams.js`: import the merged Plan 7–10 exports, build the object, export `SEAM_NAMES`, `UPDATE_OUTCOMES`, `realDeps`, `missingSeams` (sorted names).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/factory-change-run.test.js && npm test`
Expected: PASS, and the existing suite stays green.

- [ ] **Step 6: Commit**

```bash
git add src/factory/change/seams.js src/factory/change/run.js test/helpers/changeFixtures.js test/factory-change-run.test.js
git commit -m "feat(change): seams to Plans 7–10, change-run state and project lock"
```
