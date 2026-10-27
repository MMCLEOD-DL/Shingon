# Task 6: Evidence stage

`collectEvidence` gathers everything the project members measure, once per round, before any member runs (index Architecture). It is the only code in a round that runs the gates or touches a machine.

1. **Reuse.** If `state.council.evidence.sha === head`, return the saved value and emit `council-evidence { stage: 'cached' }` (Review Focus 5).
2. **Gates, locally** (Task 4), in `ctx.ws.dir`, with `axe = detectAxe(...)`:
   - `{ problem }` → `gates = null`, `gatesNote = problem`;
   - otherwise `gates` is the result, and `gatesNote = gates.note`.
   Afterwards the screenshots are copied to `<buildDir>/council/round-<N>/screenshots/` (`shotsDir`), keeping file names.
3. **Smoke, on a machine** (Task 5):
   - no provider → `smokeStatus: 'missing'`, `No test machine is set up (factory.machines in the config), so the reliability test did not run.`;
   - `acquire` throws → `error`, `The test machine could not be started (<message>).`;
   - otherwise: `pushCommit` to `<runDir>/smoke-app`, then `runSmoke`, then always, in `finally`, `cleanSmoke` followed by `machine.release()`, each in its own `try`. A clean-up or release problem is appended to `smokeNote` as `The test machine <id> could not be fully cleaned up (<reason>); the next run cleans it first.`;
   - `SmokeError` from push or run → `smoke = null`, `smokeStatus: 'error'`, `smokeNote` = its message (`timeout` → `The reliability test took longer than the time allowed.`).
4. Save `state.council.evidence = { sha: head, value }` with `log.saveState`.

The provider is `deps.getMachineProvider?.(project.factory ?? {}, { ssh })`, falling back to a dynamic import of `src/factory/machines/index.js` (index A2). `ssh = deps.createSsh?.() ?? (await import('../factory/ssh.js')).createSsh()`. If the import fails (Plan 8 not merged) or `getMachineProvider` throws a config error, the result is "no provider", with the error's plain message added to the note.

**Files:**
- Create: `src/council/evidence.js`
- Test: `test/council-evidence.test.js` (new)

**Interfaces:**
- Consumes: `runGates`, `detectAxe` (Task 4); `pushCommit`, `runSmoke`, `cleanSmoke`, `SmokeError` (Task 5); `openCouncilLog`'s `{ log, state }` (Task 3); `ProjectContext` (Task 1); `fakeGatesRun`, `fakeSsh`, `fakeMachine`, `fakeProvider` (Tasks 4–5).
- Produces:
  - `collectEvidence(ctx, { project, head, round, deps = {} }) -> Promise<Evidence>`. `ctx` is `{ ws, log, state, options }`, and `deps` is `{ run, checks, getMachineProvider, createSsh, home }`;
  - event `council-evidence { stage, status, machine }`. `machine` is `Machine.id`, never a key path or user.

- [ ] **Step 1: Write the failing tests**

Create `test/council-evidence.test.js`. `ctxFor()` builds `{ ws: { dir: <tmp> }, log, state }` from `openCouncilLog(<tmp buildDir>)` and `options: { ...DEFAULT_OPTIONS, councilTools: { axe: false } }`. `project` is `{ slug: 'acme', runId: 'r1', buildDir, factory: {} }`.

```js
test('a full round: gates locally, then the smoke on one machine, cleaned and released; saved by commit', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { provider, calls } = fakeProvider({ machine });
  const { ssh, calls: sshCalls } = fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf' }]);
  const ctx = ctxFor();
  const e = await collectEvidence(ctx, { project, head: 'sha1', round: 2, deps: { run: fakeGatesRun({ codes: { vitest: 1 } }).run, checks: okChecks, getMachineProvider: () => provider, createSsh: () => ssh } });
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

test('same commit again: the saved evidence, no gates and no machine; a new commit runs again', async () => {
  // second call with head 'sha1' → calls.acquire.length stays 1, fake run gets no calls, one 'cached' event;
  // third call with head 'sha2' → acquire length 2
});

test('no machine provider: the gates still run; the smoke is "missing" with a plain note', async () => {
  const e = await collectEvidence(ctxFor(), { project, head: 'sha1', round: 1, deps: { run: fakeGatesRun().run, checks: okChecks, getMachineProvider: () => null, createSsh: () => fakeSsh([]).ssh } });
  assert.ok(e.gates);
  assert.deepEqual([e.smoke, e.smokeStatus, e.smokeNote], [null, 'missing', 'No test machine is set up (factory.machines in the config), so the reliability test did not run.']);
});

test('SSH drops during the smoke: error, and the machine is still cleaned and released', async () => {
  const machine = fakeMachine({ id: 'ct111' });
  const { ssh } = fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', code: 255, stderr: 'Connection reset' }, { match: 'rm -rf' }]);
  const e = await collectEvidence(ctxFor(), { project, head: 'sha1', round: 1, deps: { run: fakeGatesRun().run, checks: okChecks, getMachineProvider: () => fakeProvider({ machine }).provider, createSsh: () => ssh } });
  assert.deepEqual([e.smoke, e.smokeStatus], [null, 'error']);
  assert.match(e.smokeNote, /could not reach the test machine/);
  assert.equal(machine.released, 1);
});

test('acquire throws, or release throws: plain notes, never a throw', async () => {
  const a = await collectEvidence(ctxFor(), { project, head: 'x', round: 1, deps: { run: fakeGatesRun().run, checks: okChecks, getMachineProvider: () => fakeProvider({ acquireError: new Error('every host is busy') }).provider, createSsh: () => fakeSsh([]).ssh } });
  assert.deepEqual([a.smokeStatus, a.smokeNote], ['error', 'The test machine could not be started (every host is busy).']);
  const machine = fakeMachine({ id: 'ct111' });
  const { ssh } = fakeSsh([{ match: 'tar -x' }, { match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf' }]);
  const b = await collectEvidence(ctxFor(), { project, head: 'y', round: 1, deps: { run: fakeGatesRun().run, checks: okChecks, getMachineProvider: () => fakeProvider({ machine, releaseError: new Error('lock busy') }).provider, createSsh: () => ssh } });
  assert.equal(b.smoke.passed, true);
  assert.match(b.smokeNote, /The test machine ct111 could not be fully cleaned up \(lock busy\); the next run cleans it first\./);
});

test('no test database: gates null with the plain reason; the smoke still runs', async () => { /* checks.testDatabaseProblem returns a sentence → e.gates === null, e.gatesNote is it, e.smoke set */ });
```

Fill in the two sketched tests in the same style. `log`, `okChecks`, `events` and `project` are helpers at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-evidence.test.js`
Expected: FAIL with `Cannot find module '../src/council/evidence.js'`.

- [ ] **Step 3: Implement `src/council/evidence.js`** as described. Copy the screenshots with `cpSync`, skipping symlinks.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-evidence.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/evidence.js test/council-evidence.test.js
git commit -m "feat(council): evidence stage (gates locally, smoke on one machine, always released, saved by commit)"
```
