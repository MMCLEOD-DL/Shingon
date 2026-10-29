# Task 9: Correctness for client apps, and Security's role-crossing evidence

On an ordinary repo Correctness and Security are unchanged (Plan 5 Tasks 2 and 4). On a project build (`input.brief` set) Correctness checks spec §2 item 2 ("numbers must be correct") and the brief, and Security gets the role-crossing harness results as its tool evidence (Contract 7.7). Correctness no longer reports role-crossing results: a failing test under `apps/server/test/crossing/` (`CROSSING_TEST = /^apps\/server\/test\/crossing\//`) is Security's, not a Correctness "tests fail".

1. **`verify`**: the foundation's checks, from wherever Task 6 got them (`gates.source.verify`). On project rounds this **replaces** Plan 5's `tests` ToolRun (the hook passes no local test result). Every finding is **locked blocking**.
   - **`'council'`** (the council's own run, Task 4): each failed step among `npm-ci`, `lint`, `typecheck`, `licences`, `vitest`, `build` is one finding, titled from the table below, with the step's log tail as detail. A failed `vitest` step counts only when a failed test lies outside `CROSSING_TEST`, or there is no test report.
   - **`'build'`** (Plan 8's `checks.verify`, reused): when its status is `failed`:
     - with the vitest cases: a failed test outside `CROSSING_TEST` → `The tests fail`, detail = up to 10 `<title>: <message>` lines. Only crossing tests failed → no Correctness finding (`npm run verify` chains with `&&`, so a vitest report means lint, types and licences passed);
     - with no vitest cases → `The foundation's checks fail (install, lint, types, licences or tests)`, detail = Plan 8's `summary`, then the last 40 lines of its `output`, redacted.
   - The web `build` step, when the browser gate was reused, is proven by the Playwright run itself, so there is no separate finding.
   - When neither source exists (`input.evidence.gates` is null, or `source.verify` is null), `verify` is `skipped`, with the note `The foundation's checks did not run in the council (<gatesNote>).`

   | Step | Title |
   |---|---|
   | `npm-ci` | `The app's packages could not be installed (npm ci failed)` |
   | `lint` | `The lint check fails` |
   | `typecheck` | `The type check fails` |
   | `licences` | `The licence check fails` |
   | `vitest` | `The tests fail` |
   | `build` | `The web app does not build` |

   `context`: `The foundation's checks came from <the build's whole-app run | the council's own run>.`
2. **`test-files`**: Plan 5's check, unchanged.
3. **`coverage`** (index Ruling 8). For each acceptance example from Plan 7's `acceptanceIds(brief)` (its stable `id`, never a position), the matching tests are the vitest and Playwright cases whose title contains `testTag(id)`. The feature title comes from `brief.features` by `featureId`.
   - **No match**, or every match skipped or todo → **locked blocking** `Worked example <id> has no test`. Detail: `Feature: <title>. Given <given>, when <when>, then <then>. Write a test whose title includes [<id>].`
   - **Any match failed** → **locked blocking** `Worked example <id> fails its test`. Detail: that test's title and message.
   - Otherwise the example is **proven**.
   - A feature with no examples → **locked warning** `Feature <id> has no worked examples`.
   - A tag in a test title naming an example the brief does not have → **note** `A test names worked example <id>, which the brief does not have`.

   `context`: `Worked examples proven: <p> of <t>.`, plus one line per example that is not proven. The ToolRun also carries `coverage: { proven, total }`, which Task 12 puts in the report. With no test report (the gates did not run) the ToolRun is `skipped`, with the **locked warning** `Brief coverage was not proven: there was no test report` (index Ruling 7).
4. **`journeys`**: each failed, non-skipped case in `flows.spec.ts` is a **locked blocking** finding `A user journey fails in the browser: <title> (<width>)`, using Task 8's width words. Skipped when there was no browser report.
5. **`money`**: a heuristic for floating-point money (BUILDING-ON: "whole pence in integers"). It scans `input.files` under `apps/server/src/`, `packages/shared/src/` and `apps/web/src/` (`.ts`, `.tsx`; not test files). A line counts when it names money (`/\b(amount|price|total|subtotal|vat|tax|cost|net|gross|fee|mileage|pence|pounds)\w*/i`) **and** does floating-point arithmetic (`parseFloat(`, `* <decimal literal>` such as `* 0.2`, or, outside `apps/web/`, `.toFixed(`). Each such file gets one **warning** `<file> may work out money in floating point instead of whole pence`, with its first line number and a count. At most 10.

The interpreter (Task 7, `FOCUS_PROJECT.correctness`) reads the brief and these measurements to look for untested money and permission paths. Whatever it adds without tool evidence is at most a warning.

**Security's `crossing` ToolRun** (project rounds only, after Plan 5's Security tools; index Ruling 6). It reads `input.evidence.gates.crossing` (from Plan 8's `crossing.json` or the council's own verify run):
- each failure sentence is one **locked blocking** finding `A role can reach data it should not: <sentence>` (at most 20, then one more `…and <k> more role-crossing failures`);
- no failures → a **note** `The role-crossing tests passed: <routes> routes, <checks> checks`;
- no report → ToolRun `skipped`, with the **locked warning** `The role-crossing tests were not proven: there was no report`.
`context`: `Role-crossing tests: <routes> routes, <checks> checks, <n> failures.` On an ordinary repo `SECURITY.collect` returns exactly Plan 5's ToolRuns.

**Files:**
- Create: `src/council/coverage.js`
- Modify: `src/council/correctness.js`, `src/council/security.js` (`SECURITY.collect`, `crossingFindings`)
- Test: `test/council-coverage.test.js` (new), `test/council-correctness.test.js` (append), `test/council-security.test.js` (append)

**Interfaces:**
- Consumes: `acceptanceIds`, `testTag` (`src/factory/acceptance.js`, Plan 7, index A5); `GatesResult` (Task 4); `Evidence` (Task 6, `input.evidence`); Plan 5's `testFindings`, `testFilesFinding`, `TEST_FILE`; Task 8's `WIDTH`; the gates fixtures.
- Produces:
  - `TAG_PATTERN = /\[([a-z0-9][a-z0-9-]*#\d+)\]/g` (`src/council/coverage.js`), used only to find tags naming ids the brief lacks; a test pins that it matches `testTag('mileage-claims#4')`. There is no local tag builder;
  - `coverageFindings(brief, cases) -> { findings, proven, total, lines: string[] }`, where `cases` is `[{ title, status: 'passed' | 'failed' | 'skipped' | 'todo', message }]`;
  - `CROSSING_TEST`, `verifyFindings(gates) -> Finding[]`, `journeyFindings(browser) -> Finding[]`, `moneyFindings({ dir, files }) -> Finding[]` (`src/council/correctness.js`);
  - `CORRECTNESS.collect(input)`: Plan 5's two ToolRuns when `!input.brief`; otherwise `verify`, `test-files`, `coverage`, `journeys`, `money`;
  - `crossingFindings(crossing) -> Finding[]` and the `crossing` ToolRun in `SECURITY.collect` (`src/council/security.js`).

- [ ] **Step 1: Write the failing tests**

Create `test/council-coverage.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageFindings, TAG_PATTERN } from '../src/council/coverage.js';
import { testTag } from '../src/factory/acceptance.js';
import { applyInterpretation } from '../src/council/interpret.js';

import { BRIEF } from './fixtures/council-full/brief.js';

test('each worked example needs a passing test that carries its tag', () => {
  const r = coverageFindings(BRIEF, [
    { title: '[mileage-claims#1] 120 miles at 45p comes to £54.00', status: 'failed', message: 'expected 5400, got 5399' },
    { title: 'claims > [mileage-claims#2] [mileage-claims#4] team only, and zero refused', status: 'passed' },
    { title: '[mileage-claims#3] an example removed from the brief', status: 'passed' },
  ]);
  assert.deepEqual([r.proven, r.total], [2, 3]);
  assert.deepEqual(r.findings.map((f) => [f.title, f.grade, f.locked]), [
    ['Worked example mileage-claims#1 fails its test', 'blocking', true],
    ['Feature receipts has no worked examples', 'warning', true],
    ['A test names worked example mileage-claims#3, which the brief does not have', 'note', false],
  ]);
  assert.match(r.findings[0].detail, /expected 5400, got 5399/);
  assert.deepEqual(r.lines, ['Worked examples proven: 2 of 3.', '- mileage-claims#1: its test fails']);
  assert.deepEqual([...testTag('mileage-claims#4').matchAll(TAG_PATTERN)].map((m) => m[1]), ['mileage-claims#4']);
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
    { title: '[mileage-claims#4 ] stray space', status: 'passed' },
  ]);
  assert.equal(r.proven, 0);
  assert.deepEqual(r.findings.map((f) => f.title), [
    'Worked example mileage-claims#1 has no test', 'Worked example mileage-claims#2 has no test', 'Worked example mileage-claims#4 has no test']);
  assert.match(r.findings[0].detail, /^Feature: Mileage claims\. Given a member, when they claim 120 miles, then the claim is £54\.00 at 45p a mile\. Write a test whose title includes \[mileage-claims#1\]\.$/);
});
```

Append to `test/council-correctness.test.js` (importing `CORRECTNESS`, `verifyFindings` from `../src/council/correctness.js`, the gates parsers and `BRIEF`):

```js
test('project build: verify, coverage, journeys and money run', async () => {
  const gates = { steps: { 'npm-ci': 0, lint: 0, typecheck: 0, licences: 0, vitest: 1, build: 0, browser: 1, a11y: null }, logs: { vitest: 'FAIL claims.test.ts' }, verify: null,
    source: { verify: 'council', browser: 'council', a11y: null },
    tests: parseVitestJson(fx('vitest.json')), browser: parsePlaywrightJson(fx('playwright.json')), crossing: { routes: 31, checks: 7012, failures: [] } };
  const runs = await CORRECTNESS.collect({ brief: BRIEF, dir: tmpDirWithMoneyFile, files: ['apps/server/src/claims/total.ts'], tests: null, evidence: { gates, gatesNote: null } });
  assert.deepEqual(runs.map((r) => r.tool), ['verify', 'test-files', 'coverage', 'journeys', 'money']);
  assert.deepEqual(runs[0].findings.map((f) => [f.title, f.grade, f.locked]), [['The tests fail', 'blocking', true]]);
  assert.match(runs[0].context, /came from the council's own run/);
  assert.doesNotMatch(runs.map((r) => r.context ?? '').join('\n'), /Role-crossing/);
  assert.deepEqual(runs[2].coverage, { proven: 1, total: 3 });
  assert.deepEqual(runs[3].findings.map((f) => f.title), ['A user journey fails in the browser: a member adds a note with a photo (desktop)']);
  assert.deepEqual(runs[4].findings.map((f) => [f.file, f.grade, f.maxGrade]), [['apps/server/src/claims/total.ts', 'warning', 'warning']]);
});

test('project build, verify reused from the build: a crossing-only failure is Security\'s, not Correctness\'s', async () => {
  const crossingOnly = [{ file: 'apps/server/test/crossing/crossing.test.ts', title: 'crossing > every role', status: 'failed', message: 'a member read a claim' }];
  const base = { steps: {}, logs: {}, browser: null, crossing: null, source: { verify: 'build', browser: null, a11y: null }, verify: { status: 'failed', summary: 'The tests fail.', output: 'x' } };
  assert.deepEqual(verifyFindings({ ...base, tests: crossingOnly }), []);
  assert.deepEqual(verifyFindings({ ...base, tests: null }).map((f) => [f.title, f.grade, f.locked]),
    [["The foundation's checks fail (install, lint, types, licences or tests)", 'blocking', true]]);
  assert.deepEqual(verifyFindings({ ...base, tests: [...crossingOnly, { file: 'apps/server/test/claims.test.ts', title: 'claims > x', status: 'failed', message: 'm' }] }).map((f) => f.title), ['The tests fail']);
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

`tmpDirWithMoneyFile` holds `apps/server/src/claims/total.ts` with `const total = miles * 0.45;`. `BRIEF` comes from `test/fixtures/council-full/brief.js` (Task 1), and `fx` reads the gates fixtures. The `vitest.json` fixture has `#1` failed and `#2` passed, and no `#4` case, so 1 of 3 is proven.

Append to `test/council-security.test.js`:
- `crossingFindings({ routes: 3, checks: 9, failures: ["A member could read another team's claim."] })` → one finding `A role can reach data it should not: A member could read another team's claim.`, `blocking`, `locked: true`, `tool: 'crossing'`, member `security`;
- `crossingFindings({ routes: 31, checks: 7012, failures: [] })` → one note `The role-crossing tests passed: 31 routes, 7012 checks`;
- `SECURITY.collect` with `brief` set and `evidence: { gates: null }` ends with a `crossing` ToolRun, `skipped`, holding the locked warning `The role-crossing tests were not proven: there was no report`;
- `SECURITY.collect` with no `brief` returns exactly Plan 5's tool list (no `crossing`);
- `applyInterpretation` cannot dismiss or lower a crossing block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-coverage.test.js test/council-correctness.test.js test/council-security.test.js`
Expected: FAIL.

- [ ] **Step 3: Implement** `src/council/coverage.js`, the additions to `src/council/correctness.js` and Security's `crossing` ToolRun exactly as described above. Use `cases = [...gates.tests.map(({ title, status, message }) => …), ...gates.browser.map((c) => ({ title: c.title, status: c.skipped ? 'skipped' : c.ok ? 'passed' : 'failed', message: c.message }))]`. vitest's `fullName` already includes the describe titles, so a tag in a `describe` block counts.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/coverage.js src/council/correctness.js src/council/security.js test/council-coverage.test.js test/council-correctness.test.js test/council-security.test.js
git commit -m "feat(council): Correctness for client apps (foundation checks, every worked example tested, journeys, money); Security gets the role-crossing results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
