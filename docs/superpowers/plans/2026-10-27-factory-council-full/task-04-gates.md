# Task 4: Gates (verify, browser gate, accessibility)

This task runs the foundation's own gates in the council workspace and reads machine-readable results (index Ruling 5):
- the `verify` steps, with vitest's JSON reporter;
- the browser gate, Playwright on the app's own `apps/web/e2e`, with the JSON reporter: screenshots of every page at desktop and phone width, the overflow, tap-size and script-error checks, the screen registry and the user journeys;
- an accessibility pass with axe-core when the operator has it.

They run locally, needing what Plan 8's whole-app checks already need: `TEST_DATABASE_URL` and the Playwright browsers. Plan 8's `testDatabaseProblem` and `browsersInstalled` (index A3) say whether they can run.

The steps, in order, each run with `sh -c` in the workspace. Output goes to `.council/out/<step>.log`, and the exit code is recorded:

| Step | Command |
|---|---|
| `npm-ci` | `npm ci --no-audit --no-fund --loglevel=error` (a failure stops here) |
| `lint` | `npm run lint` |
| `typecheck` | `npm run typecheck` |
| `licences` | `npm run licences` |
| `vitest` | `npx vitest run --reporter=default --reporter=json --outputFile.json=.council/out/vitest.json` |
| `build` | `npx tsc -b packages/shared && npm -w @hf/web run build` |
| `browser` | only when `build` passed and browsers are installed: `npx playwright test -c .council/playwright.config.ts --reporter=json`, with `PLAYWRIGHT_JSON_OUTPUT_NAME=<abs>/.council/out/playwright.json`, `HF_COUNCIL_OUT=<abs>/.council/out`, and `HF_COUNCIL_AXE=<axe path>` or empty |

Commands get the same environment that Plan 8's `runAppChecks` gives its commands (the child environment plus `TEST_DATABASE_URL`, `PLAYWRIGHT_BROWSERS_PATH` and `HF_E2E_MAIL_DIR` when set). The whole run shares `councilGatesTimeoutMs`. A step that runs out of time records `-1`, its log says `It took longer than the time allowed.`, and later steps are not run (`null`).

Two council files are written into the workspace before the browser step, from `src/council/assets/`:
- `.council/playwright.config.ts` imports the app's `../apps/web/playwright.config.ts` and spreads it. When `process.env.HF_COUNCIL_AXE` is set it appends two projects: `council-a11y-desktop` (Chromium 1280×800) and `council-a11y-phone` (Chromium 390×844, touch). Their `testDir` is `.council` and their `testMatch` is `/a11y\.spec\.ts/`. Every other setting (global set-up, web server, base URL) is the app's own;
- `.council/a11y.spec.ts`, for each `PAGES` entry from `../apps/web/e2e/pages.js`:
  - opens a context with the project's `use` and, for signed-in pages, `authFile(p.as)` from `../apps/web/e2e/fixtures.js`;
  - goes to `resolvePath(p, fx)` and waits for the heading `resolveReady(p, fx)`;
  - runs `page.addScriptTag({ path: process.env.HF_COUNCIL_AXE })`, then `axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] })`;
  - appends `{ page, project, violations: [{ id, impact, help, nodes: v.nodes.length, target: v.nodes[0]?.target?.join(' ') ?? null }] }` as one line to `$HF_COUNCIL_OUT/a11y.jsonl`.

The operator smoke (Task 14) proves both load under the real Playwright. If the `.ts` config import is refused there, switch the specifier to `.js`, which Playwright maps to `.ts`.

**axe detection** (index Ruling 11): `councilTools.axe` (a path, or `false`), else `~/.local/share/conductor/axe-core/axe.min.js` (under `env.HOME`).

**Files:**
- Create: `src/council/gates.js`, `src/council/assets/council.playwright.config.ts`, `src/council/assets/council-a11y.spec.ts`, `test/helpers/councilFull.js` (`fakeGatesRun`), `test/fixtures/council-full/gates-out/` (see Step 1)
- Test: `test/council-gates.test.js` (new)

**Interfaces:**
- Consumes: `browsersInstalled`, `testDatabaseProblem` (`src/factory/checks.js`, index A3), imported dynamically and injectable as `deps.checks` for tests; `runCommand`; `redact`, `clip`.
- Produces (`src/council/gates.js`):
  - `detectAxe({ options, env }) -> { path, version, status, note }`;
  - `parseSteps(text)`, `parseVitestJson(text)`, `parsePlaywrightJson(text)`, `parseA11yLines(text)`;
  - `GATE_STEPS = ['npm-ci', 'lint', 'typecheck', 'licences', 'vitest', 'build', 'browser']`;
  - `runGates({ dir, axe, options, env, run = runCommand, home, checks }) -> Promise<GatesResult | { problem }>`. `GatesResult` is as in the index. `steps` comes from the recorded exit codes. `logs[step]` holds the last 40 redacted lines of each failed step. `screenshots[].file` is relative to `dir` (`reports/screenshots/<file>`). `axe` is the `detectAxe` result passed in.
- Produces (`test/helpers/councilFull.js`): `fakeGatesRun({ codes = {}, fixtures = 'gates-out', timeout = null }) -> { run, calls }`. It answers each step by matching the command and copies the fixture reports into place: `vitest.json`, `playwright.json` and `a11y.jsonl` into `.council/out/`; `crossing.json` into `apps/server/reports/`; `screenshots/` into `reports/screenshots/`.

- [ ] **Step 1: Write the fixtures and the failing tests**

`test/fixtures/council-full/gates-out/` holds:
- `vitest.log`: 50 lines ending `FAIL  apps/server/test/claims.test.ts > [mileage-claims#1] 120 miles at 45p comes to £54.00`;
- `vitest.json`, in vitest's JSON reporter shape (`testResults[].name`, `assertionResults[].{ fullName, status, failureMessages }`), with four cases:
  - `claims > [mileage-claims#1] 120 miles at 45p comes to £54.00`: failed, `expected 5400, got 5399`;
  - `claims > [mileage-claims#2] a manager sees their team only`: passed;
  - `receipts > [receipts#1] later`: skipped;
  - `notes > a partial update changes only the fields sent`: passed;
- `playwright.json`, in Playwright's JSON reporter shape (nested `suites[].suites[].specs[].tests[].{ projectName, status, results[].error.message }`):
  - `responsive.spec.ts › notes works at this width`: `mobile-webkit`, unexpected, `the page scrolls sideways`;
  - `responsive.spec.ts › people works at this width`: `mobile-chromium`, expected;
  - `flows.spec.ts › a member adds a note with a photo`: `desktop-chromium`, unexpected, `Timed out 10000ms waiting for expect(locator).toBeVisible()`;
  - `registry.spec.ts › every app path has at least one page in the screenshot registry`: expected;
- `a11y.jsonl`: `notes` on `council-a11y-phone` with one `color-contrast` violation (`serious`, 3 nodes, target `.mantine-Button-root`, help `Elements must meet minimum color contrast ratio thresholds`); `people` on `council-a11y-desktop` with none;
- `crossing.json`: `{ "generatedAt": "2026-10-27T10:00:00.000Z", "routes": 31, "checks": 7012, "failures": [] }`;
- `screenshots/manifest.json` (the foundation's shape) naming `notes-mobile-webkit.png` and `people-mobile-chromium.png`, with those two tiny PNGs beside it.

Create `test/council-gates.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { detectAxe, parseVitestJson, parsePlaywrightJson, parseA11yLines, runGates, GATE_STEPS } from '../src/council/gates.js';
import { fakeGatesRun } from './helpers/councilFull.js';

const FX = new URL('./fixtures/council-full/gates-out/', import.meta.url).pathname;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'gates-'));
const read = (f) => readFileSync(path.join(FX, f), 'utf8');
const okChecks = { browsersInstalled: () => ({ ok: true, why: '' }), testDatabaseProblem: () => null };
const opts = { ...DEFAULT_OPTIONS, councilTools: { axe: false } };

test('detectAxe: checks the licence banner, never guesses', () => {
  const d = tmp();
  const good = path.join(d, 'axe.min.js');
  writeFileSync(good, '/*! axe v4.10.3\n * Copyright (c) 2015 - 2025 Deque Systems, Inc.\n * Your use of this Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. */\nvar axe=1;');
  assert.deepEqual(detectAxe({ options: { councilTools: { axe: good } } }), { path: good, version: '4.10.3', status: 'ok', note: null });
  const odd = path.join(d, 'other.js');
  writeFileSync(odd, 'var axe = 1;');
  const e = detectAxe({ options: { councilTools: { axe: odd } } });
  assert.equal(e.status, 'error');
  assert.equal(e.note, 'Conductor could not confirm that the file at councilTools.axe is axe-core under the Mozilla Public License, so the accessibility scan did not run.');
  assert.equal(detectAxe({ options: { councilTools: { axe: false } } }).status, 'off');
  const missing = detectAxe({ options: { councilTools: {} }, env: { HOME: d } });
  assert.equal(missing.status, 'missing');
  assert.match(missing.note, /^axe-core is not installed, so the accessibility scan did not run\. Install: /);
});

test('parsers read the real reporter shapes', () => {
  assert.deepEqual(parseVitestJson(read('vitest.json')).map((c) => [c.title, c.status]), [
    ['claims > [mileage-claims#1] 120 miles at 45p comes to £54.00', 'failed'],
    ['claims > [mileage-claims#2] a manager sees their team only', 'passed'],
    ['receipts > [receipts#1] later', 'skipped'],
    ['notes > a partial update changes only the fields sent', 'passed'],
  ]);
  const b = parsePlaywrightJson(read('playwright.json'));
  assert.deepEqual(b.filter((c) => !c.ok).map((c) => [path.basename(c.file), c.title, c.project]), [
    ['responsive.spec.ts', 'notes works at this width', 'mobile-webkit'],
    ['flows.spec.ts', 'a member adds a note with a photo', 'desktop-chromium'],
  ]);
  assert.match(b[0].message, /the page scrolls sideways/);
  assert.deepEqual(parseA11yLines(read('a11y.jsonl') + '\nnot json\n').map((p) => [p.page, p.violations.length]), [['notes', 1], ['people', 0]]);
  assert.throws(() => parseVitestJson('banner'), /The test report could not be read/);
});

test('runGates: every step in order, reports read, council files written into the workspace only', async () => {
  const dir = tmp();
  const { run, calls } = fakeGatesRun({ codes: { vitest: 1, browser: 1 } });
  const r = await runGates({ dir, axe: { status: 'off', path: null }, options: opts, env: {}, run, checks: okChecks });
  assert.deepEqual(GATE_STEPS.map((s) => r.steps[s]), [0, 0, 0, 0, 1, 0, 1]);
  assert.equal(r.tests.length, 4);
  assert.equal(r.crossing.routes, 31);
  assert.deepEqual(r.screenshots.map((s) => s.file).sort(), ['reports/screenshots/notes-mobile-webkit.png', 'reports/screenshots/people-mobile-chromium.png']);
  assert.match(r.logs.vitest, /FAIL {2}apps\/server\/test\/claims\.test\.ts/);
  assert.ok(existsSync(path.join(dir, '.council', 'playwright.config.ts')));
  const browserCall = calls.find((c) => c.args.at(-1).includes('playwright test'));
  assert.equal(browserCall.env.HF_COUNCIL_AXE, '');
  assert.equal(browserCall.env.PLAYWRIGHT_JSON_OUTPUT_NAME, path.join(dir, '.council', 'out', 'playwright.json'));
});

test('runGates: npm ci fails → nothing else runs; build fails → no browser step', async () => {
  const a = await runGates({ dir: tmp(), axe: { status: 'off' }, options: opts, env: {}, run: fakeGatesRun({ codes: { 'npm-ci': 1 } }).run, checks: okChecks });
  assert.deepEqual(GATE_STEPS.map((s) => a.steps[s]), [1, null, null, null, null, null, null]);
  const b = await runGates({ dir: tmp(), axe: { status: 'off' }, options: opts, env: {}, run: fakeGatesRun({ codes: { build: 2 } }).run, checks: okChecks });
  assert.equal(b.steps.browser, null);
  assert.equal(b.browser, null);
});

test('runGates: no test database → a plain problem, nothing run; no browsers → verify only, with a note', async () => {
  const { run, calls } = fakeGatesRun();
  const p = await runGates({ dir: tmp(), axe: { status: 'off' }, options: opts, env: {}, run,
    checks: { ...okChecks, testDatabaseProblem: () => 'TEST_DATABASE_URL is not set, so the foundation\'s tests cannot reach a database.' } });
  assert.deepEqual(p, { problem: 'TEST_DATABASE_URL is not set, so the foundation\'s tests cannot reach a database.' });
  assert.equal(calls.length, 0);
  const n = await runGates({ dir: tmp(), axe: { status: 'off' }, options: opts, env: {}, run: fakeGatesRun().run,
    checks: { ...okChecks, browsersInstalled: () => ({ ok: false, why: 'the Playwright browsers are not installed' }) } });
  assert.equal(n.steps.browser, null);
  assert.equal(n.note, 'The page check did not run: the Playwright browsers are not installed.');
});

test('runGates: a step that runs out of time stops the rest', async () => {
  const r = await runGates({ dir: tmp(), axe: { status: 'off' }, options: { ...opts, councilGatesTimeoutMs: 1000 }, env: {}, run: fakeGatesRun({ timeout: 'vitest' }).run, checks: okChecks });
  assert.equal(r.steps.vitest, -1);
  assert.equal(r.steps.build, null);
  assert.match(r.note, /took longer than the time allowed/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-gates.test.js`
Expected: FAIL with `Cannot find module '../src/council/gates.js'`.

- [ ] **Step 3: Write the two assets and implement `src/council/gates.js`**

- The install hint in `detectAxe`'s missing note: `Install: npm pack axe-core@4, then put package/axe.min.js at ~/.local/share/conductor/axe-core/axe.min.js (MPL-2.0; Conductor uses it as a tool and never adds it to client apps).`
- The parsers throw `The test report could not be read` / `The browser test report could not be read` on bad JSON. `parsePlaywrightJson` walks suites recursively. A test is `ok` when its `status` is `expected` or `flaky`, and `skipped` when `skipped`. `message` = the first result's `error.message`, redacted and clipped to 1000. `parseA11yLines` skips lines that do not parse.
- `runGates`: as described above. A missing report file leaves that field `null`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-gates.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/gates.js src/council/assets/ test/helpers/councilFull.js test/council-gates.test.js test/fixtures/council-full/gates-out/
git commit -m "feat(council): run the foundation's verify and browser gates with JSON reports, plus an axe accessibility pass"
```
