# Task 4: Correctness member

On an ordinary repo, Correctness checks "the tests plus the request" (spec §8 item 2):

- **Tests failing.** The project's test command fails on the finished change. This is a **locked blocking** finding, and no interpretation can wave it away. The result is the one the final phase already ran on the same commit, so nothing runs twice.
- **Tests that already failed before.** When the test command also failed on the starting commit (`input.baseTests`, worked out once by Task 6, index Ruling 5), the finding is a **locked warning** marked "already there before this change" instead. Conductor cannot tell old failures from new ones, so the operator is told plainly, but no fix round is spent on a suite that was red to begin with.
- **No test command.** This is a note. Correctness could then only judge by reading.
- **No tests.** Code changed but no test file did. This is a **warning**, with a ceiling of warning (the interpreter cannot raise it). The evidence is the list of changed files.
- **The request.** Whether the change actually does what was asked is the LLM's job (Task 5). It always runs for this member (`alwaysInterpret: true`), and anything it finds without tool evidence can only warn.

**Files:**
- Create: `src/council/correctness.js`
- Test: `test/council-correctness.test.js` (new)

**Interfaces:**
- Consumes: `makeFinding` and `TOOL_LABEL` (Task 1); `CouncilInput.tests`, which is the `{ ran, passed, code, output }` object from `ws.runTests`; `CouncilInput.baseTests` (`{ ran, passed, code }` at `baseSha`, or null).
- Produces:
  - `TEST_FILE`, a RegExp;
  - `testFindings(tests, baseTests = null) -> Finding[]`;
  - `testFilesFinding(files) -> Finding[]`;
  - `CORRECTNESS = { member: 'correctness', label: 'Correctness', alwaysInterpret: true, collect(input) }`. `collect` returns `ToolRun`s in the order `tests`, `test-files`.

- [ ] **Step 1: Write the failing tests**

Create `test/council-correctness.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FILE, testFindings, testFilesFinding, CORRECTNESS } from '../src/council/correctness.js';

test('TEST_FILE recognises the usual test locations', () => {
  for (const f of ['test/a.js', 'src/__tests__/x.ts', 'a.test.mjs', 'b.spec.tsx', 'pkg/x_test.go', 'tests/test_y.py', 'spec/z.rb'])
    assert.ok(TEST_FILE.test(f), f);
  for (const f of ['src/a.js', 'latest.js', 'contest/a.js', 'README.md']) assert.ok(!TEST_FILE.test(f), f);
});

test('failing tests: one locked blocking finding carrying the output', () => {
  const [f] = testFindings({ ran: true, passed: false, code: 1, output: 'not ok 3 - totals\nexpected 12.40' });
  assert.equal(f.grade, 'blocking');
  assert.equal(f.locked, true);
  assert.equal(f.tool, 'tests');
  assert.equal(f.title, 'The tests fail (exit code 1)');
  assert.match(f.detail, /expected 12\.40/);
  assert.deepEqual(testFindings({ ran: true, passed: true, code: 0, output: '' }), []);
  const [none] = testFindings({ ran: false, passed: null, code: null, output: '' });
  assert.equal(none.grade, 'note');
  assert.equal(none.title, 'No test command is set, so Correctness could only judge the change by reading it');
});

test('tests that already failed at the starting commit: a locked warning, not a block (Ruling 5)', () => {
  const failing = { ran: true, passed: false, code: 1, output: 'not ok 1' };
  const [f] = testFindings(failing, { ran: true, passed: false, code: 1 });
  assert.deepEqual([f.grade, f.maxGrade, f.locked, f.preExisting], ['warning', 'warning', true, true]);
  assert.equal(f.title, 'The tests fail (exit code 1), but they already failed before this change');
  assert.match(f.detail, /cannot tell whether this change broke anything more/);
  assert.equal(testFindings(failing, { ran: true, passed: true, code: 0 })[0].grade, 'blocking', 'green before, red now: blocks');
  assert.equal(testFindings(failing, null)[0].grade, 'blocking');
});

test('code changed without any test changing is a warning; docs-only changes are not', () => {
  const [w] = testFilesFinding(['src/a.js', 'README.md']);
  assert.equal(w.grade, 'warning');
  assert.equal(w.tool, 'test-files');
  assert.equal(w.title, 'The change adds or edits no tests');
  assert.deepEqual(testFilesFinding(['src/a.js', 'test/a.test.js']), []);
  assert.deepEqual(testFilesFinding(['README.md', 'docs/x.md', 'notes.txt']), []);
  assert.deepEqual(testFilesFinding([]), []);
});

test('CORRECTNESS.collect reuses the final-phase test result; no test command → skipped', async () => {
  const runs = await CORRECTNESS.collect({ files: ['src/a.js'], tests: { ran: true, passed: false, code: 2, output: 'boom' } });
  assert.deepEqual(runs.map((r) => [r.tool, r.status, r.findings.map((f) => f.grade)]), [
    ['tests', 'ran', ['blocking']],
    ['test-files', 'ran', ['warning']],
  ]);
  const old = await CORRECTNESS.collect({ files: ['src/a.js'], tests: { ran: true, passed: false, code: 2, output: 'boom' }, baseTests: { ran: true, passed: false, code: 2 } });
  assert.equal(old[0].findings[0].grade, 'warning');
  const none = await CORRECTNESS.collect({ files: [], tests: { ran: false } });
  assert.equal(none[0].status, 'skipped');
  assert.equal(none[0].findings[0].grade, 'note');
  assert.equal(CORRECTNESS.alwaysInterpret, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-correctness.test.js`
Expected: FAIL with `Cannot find module '../src/council/correctness.js'`.

- [ ] **Step 3: Implement `src/council/correctness.js`**

- `TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/`.
- `DOC_FILE = /\.(md|txt|rst|adoc)$|(^|\/)docs?\//i`.
- `testFindings(tests, baseTests = null)`:
  - Tests did not run → a `note` finding with `tool: 'tests'` and the exact title in the test.
  - Tests ran and failed, and `baseTests?.ran && baseTests.passed === false` → `makeFinding({ member: 'correctness', tool: 'tests', grade: 'warning', locked: true, preExisting: true, title: `The tests fail (exit code ${tests.code}), but they already failed before this change`, detail: `They also failed on the starting commit, so Conductor cannot tell whether this change broke anything more. Read the output:\n${tests.output}` })`.
  - Tests ran and failed otherwise → `makeFinding({ member: 'correctness', tool: 'tests', grade: 'blocking', locked: true, title: `The tests fail (exit code ${tests.code})`, detail: tests.output })`.
  - Tests passed → `[]`.
- `testFilesFinding(files)`:
  - Let `code` be the files that are neither `TEST_FILE` nor `DOC_FILE`.
  - When `code.length && !files.some((f) => TEST_FILE.test(f))`, return one warning with `tool: 'test-files'`, the exact title in the test, and `detail: `Changed without tests: ${code.slice(0, 10).join(', ')}``.
  - Otherwise `[]`.
- `CORRECTNESS.collect(input)` returns two `ToolRun`s:
  - `tests`: status `input.tests?.ran ? 'ran' : 'skipped'`, `findings: testFindings(input.tests, input.baseTests ?? null)`, `note: null` (the "no test command" note finding already says it; Task 6's report skips null notes);
  - `test-files`: status `'ran'`, `findings: testFilesFinding(input.files)`, `note: null`.

  Labels come from `TOOL_LABEL`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-correctness.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/correctness.js test/council-correctness.test.js
git commit -m "feat(council): Correctness member (tests as locked evidence, test coverage check)"
```
