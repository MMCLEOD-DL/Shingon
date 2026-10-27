# Task 6: Whole-app checks

`runAppChecks` runs the foundation's own gates on one commit of the app, in a throwaway clone so `<project>/app` stays clean: `npm ci`, then the test command (`VERIFY_COMMAND` with the vitest JSON reporter added, see `verifyWithReports`: lint, types, licences and every test including the role-crossing harness), then, when wanted and possible, the browser gate (`npm run test:e2e`: Playwright on desktop and phone, with a screenshot of every page). It collects the evidence the operator and Plan 9 need into the build folder:
- the vitest and Playwright **JSON reports**, written straight into `reportsDir` by adding the JSON reporters on the command line (Contract 7 §7.7). No app file changes;
- `apps/server/reports/crossing.md|json` and `reports/screenshots/`, copied out of the clone.

`checks.reports` lists every path collected. The file names are fixed, so Plan 9 can find each one for the same `sha`: `vitest.json`, `playwright.json`, `crossing.md`, `crossing.json`, `screenshots`. The build uses it twice: a baseline on the untouched foundation (so a red machine is caught before any spend), and the final whole-app check.

**Files:**
- Create: `src/factory/checks.js`
- Test: `test/factory-checks.test.js`

**Interfaces:**
- Consumes: `git` (`src/workspace.js`), `runCommand` (`src/exec.js`), `strictChildEnv`, `redact` (`src/secrets.js`), `clip` (`src/text.js`), `shQuote` (`src/factory/remote.js`, Task 10), `makeFoundationRepo` (Task 1).
- Produces:
  - `VERIFY_COMMAND = '{ [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund --loglevel=error; } && npm run verify'`
  - `verifyWithReports(reportsDir) -> string`: `VERIFY_COMMAND + ' -- -- --reporter=default --reporter=json --outputFile.json=' + shQuote(path.join(reportsDir, 'vitest.json'))`.
    - The foundation's `verify` ends in `npm test` (`vitest run`). npm appends the arguments after the first `--` to the script's last command, so they reach vitest. Checked with npm 10.9.4: `npm run verify -- -- --x` runs `npm test -- --x`.
    - Used only when `testCommand` is null (the real verify). A custom `factory.build.testCommand` runs as given, with no vitest report; Plan 9 then runs its own gate (Contract 7 §7.7).
  - `browsersInstalled({ env = process.env, home = homedir() } = {}) -> { ok, why }`: looks in `env.PLAYWRIGHT_BROWSERS_PATH` or `<home>/.cache/ms-playwright` for a `chromium-<n>` and a `webkit-<n>` folder.
  - `runAppChecks({ appDir, sha, workDir, reportsDir, testCommand = null, browser = true, env = process.env, home, run = runCommand, timeoutMs = 3_600_000 }) -> Promise<AppChecks>` (index Shared Interfaces).
  - `checksLine(checks) -> string` (one plain sentence for summaries).
  - `testDatabaseProblem({ testCommand, env }) -> string|null`.

- [ ] **Step 1: Write the failing tests**

Create `test/factory-checks.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runAppChecks, browsersInstalled, checksLine, testDatabaseProblem, verifyWithReports, VERIFY_COMMAND } from '../src/factory/checks.js';
import { git } from '../src/workspace.js';
import { makeFoundationRepo } from './helpers/factoryFixtures.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
// A fake `run`: records commands, answers npm ci / the test command / the browser gate as told.
function fakeRun({ verify = 0, e2e = 0, writeReport = true } = {}) {
  const calls = [];
  const run = async (o) => {
    calls.push(o);
    const line = [o.cmd, ...(o.args ?? [])].join(' ');
    if (line.includes('test:e2e')) { writeFileSync(o.env.PLAYWRIGHT_JSON_OUTPUT_FILE, '{}'); return { code: e2e, stdout: e2e ? '2 failed: phone layout scrolls sideways' : '24 passed', stderr: '', timedOut: false }; }
    if (o.cmd === 'sh') {
      const m = o.args[1].match(/--outputFile\.json='([^']+)'/); if (m) writeFileSync(m[1], '{}');
      if (writeReport) { mkdirSync(path.join(o.cwd, 'apps/server/reports'), { recursive: true }); writeFileSync(path.join(o.cwd, 'apps/server/reports/crossing.md'), '# 12 routes, 0 failures\n'); }
      return { code: verify, stdout: verify ? 'FAIL apps/server/test/x.test.ts' : 'ok', stderr: '', timedOut: false };
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false };
  };
  return { run, calls };
}
const browsersHome = () => { const h = tmp('home-'); mkdirSync(path.join(h, '.cache/ms-playwright/chromium-1248'), { recursive: true }); mkdirSync(path.join(h, '.cache/ms-playwright/webkit-2370'), { recursive: true }); return h; };

test('green: clone at the commit, install, verify, browser gate; reports copied; the clone removed', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const workDir = path.join(tmp('chk-'), 'check');
  const reportsDir = tmp('rep-');
  const { run, calls } = fakeRun();
  const c = await runAppChecks({ appDir, sha, workDir, reportsDir, run, home: browsersHome(), env: {} });
  assert.deepEqual([c.verify.status, c.browser.status], ['passed', 'passed']);
  assert.deepEqual(calls.map((x) => x.cmd === 'sh' ? x.args[1] : [x.cmd, ...x.args].join(' ')),
    ['npm ci --no-audit --no-fund --loglevel=error', verifyWithReports(reportsDir), 'npm run test:e2e -- --reporter=list,json']);
  assert.equal(calls[2].env.PLAYWRIGHT_JSON_OUTPUT_FILE, path.join(reportsDir, 'playwright.json'));
  assert.equal(readFileSync(path.join(reportsDir, 'crossing.md'), 'utf8'), '# 12 routes, 0 failures\n');
  assert.deepEqual(c.reports, ['vitest.json', 'playwright.json', 'crossing.md'].map((n) => path.join(reportsDir, n)));
  assert.equal(existsSync(workDir), false);
  assert.equal(checksLine(c), 'All checks pass (lint, types, licences and every test, including the role-crossing tests), and the browser checks pass.');
});

test('red verify: the browser gate is skipped and the output is kept, clipped and redacted', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const { run } = fakeRun({ verify: 1 });
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run, home: browsersHome(), env: {} });
  assert.equal(c.verify.status, 'failed');
  assert.match(c.verify.output, /FAIL apps\/server\/test\/x\.test\.ts/);
  assert.equal(c.browser.status, 'skipped');
  assert.match(checksLine(c), /^The checks FAIL/);
});

test('no browsers: the browser gate shows as not run, with the install hint', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run: fakeRun().run, home: tmp('nohome-'), env: {} });
  assert.equal(c.browser.status, 'missing');
  assert.match(c.browser.summary, /npx playwright install chromium webkit/);
  assert.equal(browsersInstalled({ home: browsersHome(), env: {} }).ok, true);
});

test('browser: false skips the gate without looking for browsers', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run: fakeRun().run, browser: false, env: {} });
  assert.equal(c.browser.status, 'skipped');
});

test('npm ci failing is a failed verify in plain words', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const run = async (o) => (o.cmd === 'npm' ? { code: 1, stdout: '', stderr: 'ERR! network', timedOut: false } : { code: 0, stdout: '', stderr: '' });
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run, browser: false, env: {} });
  assert.equal(c.verify.status, 'failed');
  assert.match(c.verify.summary, /could not install the app's packages/);
});

test('a custom test command runs as given, with no vitest report', async () => {
  const appDir = await makeFoundationRepo();
  const sha = (await git(appDir, ['rev-parse', 'HEAD'])).stdout.trim();
  const { run, calls } = fakeRun({ writeReport: false });
  const c = await runAppChecks({ appDir, sha, workDir: path.join(tmp('chk-'), 'c'), reportsDir: tmp('rep-'), run, browser: false, testCommand: 'node -e 0', env: {} });
  assert.equal(calls.find((x) => x.cmd === 'sh').args[1], 'node -e 0');
  assert.deepEqual(c.reports, []);
});

test('TEST_DATABASE_URL is required only for the real verify', () => {
  assert.match(testDatabaseProblem({ testCommand: null, env: {} }), /TEST_DATABASE_URL is not set/);
  assert.equal(testDatabaseProblem({ testCommand: null, env: { TEST_DATABASE_URL: 'postgres://x@127.0.0.1/postgres' } }), null);
  assert.equal(testDatabaseProblem({ testCommand: 'node -e 0', env: {} }), null);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-checks.test.js`
Expected: FAIL (`Cannot find module '../src/factory/checks.js'`).

- [ ] **Step 3: Implement `src/factory/checks.js`**

- `runAppChecks`:
  1. `rmSync(workDir, { recursive: true, force: true })`; `mkdirSync(path.dirname(workDir), { recursive: true })`; `git(path.dirname(workDir), ['clone', '--quiet', '--no-hardlinks', appDir, workDir])`; `git(workDir, ['checkout', '-q', '--detach', sha])`. A git failure throws (the caller turns it into a failed build).
  2. `run({ cmd: 'npm', args: ['ci', '--no-audit', '--no-fund', '--loglevel=error'], cwd: workDir, env, timeoutMs })` where `env = strictChildEnv({ env })`. Failure → `verify = { status: 'failed', summary: "Conductor could not install the app's packages (npm ci failed), so the checks could not run.", output }`, browser skipped.
  3. `mkdirSync(reportsDir, { recursive: true })`; `run({ cmd: 'sh', args: ['-c', testCommand ?? verifyWithReports(reportsDir)], … })`. Exit 0 and not timed out → passed.
  4. Browser: `browser === false` or verify failed → `{ status: 'skipped', summary: browser === false ? 'The browser checks are turned off in the settings.' : 'The browser checks did not run, because the main checks failed.' }`. No browsers → `missing` with `The browser checks did not run: Playwright's browsers are not installed on this computer (run: npx playwright install chromium webkit).` Otherwise `run({ cmd: 'npm', args: ['run', 'test:e2e', '--', '--reporter=list,json'], env: { ...env, PLAYWRIGHT_JSON_OUTPUT_FILE: <reportsDir>/playwright.json }, … })`. The foundation's `test:e2e` ends in `playwright test -c …`, so the reporter flag reaches Playwright.
  5. Copy, when present, `apps/server/reports/crossing.md`, `apps/server/reports/crossing.json` and the folder `reports/screenshots` into `reportsDir` (`cpSync`, recursive).
     - `reports` lists, in this order, whichever exist: `vitest.json`, `playwright.json`, `crossing.md`, `crossing.json`, `screenshots`, each as an absolute path in `reportsDir`.
     - A report a failed or skipped step did not write is simply absent.
  6. `finally`: remove `workDir`.
  - Every `output` is `clip(redact(stdout + stderr), 4000)`; a timeout appends `[timed out]`.
- `checksLine`: passed+passed → the sentence in the test; passed + missing/skipped → `All checks pass (…). <browser summary>`; verify failed → `The checks FAIL: <first non-empty output line>`; passed + browser failed → `All checks pass, but the browser checks FAIL: <first line>`.
- `testDatabaseProblem`: only when `testCommand == null` (the real verify) and `env.TEST_DATABASE_URL` is empty: `TEST_DATABASE_URL is not set, so the foundation's tests cannot reach a database. Set it to a PostgreSQL role that may create databases (for example postgres://hf_test@127.0.0.1/postgres) and run the command again.`

- [ ] **Step 4: Run the tests**

Run: `node --test test/factory-checks.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/checks.js test/factory-checks.test.js
git commit -m "feat(factory): whole-app checks in a throwaway clone, with the browser gate

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
