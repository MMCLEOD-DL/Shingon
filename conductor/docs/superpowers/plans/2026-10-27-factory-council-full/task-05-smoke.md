# Task 5: Reliability smoke on a machine

Reliability's evidence is the foundation's own full-bundle smoke test, `deploy/smoke/run-smoke.sh`. It ships in every client app, because apps are cloned from the foundation tag. It does exactly what spec §2 item 4 and §4.3 ask, and nothing leaves the machine:
- it builds the images and installs the bundle with `ops init` (demo mode);
- it backs up to a local restic REST server, runs a restore test, and does a real restore followed by an upload;
- it stops the app, sees the front door's "being updated" page, and waits for the "not answering" alert and then the "Fixed" alert, through a local catcher;
- it runs a good update from an image file and a broken update that must undo itself;
- it backs up and restore-tests again, and checks that no secret appears in the alerts or logs.

Conductor does **not** copy or rewrite it. It pushes the reviewed commit to the machine and runs the app's own copy.

It stays on the foundation **v0.1.0** smoke (Contract 7.9): fixed names (`hfsmoke`, `/tmp/hf-smoke`), no `HF_SMOKE_PROJECT`/`HF_SMOKE_DIR`, no hard-kill step. Those arrive in foundation v0.2.0 (Plan 12 milestone 1); switching to them is a follow-up. The smoke refuses where `highland/app` or `highland/ops` images exist. Under Contract 7.8 that should not happen on the build machine (Plan 10's `cleanupBuild` removes the `highland/*` images it builds; previews use `hf-preview/*` names and remove them), but the refusal is still parsed and shown as "not proven" (Task 11).

All remote work goes through Plan 8's SSH helper (index A2): `exec(machine, script)` sends a bash script to `bash -s`, and `upload` copies a file with `scp`. Both resolve `{ code, stdout, stderr }`, where code 255 means SSH itself failed. Values placed in scripts are quoted with Plan 8's `shQuote`.

- **`pushCommit`:** `git archive --format=tar -o <tmp>/app.tar <sha>` in `dir`; `upload` it to `<remoteDir>.tar`; then `exec`: `mkdir -p <remoteDir> && tar -x -C <remoteDir> -f <remoteDir>.tar && rm -f <remoteDir>.tar`. The local temp folder is removed in `finally`.
- **`runSmoke`:** one script made of `export ROOT=…`, `export SMOKE_SECONDS=…`, then `smoke-clean.sh`, then `smoke.sh`:
  1. **Pre-clean** (`smoke-clean.sh`) what an earlier crashed smoke may have left, touching only the smoke's own named things: containers, volumes and networks labelled `com.docker.compose.project=hfsmoke`; the container `hf-smoke-rest`; `/tmp/hf-smoke`; `/tmp/hf-smoke-cookies`. Otherwise the smoke refuses ("A previous smoke run was left behind").
  2. **Run** `cd "$ROOT" && HF_SMOKE_BIND=127.0.0.1 timeout --signal=TERM "$SMOKE_SECONDS" bash deploy/smoke/run-smoke.sh 2>&1`, then print `COUNCIL-SMOKE-EXIT $?`. When `deploy/smoke/run-smoke.sh` is missing, print `COUNCIL-REFUSED This app has no deploy/smoke/run-smoke.sh (it was not built from the foundation).` and exit 3.
  `SMOKE_SECONDS` is `timeoutMs` minus 5 minutes (at least 60 s). The SSH call gets the full `timeoutMs`.
- **`cleanSmoke`:** `smoke-clean.sh`, then `rm -rf <remoteDir>`, but only when the path starts with `<machine.runDir>/`.

**Files:**
- Create: `src/council/smoke.js`, `src/council/assets/smoke.sh`, `src/council/assets/smoke-clean.sh`, `test/fixtures/council-full/smoke-passed.log`, `smoke-failed-step5.log`, `smoke-refused-images.log`
- Modify: `test/helpers/councilFull.js` (adds `fakeSsh`, `fakeMachine`, `fakeProvider`)
- Test: `test/council-smoke.test.js` (new)

**Interfaces:**
- Consumes: `shQuote` (`src/factory/remote.js`, Plan 8); the `createSsh` result shape (index A2), always passed in as `ssh`; `git`; `redact`, `clip`.
- Produces (`src/council/smoke.js`):
  - `SMOKE_STEPS = { '1': 'build the app images', '2': 'start the backup server and the alert catcher', '3': 'install the bundle with ops init', '4': 'start the app and load the demo data', '5': 'back up, then test a restore', '6': 'run every health check', '6a': 'restore over the live data, then upload a file', '7': 'stop the app: an alert is sent, then Fixed', '8': 'update, then undo a broken update automatically', '9': 'back up and test a restore after the rollback', secrets: 'no secret in the alerts or logs', '10': 'tear down' }`;
  - `class SmokeError extends Error` with `kind: 'unreachable' | 'timeout' | 'failed'`;
  - `pushCommit({ ssh, machine, dir, sha, remoteDir, timeoutMs })`: throws `SmokeError('unreachable', 'Conductor could not reach the test machine <host> over SSH.')`, or `SmokeError('failed', 'The app could not be copied to the test machine <host>.')`;
  - `runSmoke({ ssh, machine, remoteDir, timeoutMs }) -> Promise<SmokeResult>`. It throws `SmokeError('unreachable')` on code 255. A `COUNCIL-REFUSED <reason>` line gives `{ ran: false, refused: <reason>, … }`;
  - `parseSmokeLog(text, code, { timedOut = false } = {}) -> SmokeResult`;
  - `cleanSmoke({ ssh, machine, remoteDir }) -> Promise<string | null>`.
- Produces (`test/helpers/councilFull.js`):
  - `fakeMachine(over = {})`: `{ id: 'ct111', host: '192.168.1.111', runDir: '/srv/hf-factory/runs/acme-r1', ssh: {…}, released: 0, release() }`;
  - `fakeProvider({ machine, acquireError, releaseError }) -> { provider, calls }`;
  - `fakeSsh(routes) -> { ssh: { exec, upload }, calls }`. A route is `{ match, stdout = '', stderr = '', code = 0, once = false }`, matched against the script text. `calls` records `{ kind: 'exec' | 'upload', script | localFile, remotePath, bytes }`.

- [ ] **Step 1: Write the fixtures and the failing tests**

The three logs copy the `say` / `ok` / `FAILED` / `SMOKE …` line formats from `/root/highland-foundation/deploy/smoke/run-smoke.sh`:
- `smoke-passed.log`: every `== Step` line 1–9 with its `   ok:` line (step `6a` included), then the `== Secrets:` line with `   ok: no secret found`, then `== Step 10: tear down`, `SMOKE PASSED in 14 min 3 s` and `COUNCIL-SMOKE-EXIT 0`;
- `smoke-failed-step5.log`: steps 1–4 ok, then `== Step 5: ops backup, then ops restore-test`, `   FAILED: restore-test: Restore test failed: 2 tables differ`, `SMOKE FAILED during: step 5 (backup and restore test) (exit 1). Cleaning up.`, the step 10 lines and `COUNCIL-SMOKE-EXIT 1`;
- `smoke-refused-images.log`: `This machine already has highland/app or highland/ops images (local or from a registry), so it may be a client box or someone's build machine. The smoke test builds and deletes those images, so it runs only where there are none. Stopping.` and `COUNCIL-SMOKE-EXIT 2`.

Create `test/council-smoke.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { parseSmokeLog, runSmoke, pushCommit, cleanSmoke, SMOKE_STEPS } from '../src/council/smoke.js';
import { fakeMachine, fakeSsh } from './helpers/councilFull.js';
import { makeRepo } from './helpers/gitRepo.js';

const log = (f) => readFileSync(new URL(`./fixtures/council-full/${f}`, import.meta.url), 'utf8');

test('a passing smoke: every step ok, in order', () => {
  const r = parseSmokeLog(log('smoke-passed.log'), 0);
  assert.equal(r.passed, true);
  assert.deepEqual(r.steps.map((s) => [s.n, s.ok]), [['1', true], ['2', true], ['3', true], ['4', true], ['5', true], ['6', true], ['6a', true], ['7', true], ['8', true], ['9', true], ['secrets', true], ['10', false]]);
  assert.equal(SMOKE_STEPS['7'], 'stop the app: an alert is sent, then Fixed');
});

test('a failed step: which one, and the FAILED line', () => {
  const r = parseSmokeLog(log('smoke-failed-step5.log'), 1);
  assert.deepEqual([r.passed, r.failedStep, r.failure, r.refused], [false, '5', 'restore-test: Restore test failed: 2 tables differ', null]);
  assert.match(r.tail, /SMOKE FAILED during: step 5/);
});

test('a refusal (exit 2 before any step) is not a failure of the app', () => {
  const r = parseSmokeLog(log('smoke-refused-images.log'), 2);
  assert.equal(r.failedStep, null);
  assert.match(r.refused, /^This machine already has highland\/app or highland\/ops images/);
});

test('timed out, or a failure with no FAILED line', () => {
  const t = parseSmokeLog('== Step 1: build\n', 124, { timedOut: true });
  assert.deepEqual([t.passed, t.timedOut, t.failedStep], [false, true, '1']);
  const u = parseSmokeLog('== Step 3: make the bundle\nsomething odd\n', 1);
  assert.deepEqual([u.failedStep, u.failure], ['3', 'the step stopped without saying why (exit code 1)']);
});

test('pushCommit uploads exactly that commit and unpacks it in the run folder', async () => {
  const repo = await makeRepo({ 'a.txt': 'one\n' });
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
  const { ssh, calls } = fakeSsh([{ match: 'tar -x', stdout: '' }]);
  await pushCommit({ ssh, machine: fakeMachine(), dir: repo, sha, remoteDir: '/srv/hf-factory/runs/acme-r1/smoke-app', timeoutMs: 5000 });
  assert.deepEqual(calls.map((c) => c.kind), ['upload', 'exec']);
  assert.equal(calls[0].remotePath, '/srv/hf-factory/runs/acme-r1/smoke-app.tar');
  assert.match(calls[1].script, /tar -x -C '\/srv\/hf-factory\/runs\/acme-r1\/smoke-app' -f '\/srv\/hf-factory\/runs\/acme-r1\/smoke-app\.tar'/);
  const bad = fakeSsh([{ match: 'tar -x', code: 255, stderr: 'ssh: connect to host 192.168.1.111 port 22: No route to host' }]);
  await assert.rejects(pushCommit({ ssh: bad.ssh, machine: fakeMachine(), dir: repo, sha, remoteDir: '/srv/hf-factory/runs/acme-r1/smoke-app', timeoutMs: 5000 }),
    (e) => e.kind === 'unreachable' && e.message === 'Conductor could not reach the test machine 192.168.1.111 over SSH.');
});

test('runSmoke: pre-clean, the app\'s own smoke, the exit line; cleanSmoke removes only the run folder', async () => {
  const { ssh, calls } = fakeSsh([{ match: 'run-smoke.sh', stdout: log('smoke-passed.log') }, { match: 'rm -rf', stdout: '' }]);
  const r = await runSmoke({ ssh, machine: fakeMachine(), remoteDir: '/srv/hf-factory/runs/acme-r1/smoke-app', timeoutMs: 3600000 });
  assert.equal(r.passed, true);
  const script = calls[0].script;
  assert.match(script, /export SMOKE_SECONDS='3300'/);
  assert.match(script, /label=com\.docker\.compose\.project=hfsmoke/);
  assert.match(script, /docker rm -f hf-smoke-rest/);
  assert.match(script, /bash deploy\/smoke\/run-smoke\.sh/);
  assert.equal(await cleanSmoke({ ssh, machine: fakeMachine(), remoteDir: '/srv/hf-factory/runs/acme-r1/smoke-app' }), null);
  assert.match(calls.at(-1).script, /rm -rf '\/srv\/hf-factory\/runs\/acme-r1\/smoke-app'/);
  await assert.rejects(cleanSmoke({ ssh, machine: fakeMachine(), remoteDir: '/etc' }), /outside the machine's run folder/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-smoke.test.js`
Expected: FAIL with `Cannot find module '../src/council/smoke.js'`.

- [ ] **Step 3: Implement `smoke.sh`, `smoke-clean.sh` and `src/council/smoke.js`**

`parseSmokeLog`:
- `== Step <n>: …` opens step `n` (`/^\d+[a-z]?$/`); `== Secrets:` opens `secrets`;
- `   ok: …` marks the open step ok;
- the first `   FAILED: <msg>` sets `failure`;
- `SMOKE FAILED during: step <n> …` or `during: secrets check` sets `failedStep`. Otherwise, on a non-zero code, `failedStep` = the last opened step, and `failure` defaults to `the step stopped without saying why (exit code <code>)`;
- `SMOKE PASSED` with code 0 → `passed`;
- code 2 with no step opened → `refused` = the first non-empty line;
- `tail` = the last 40 lines, redacted.

The exit code comes from the `COUNCIL-SMOKE-EXIT` line, else from the SSH result. Code 124 (the remote `timeout`), or an SSH result with code `-1`, means `timedOut`.

`cleanSmoke` throws `The clean-up path <p> is outside the machine's run folder.` for a bad path (a programming error, never remote input). Otherwise it returns `null`, or `The test machine <id> could not be fully cleaned up (<first stderr line>).` on a non-zero exit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-smoke.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/smoke.js src/council/assets/smoke.sh src/council/assets/smoke-clean.sh test/helpers/councilFull.js test/council-smoke.test.js test/fixtures/council-full/smoke-*.log
git commit -m "feat(council): run the app's own foundation smoke (deploy, backup, restore, alerts, rollback) on a test machine

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
