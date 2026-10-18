# Task 5: Deadlock settlement & escalation text

When two frontier models still disagree after the cap, Conductor settles it by **evidence**: if anything is unsafe or unproven it escalates to the user, otherwise it accepts and records a note. Escalations and the end-of-run summary are plain English: the user decides outcomes, never technical correctness.

**Files:**
- Create: `src/deadlock.js`, `src/escalation.js`
- Test: `test/deadlock.test.js`, `test/escalation.test.js`

**Interfaces:**
- Consumes: `IRREVERSIBLE_MARK` from `src/prompts.js` (Task 3). `tests` objects from `Workspace.runTests` (Task 2): `{ ran, passed, code, output }`.
- Produces:
  - `settleDeadlock({ reason, tests = null, produced = true }) -> { action: 'accept' | 'escalate', note, recommendation }` (`recommendation` is a plain-English sentence for escalations, `null` when accepted). Rules, first match wins:
    1. `produced === false` → escalate (no usable result exists).
    2. reason starts with `reviewer failed` or `reviewer gave no VERDICT` → escalate (work was never actually reviewed).
    3. `tests.ran && tests.passed === false` → escalate.
    4. reason contains `IRREVERSIBLE:` (any case) → escalate.
    5. otherwise → accept; the note records the overridden objection.
  - `buildEscalation({ kind: 'plan' | 'chunk' | 'final', title, reason, recommendation }) -> { kind, title, message, options: ['approve', 'reject'] }`
  - `buildSummary({ request, plan, notes = [], files = [], tests = null }) -> string`
  - `plainReason(reason) -> string` — strips the `IRREVERSIBLE:` marker.

- [ ] **Step 1: Write the failing tests**

`test/deadlock.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settleDeadlock } from '../src/deadlock.js';

const pass = { ran: true, passed: true, code: 0, output: '' };
const fail = { ran: true, passed: false, code: 1, output: 'x' };

test('reversible disagreement with passing tests is accepted with a note', () => {
  const r = settleDeadlock({ reason: 'prefer a map over a loop', tests: pass });
  assert.equal(r.action, 'accept');
  assert.match(r.note, /prefer a map over a loop/);
});

test('no tests configured still accepts a reversible disagreement', () => {
  assert.equal(settleDeadlock({ reason: 'naming', tests: { ran: false } }).action, 'accept');
  assert.equal(settleDeadlock({ reason: 'naming' }).action, 'accept');
});

test('failing tests escalate', () => {
  const r = settleDeadlock({ reason: 'naming', tests: fail });
  assert.equal(r.action, 'escalate');
  assert.match(r.note, /tests are failing/i);
  assert.match(r.recommendation, /^Reject/);
});

test('accepted settlements carry no recommendation', () => {
  assert.equal(settleDeadlock({ reason: 'naming' }).recommendation, null);
});

test('IRREVERSIBLE marker escalates, any case', () => {
  assert.equal(settleDeadlock({ reason: 'IRREVERSIBLE: drops the users table', tests: pass }).action, 'escalate');
  assert.equal(settleDeadlock({ reason: 'irreversible: renames public API', tests: pass }).action, 'escalate');
});

test('unreviewed or unproduced work escalates', () => {
  assert.equal(settleDeadlock({ reason: 'reviewer failed: exit 1', tests: pass }).action, 'escalate');
  assert.equal(settleDeadlock({ reason: 'reviewer gave no VERDICT line', tests: pass }).action, 'escalate');
  assert.equal(settleDeadlock({ reason: 'whatever', tests: pass, produced: false }).action, 'escalate');
});
```

`test/escalation.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEscalation, buildSummary, plainReason } from '../src/escalation.js';

test('plainReason strips the marker', () => {
  assert.equal(plainReason('IRREVERSIBLE: deletes data'), 'deletes data');
  assert.equal(plainReason('fine'), 'fine');
});

test('escalation is plain English with approve/reject and no marker', () => {
  const e = buildEscalation({ kind: 'chunk', title: 'Step 2: migrate data', reason: 'IRREVERSIBLE: drops a column', recommendation: 'Approve: the column is unused.' });
  assert.equal(e.kind, 'chunk');
  assert.deepEqual(e.options, ['approve', 'reject']);
  assert.match(e.message, /Step 2: migrate data/);
  assert.match(e.message, /drops a column/);
  assert.doesNotMatch(e.message, /IRREVERSIBLE/);
  assert.match(e.message, /Recommendation: Approve: the column is unused\./);
  assert.match(e.message, /reject to stop/i);
});

test('each kind has its own explanation', () => {
  const msgs = ['plan', 'chunk', 'final'].map((kind) => buildEscalation({ kind, title: 't', reason: 'r', recommendation: 'x' }).message);
  assert.equal(new Set(msgs).size, 3);
});

test('summary lists steps, files, tests and notes', () => {
  const s = buildSummary({
    request: 'CSV export',
    plan: { summary: 's', chunks: [{ title: 'Backend' }, { title: 'UI' }] },
    notes: ['Accepted over an objection: naming'],
    files: ['a.js', 'b.js'],
    tests: { ran: true, passed: true },
  });
  assert.match(s, /CSV export/);
  assert.match(s, /1\. Backend[\s\S]*2\. UI/);
  assert.match(s, /Files changed \(2\): a\.js, b\.js/);
  assert.match(s, /Tests: passing/);
  assert.match(s, /naming/);
});

test('summary caps a long file list and handles no tests / no notes', () => {
  const files = Array.from({ length: 35 }, (_, i) => `f${i}`);
  const s = buildSummary({ request: 'r', plan: { chunks: [] }, files });
  assert.match(s, /\+ 5 more/);
  assert.match(s, /Tests: not configured/);
  assert.doesNotMatch(s, /Notes:/);
  assert.match(buildSummary({ request: 'r', plan: { chunks: [] }, tests: { ran: true, passed: false } }), /Tests: FAILING/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/deadlock.js`:

```js
// src/deadlock.js
// Frontier-vs-frontier deadlock: evidence first; only reversible, tested,
// actually-reviewed work is accepted without asking the user.
import { IRREVERSIBLE_MARK } from './prompts.js';

const UNREVIEWED = /^(reviewer failed|reviewer gave no VERDICT)/;

export function settleDeadlock({ reason, tests = null, produced = true }) {
  const r = String(reason ?? '');
  const escalate = (note, recommendation) => ({ action: 'escalate', note, recommendation });
  if (!produced) return escalate(`No usable result was produced. Last problem: ${r}`, 'Reject: there is nothing usable to continue with.');
  if (UNREVIEWED.test(r)) return escalate(`The work could not be reviewed: ${r}`, 'Reject: this work was never successfully checked.');
  if (tests?.ran && tests.passed === false) return escalate(`Tests are failing and the reviewers still disagree: ${r}`, 'Reject: the tests do not pass.');
  if (r.toUpperCase().includes(IRREVERSIBLE_MARK)) {
    return escalate(`The reviewer flagged a hard-to-undo concern: ${r}`, 'Reject, unless you are sure this change is what you want; it is hard to undo.');
  }
  const evidence = tests?.ran ? 'tests pass' : 'no tests configured';
  return { action: 'accept', note: `Accepted over an unresolved reviewer objection (reversible, ${evidence}): ${r}`, recommendation: null };
}
```

`src/escalation.js`:

```js
// src/escalation.js
import { IRREVERSIBLE_MARK } from './prompts.js';

const WHAT_HAPPENED = {
  plan: 'The two AI reviewers could not agree on the plan within the allowed rounds.',
  chunk: 'The two AI reviewers could not agree on one step of the work within the allowed rounds.',
  final: 'The final check of the finished work raised a concern.',
};

export function plainReason(reason) {
  const r = String(reason ?? '').trim();
  return r.toUpperCase().startsWith(IRREVERSIBLE_MARK) ? r.slice(IRREVERSIBLE_MARK.length).trim() : r;
}

export function buildEscalation({ kind, title, reason, recommendation }) {
  const message = [
    `Conductor needs your decision on: ${title}`,
    `What happened: ${WHAT_HAPPENED[kind] ?? WHAT_HAPPENED.chunk}`,
    `The concern: ${plainReason(reason)}`,
    `Recommendation: ${recommendation}`,
    'Approve to continue with the current version, or reject to stop the run. Nothing in your repository changes either way until the final approval.',
  ].join('\n\n');
  return { kind, title, message, options: ['approve', 'reject'] };
}

export function buildSummary({ request, plan, notes = [], files = [], tests = null }) {
  const steps = (plan?.chunks ?? []).map((c, i) => `  ${i + 1}. ${c.title}`);
  const shown = files.slice(0, 30).join(', ');
  const more = files.length > 30 ? ` + ${files.length - 30} more` : '';
  const testLine = !tests?.ran ? 'not configured' : tests.passed ? 'passing' : 'FAILING';
  const lines = [
    `Request: ${request}`,
    `What was done (${steps.length} steps):`,
    ...steps,
    `Files changed (${files.length}): ${shown}${more}`,
    `Tests: ${testLine}`,
  ];
  if (notes.length) lines.push('Notes:', ...notes.map((n) => `  - ${n}`));
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deadlock.js src/escalation.js test/deadlock.test.js test/escalation.test.js
git commit -m "feat: evidence-based deadlock settlement and plain-English escalations"
```
