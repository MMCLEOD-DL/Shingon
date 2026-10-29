# Task 6: Evidence stage

`collectEvidence` gathers everything the project members measure, once per round, before any member runs (index Architecture). It is the only code in a round that reads Plan 8's reports, runs gates or touches a machine.

1. **Reuse a saved round.** If `state.council.evidence.sha === head`, return the saved value and emit `council-evidence { stage: 'cached' }` (Review Focus 5).
2. **Reuse Plan 8's checks** (index Ruling 5, Contract 7.7). `project.checks` is Plan 8's `AppChecks` for this same commit, or `null`.
   - `reportFiles(checks)` finds, by base name in `checks.reports`: `vitest.json`, `playwright.json`, `crossing.json` and the folder `screenshots`. This is the only place those names live (index A3, Contract gap 3).
   - `reuseChecks(checks)` reads them with Task 4's parsers. A file that is missing or does not parse counts as missing, never as a pass:
     - `verify`: Plan 8's `checks.verify` Check, set when its status is `failed`, or when it is `passed` and the vitest report was read. `tests` = the vitest cases, or `null`;
     - `browser`: the Playwright cases, or `null`;
     - `crossing`, `screenshotsDir`: as found.
   - When `checks` is set, event `council-evidence { stage: 'reuse', status: 'ok' }`. With `checks: null` there is no `reuse` event.
3. **Own gates, locally, only for what is missing** (Task 4), in `ctx.ws.dir`, with `axe = detectAxe(...)`:
   - `need = { verify: !reused.verify, browser: !reused.browser }`. When both are reused and axe is not `ok`, `runGates` runs nothing and no `gates` events are emitted;
   - `{ problem }` → no own gates; `gatesNote = problem`;
   - otherwise `gatesNote = own.note`.
   - `gates = mergeGates(reused, own)`: own results win where their step ran; `verify` is Plan 8's Check when reused; `source` says, per part, `'build'` (reused), `'council'` (own run) or `null` (neither); `a11y` is always `'council'` when the axe pass ran. `gates` is `null` only when nothing was reused and own gates could not run.
   - **Screenshots.** When the browser gate was reused, Plan 8's `screenshots` folder is copied into `<ws.dir>/reports/screenshots/` (the interpreter's working folder, index Ruling 10) and `gates.screenshots` lists them relative to `ws.dir`. Then all screenshots are copied to `<buildDir>/council/round-<N>/screenshots/` (`shotsDir`), keeping file names.
4. **Smoke, on a machine** (Task 5):
   - no provider → `smokeStatus: 'missing'`, `No test machine is set up (factory.machines in the config), so the reliability test did not run.`;
   - `acquire` throws → `error`, `The test machine could not be started (<message>).` (a `MachineError` with code `busy`, when a preview holds the `static` host, reads the same way with Plan 8's plain message);
   - otherwise: `pushCommit` to `<runDir>/smoke-app`, then `runSmoke`, then always, in `finally`, `cleanSmoke` followed by `machine.release()`, each in its own `try`. A clean-up or release problem is appended to `smokeNote` as `The test machine <id> could not be fully cleaned up (<reason>); the next run cleans it first.`;
   - `SmokeError` from push or run → `smoke = null`, `smokeStatus: 'error'`, `smokeNote` = its message (`timeout` → `The reliability test took longer than the time allowed.`).
5. Save `state.council.evidence = { sha: head, value }` with `log.saveState`.

The provider is `deps.getMachineProvider?.(project.factory, { ssh })`, falling back to a dynamic import of `src/factory/machines/index.js` (index A2). `project.factory` is the hook's `FactoryConfig`. `ssh = deps.createSsh?.() ?? (await import('../factory/ssh.js')).createSsh()`. If the import fails (Plan 8 not merged) or `getMachineProvider` throws a config error, the result is "no provider", with the error's plain message added to the note.

**Files:**
- Create: `src/council/evidence.js`
- Test: `test/council-evidence.test.js` (new)

**Interfaces:**
- Consumes: `runGates`, `detectAxe`, `parseVitestJson`, `parsePlaywrightJson`, `parseCrossingJson` (Task 4); Plan 8's `AppChecks` shape (index A1); `pushCommit`, `runSmoke`, `cleanSmoke`, `SmokeError` (Task 5); `openCouncilLog`'s `{ log, state }` (Task 3); `ProjectContext` (Task 1); `fakeGatesRun`, `fakeSsh`, `fakeMachine`, `fakeProvider` (Tasks 4–5).
- Produces:
  - `reportFiles(checks)`, `reuseChecks(checks)`, `mergeGates(reused, own)` (shapes in the index);
  - `collectEvidence(ctx, { project, head, round, deps = {} }) -> Promise<Evidence>`. `ctx` is `{ ws, log, state, options }`, `project` carries `checks` and `factory`, and `deps` is `{ run, helpers, getMachineProvider, createSsh, home }`;
  - event `council-evidence { stage, status, machine }`, stages `cached | reuse | gates | acquire | push | smoke | cleanup | release`. `machine` is `Machine.id`, never a key path or user.

- [ ] **Step 1: Write the failing tests**

Create `test/council-evidence.test.js`. `ctxFor(councilTools = { axe: false })` builds `{ ws: { dir: <tmp> }, log, state }` from `openCouncilLog(<tmp buildDir>)` and `options: { ...DEFAULT_OPTIONS, councilTools }`. `project` is `{ slug: 'acme', runId: 'r1', buildDir, factory: {}, checks: null }`. `buildChecks()` writes the gates fixtures `vitest.json`, `playwright.json`, `crossing.json` and `screenshots/` into `<buildDir>/reports/` and returns `{ verify: { status: 'failed', summary: 'The tests fail.', output: '…' }, browser: { status: 'failed', summary: '…', output: '' }, reports: [<those four paths>] }`.

```js
test('a full round: gates locally, then the smoke on one machine, cleaned and released; saved by commit', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { provider, calls } = fakeProvider({ machine });
  const { ssh, calls: sshCalls } = fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf' }]);
  const ctx = ctxFor();
  const e = await collectEvidence(ctx, { project, head: 'sha1', round: 2, deps: { run: fakeGatesRun({ codes: { vitest: 1 } }).run, helpers: okChecks, getMachineProvider: () => provider, createSsh: () => ssh } });
  assert.equal(e.gates.steps.vitest, 1);
  assert.equal(e.smoke.passed, true);
  assert.deepEqual([e.smokeStatus, e.machine], ['ran', 'ct111']);
  assert.deepEqual(calls.acquire, [{ purpose: 'council', projectSlug: 'acme', runId: 'r1' }]);
  assert.equal(machine.released, 1);
  assert.equal(e.shotsDir, path.join(project.buildDir, 'council', 'round-2', 'screenshots'));
  assert.ok(existsSync(path.join(e.shotsDir, 'notes-mobile-webkit.png')));
  assert.deepEqual(sshCalls.map((c) => c.kind), ['upload', 'exec', 'exec', 'exec']);
  assert.equal(ctx.state.council.evidence.sha, 'sha1');
  assert.deepEqual(events(ctx, 'council-evidence').map((x) => `${x.stage}:${x.status}`),
    ['gates:start', 'gates:ok', 'acquire:start', 'acquire:ok', 'push:start', 'push:ok', 'smoke:start', 'smoke:ok', 'cleanup:ok', 'release:ok']);
});

test('Plan 8\'s checks for this commit are reused: no verify or browser run, only the axe pass', async () => {
  const axe = path.join(tmp(), 'axe.min.js');
  writeFileSync(axe, '/*! axe v4.10.3\n * Mozilla Public License, v. 2.0 */');
  const ctx = ctxFor({ councilTools: { axe } });
  const { run, calls } = fakeGatesRun();
  const e = await collectEvidence(ctx, { project: { ...project, checks: buildChecks() }, head: 'sha1', round: 1, deps: { run, helpers: okChecks, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.deepEqual(e.gates.source, { verify: 'build', browser: 'build', a11y: 'council' });
  assert.equal(e.gates.verify.status, 'failed');
  assert.equal(e.gates.tests.length, 4);
  assert.equal(e.gates.crossing.routes, 31);
  assert.equal(e.gates.a11y.length, 2);
  assert.deepEqual(calls.map((c) => c.step), ['npm-ci', 'build', 'a11y']);
  assert.ok(existsSync(path.join(ctx.ws.dir, 'reports', 'screenshots', 'notes-mobile-webkit.png')));
  assert.deepEqual(e.gates.screenshots.map((x) => x.file).sort(), ['reports/screenshots/notes-mobile-webkit.png', 'reports/screenshots/people-mobile-chromium.png']);
});

test('reuseChecks: a passed verify with no test report is not reused; a failed one is; an unreadable report is missing', () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'playwright.json'), 'not json');
  assert.equal(reuseChecks({ verify: { status: 'passed', summary: '', output: '' }, browser: { status: 'passed' }, reports: [] }).verify, null);
  assert.equal(reuseChecks({ verify: { status: 'failed', summary: 'The lint check fails.', output: 'x' }, browser: { status: 'skipped' }, reports: [] }).verify.status, 'failed');
  assert.equal(reuseChecks({ verify: { status: 'failed' }, browser: { status: 'failed' }, reports: [path.join(dir, 'playwright.json')] }).browser, null);
  assert.deepEqual(reportFiles(null), { vitest: null, playwright: null, crossing: null, screenshots: null });
});

test('same commit again: the saved evidence, no gates and no machine; a new commit runs again', async () => {
  // second call with head 'sha1' → calls.acquire.length stays 1, fake run gets no calls, one 'cached' event;
  // third call with head 'sha2' → acquire length 2
});

test('no machine provider: the gates still run; the smoke is "missing" with a plain note', async () => {
  const e = await collectEvidence(ctxFor(), { project, head: 'sha1', round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.ok(e.gates);
  assert.deepEqual([e.smoke, e.smokeStatus, e.smokeNote], [null, 'missing', 'No test machine is set up (factory.machines in the config), so the reliability test did not run.']);
});

test('SSH drops during the smoke: error, and the machine is still cleaned and released', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { ssh } = fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', code: 255, stderr: 'Connection reset' }, { match: 'rm -rf' }]);
  const e = await collectEvidence(ctxFor(), { project, head: 'sha1', round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ machine }).provider, createSsh: () => ssh } });
  assert.deepEqual([e.smoke, e.smokeStatus], [null, 'error']);
  assert.match(e.smokeNote, /could not reach the test machine/);
  assert.equal(machine.released, 1);
});

test('acquire throws, or release throws: plain notes, never a throw', async () => {
  const a = await collectEvidence(ctxFor(), { project, head: 'x', round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ acquireError: new Error('every host is busy') }).provider, createSsh: () => fakeSsh([]).ssh } });
  assert.deepEqual([a.smokeStatus, a.smokeNote], ['error', 'The test machine could not be started (every host is busy).']);
  const machine = fakeMachine({ id: 'ct111' });
  const { ssh } = fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf' }]);
  const b = await collectEvidence(ctxFor(), { project, head: 'y', round: 1, deps: { run: fakeGatesRun().run, helpers: okChecks, getMachineProvider: () => fakeProvider({ machine, releaseError: new Error('lock busy') }).provider, createSsh: () => ssh } });
  assert.equal(b.smoke.passed, true);
  assert.match(b.smokeNote, /The test machine ct111 could not be fully cleaned up \(lock busy\); the next run cleans it first\./);
});

test('no test database: gates null with the plain reason; the smoke still runs', async () => { /* helpers.testDatabaseProblem returns a sentence, checks null → e.gates === null, e.gatesNote is it, e.smoke set */ });

test('no test database but Plan 8\'s checks present: the reused evidence stands, the note says the axe pass did not run', async () => { /* checks: buildChecks(), axe ok, helpers.testDatabaseProblem returns a sentence → e.gates.source.verify === 'build', e.gates.a11y === null, e.gatesNote is the sentence */ });
```

Fill in the three sketched tests in the same style. `log`, `okChecks`, `events`, `project`, `buildChecks` and `ctxFor(councilTools?)` are helpers at the top of the file. `fakeGatesRun`'s `calls` record the matched `step`. In the first test (`checks: null`), every own gate step runs, as before.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-evidence.test.js`
Expected: FAIL with `Cannot find module '../src/council/evidence.js'`.

- [ ] **Step 3: Implement `src/council/evidence.js`** as described. Copy the screenshots with `cpSync`, skipping symlinks. Before `reuseChecks`, `collectEvidence` drops any path in `checks.reports` that is not under `project.buildDir` (Plan 8 copies its reports to `builds/<runId>/reports/`), so it counts as missing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-evidence.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/evidence.js test/council-evidence.test.js
git commit -m "feat(council): evidence stage (reuse the build's checks, own gates only for the rest and axe, smoke on one machine, saved by commit)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
