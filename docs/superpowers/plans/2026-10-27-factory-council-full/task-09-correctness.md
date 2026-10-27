# Task 9: Correctness for client apps

On an ordinary repo Correctness is unchanged (Plan 5 Task 4). On a project build (`input.brief` set) it checks spec §2 item 2 ("numbers must be correct") and the brief:

1. **`verify`**: the foundation's checks as the council's gates ran them (Task 4): `npm-ci`, `lint`, `typecheck`, `licences`, `vitest`, `build`. Each failed step is one **locked blocking** finding. On project rounds this **replaces** Plan 5's `tests` ToolRun (the hook passes no local test result). When the gates did not run (`input.evidence.gates` is null), `verify` is `skipped`, with the note `The foundation's checks did not run in the council (<gatesNote>).`

   | Step | Title |
   |---|---|
   | `npm-ci` | `The app's packages could not be installed (npm ci failed)` |
   | `lint` | `The lint check fails` |
   | `typecheck` | `The type check fails` |
   | `licences` | `The licence check fails` |
   | `vitest` | `The tests fail` |
   | `build` | `The web app does not build` |

   The detail is the step's log tail. The role-crossing report (`crossing.json`) goes into `context`: `Role-crossing tests: <routes> routes, <checks> checks, <n> failures.`, plus up to 10 failure sentences. (A crossing failure is already a vitest failure, so it blocks through `The tests fail`.)
2. **`test-files`**: Plan 5's check, unchanged.
3. **`coverage`** (index Ruling 8). For each acceptance example (`acceptanceIds`), the matching tests are the vitest and Playwright cases whose title contains `[<id>]`.
   - **No match**, or every match skipped or todo → **locked blocking** `Worked example <id> has no test`. Detail: `Feature: <title>. Given <given>, when <when>, then <then>. Write a test whose title includes [<id>].`
   - **Any match failed** → **locked blocking** `Worked example <id> fails its test`. Detail: that test's title and message.
   - Otherwise the example is **proven**.
   - A feature with no examples → **locked warning** `Feature <id> has no worked examples`.
   - A tag in a test title naming an example the brief does not have → **note** `A test names worked example <id>, which the brief does not have`.

   `context`: `Worked examples proven: <p> of <t>.`, plus one line per example that is not proven. The ToolRun also carries `coverage: { proven, total }`, which Task 12 puts in the report. With no test report (the gates did not run) the ToolRun is `skipped`, with the **locked warning** `Brief coverage was not proven: there was no test report` (index Ruling 7).
4. **`journeys`**: each failed, non-skipped case in `flows.spec.ts` is a **locked blocking** finding `A user journey fails in the browser: <title> (<width>)`, using Task 8's width words. Skipped when there was no browser report.
5. **`money`**: a heuristic for floating-point money (BUILDING-ON: "whole pence in integers"). It scans `input.files` under `apps/server/src/`, `packages/shared/src/` and `apps/web/src/` (`.ts`, `.tsx`; not test files). A line counts when it names money (`/\b(amount|price|total|subtotal|vat|tax|cost|net|gross|fee|mileage|pence|pounds)\w*/i`) **and** does floating-point arithmetic (`parseFloat(`, `* <decimal literal>` such as `* 0.2`, or, outside `apps/web/`, `.toFixed(`). Each such file gets one **warning** `<file> may work out money in floating point instead of whole pence`, with its first line number and a count. At most 10.

The interpreter (Task 7, `FOCUS_PROJECT.correctness`) reads the brief and these measurements to look for untested money and permission paths. Whatever it adds without tool evidence is at most a warning.

**Files:**
- Create: `src/council/coverage.js`
- Modify: `src/council/correctness.js`
- Test: `test/council-coverage.test.js` (new), `test/council-correctness.test.js` (append)

**Interfaces:**
- Consumes: `acceptanceIds` (Task 1); `GatesResult` (Task 4); `Evidence` (Task 6, `input.evidence`); Plan 5's `testFindings`, `testFilesFinding`, `TEST_FILE`; Task 8's `WIDTH`; the gates fixtures.
- Produces:
  - `ACCEPTANCE_TAG = (id) => `[${id}]`` and `TAG_PATTERN = /\[([a-z0-9][a-z0-9-]*)#(\d+)\]/g` (`src/council/coverage.js`);
  - `coverageFindings(brief, cases) -> { findings, proven, total, lines: string[] }`, where `cases` is `[{ title, status: 'passed' | 'failed' | 'skipped' | 'todo', message }]`;
  - `verifyFindings(steps, logs) -> Finding[]`, `journeyFindings(browser) -> Finding[]`, `moneyFindings({ dir, files }) -> Finding[]` (`src/council/correctness.js`);
  - `CORRECTNESS.collect(input)`: Plan 5's two ToolRuns when `!input.brief`; otherwise `verify`, `test-files`, `coverage`, `journeys`, `money`.

- [ ] **Step 1: Write the failing tests**

Create `test/council-coverage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageFindings, ACCEPTANCE_TAG } from '../src/council/coverage.js';
import { applyInterpretation } from '../src/council/interpret.js';

import { BRIEF } from './fixtures/council-full/brief.js';

test('each worked example needs a passing test that carries its tag', () => {
  const r = coverageFindings(BRIEF, [
    { title: '[mileage-claims#1] 120 miles at 45p comes to £54.00', status: 'failed', message: 'expected 5400, got 5399' },
    { title: 'claims > [mileage-claims#2] [mileage-claims#3] team only, and zero refused', status: 'passed' },
    { title: '[mileage-claims#9] an old example', status: 'passed' },
  ]);
  assert.deepEqual([r.proven, r.total], [2, 3]);
  assert.deepEqual(r.findings.map((f) => [f.title, f.grade, f.locked]), [
    ['Worked example mileage-claims#1 fails its test', 'blocking', true],
    ['Feature receipts has no worked examples', 'warning', true],
    ['A test names worked example mileage-claims#9, which the brief does not have', 'note', false],
  ]);
  assert.match(r.findings[0].detail, /expected 5400, got 5399/);
  assert.deepEqual(r.lines, ['Worked examples proven: 2 of 3.', '- mileage-claims#1: its test fails']);
  assert.equal(ACCEPTANCE_TAG('mileage-claims#1'), '[mileage-claims#1]');
});

test('the interpreter cannot clear or lower a coverage block', () => {
  const [f] = coverageFindings({ features: [BRIEF.features[0]] }, []).findings;
  const out = applyInterpretation([f], ['C1'], { findings: [{ id: 'C1', decision: 'dismiss', grade: 'note', why: 'covered by another test' }], extra: [] }, { member: 'correctness' });
  assert.deepEqual([out[0].grade, out[0].dismissed], ['blocking', false]);
});

test('skipped, todo or a mistyped tag counts as no test', () => {
  const r = coverageFindings({ features: [BRIEF.features[0]] }, [
    { title: '[mileage-claims#1] later', status: 'skipped' },
    { title: '[mileage-claims#2] later', status: 'todo' },
    { title: '[mileage-claims#3 ] stray space', status: 'passed' },
  ]);
  assert.equal(r.proven, 0);
  assert.deepEqual(r.findings.map((f) => f.title), [
    'Worked example mileage-claims#1 has no test', 'Worked example mileage-claims#2 has no test', 'Worked example mileage-claims#3 has no test']);
  assert.match(r.findings[0].detail, /^Feature: Mileage claims\. Given a member, when they claim 120 miles, then the claim is £54\.00 at 45p a mile\. Write a test whose title includes \[mileage-claims#1\]\.$/);
});
```

Append to `test/council-correctness.test.js`:

```js
test('project build: verify, coverage, journeys and money run', async () => {
  const gates = { steps: { 'npm-ci': 0, lint: 0, typecheck: 0, licences: 0, vitest: 1, build: 0, browser: 1 }, logs: { vitest: 'FAIL claims.test.ts' },
    tests: parseVitestJson(fx('vitest.json')), browser: parsePlaywrightJson(fx('playwright.json')), crossing: { routes: 31, checks: 7012, failures: [] } };
  const runs = await CORRECTNESS.collect({ brief: BRIEF, dir: tmpDirWithMoneyFile, files: ['apps/server/src/claims/total.ts'], tests: null, evidence: { gates, gatesNote: null } });
  assert.deepEqual(runs.map((r) => r.tool), ['verify', 'test-files', 'coverage', 'journeys', 'money']);
  assert.deepEqual(runs[0].findings.map((f) => [f.title, f.grade, f.locked]), [['The tests fail', 'blocking', true]]);
  assert.match(runs[0].context, /Role-crossing tests: 31 routes, 7012 checks, 0 failures\./);
  assert.deepEqual(runs[2].coverage, { proven: 1, total: 3 });
  assert.deepEqual(runs[3].findings.map((f) => f.title), ['A user journey fails in the browser: a member adds a note with a photo (desktop)']);
  assert.deepEqual(runs[4].findings.map((f) => [f.file, f.grade, f.maxGrade]), [['apps/server/src/claims/total.ts', 'warning', 'warning']]);
});

test('project build without gates: verify and coverage are "not proven"', async () => {
  const runs = await CORRECTNESS.collect({ brief: BRIEF, dir: '/nope', files: [], tests: null, evidence: { gates: null, gatesNote: 'TEST_DATABASE_URL is not set' } });
  assert.deepEqual(runs.map((r) => [r.tool, r.status]), [['verify', 'skipped'], ['test-files', 'ran'], ['coverage', 'skipped'], ['journeys', 'skipped'], ['money', 'ran']]);
  assert.equal(runs[0].note, "The foundation's checks did not run in the council (TEST_DATABASE_URL is not set).");
  assert.deepEqual(runs[2].findings.map((f) => [f.title, f.grade, f.locked]), [['Brief coverage was not proven: there was no test report', 'warning', true]]);
});

test('ordinary repo: exactly the Plan 5 checks', async () => {
  const runs = await CORRECTNESS.collect({ files: ['src/a.js'], tests: { ran: true, passed: true, code: 0, output: '' } });
  assert.deepEqual(runs.map((r) => r.tool), ['tests', 'test-files']);
});
```

`tmpDirWithMoneyFile` holds `apps/server/src/claims/total.ts` with `const total = miles * 0.45;`. `BRIEF` comes from `test/fixtures/council-full/brief.js` (Task 1), and `fx` reads the gates fixtures. The `vitest.json` fixture has `#1` failed and `#2` passed, and no `#3` case, so 1 of 3 is proven.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-coverage.test.js test/council-correctness.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** `src/council/coverage.js` and the additions to `src/council/correctness.js` exactly as described above. Use `cases = [...gates.tests.map(({ title, status, message }) => …), ...gates.browser.map((c) => ({ title: c.title, status: c.skipped ? 'skipped' : c.ok ? 'passed' : 'failed', message: c.message }))]`. vitest's `fullName` already includes the describe titles, so a tag in a `describe` block counts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/coverage.js src/council/correctness.js test/council-coverage.test.js test/council-correctness.test.js
git commit -m "feat(council): Correctness for client apps (foundation checks, every worked example tested, journeys, money)"
```
