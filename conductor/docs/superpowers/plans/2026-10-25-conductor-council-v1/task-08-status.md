# Task 8: Status view

The live status (MVP spec §8) gains a **Council** line, and fix steps appear in the step list as they are queued. The final check stops claiming "waiting for your approval" while the council is still working.

```
  ✓ Plan agreed                       claude drafted · codex reviewed (1 round)
  ✓ Step 1/2   Add parser             local ✎ · codex reviewed ✓
    Step 2/2   Council fixes, round 1 queued
  ↺ Council (round 1)                 2 problems sent back to be fixed
  frontier cost reported so far: ~$0.00 · local steps: 1
```

**Files:**
- Modify: `src/ui/status.js`
- Test: `test/status-council.test.js` (new)

**Interfaces:**
- Consumes:
  - the Task 6 and Task 7 events: `council-start`, `council-member`, `council-verdict`, `council-fix`;
  - the existing `decision { kind, decision }` event from `askUser`;
  - `MEMBER_LABEL` (Task 1).
- Produces: `StatusModel` handles those events. `lines()` adds the council line directly after the final-check line, or after the steps while a fix is running. The final check gains the status `reviewed`, shown as `✓ … <reviewer> reviewed ✓`.

- [ ] **Step 1: Write the failing tests**

Create `test/status-council.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusModel } from '../src/ui/status.js';

const run = (events) => { const m = new StatusModel(); for (const e of events) m.apply(e); return m.lines(); };
const BUILT = [
  { type: 'plan-agreed', chunks: ['Add parser'], rounds: 1, author: 'claude', reviewer: 'codex' },
  { type: 'chunk', index: 0, title: 'Add parser' },
  { type: 'call', participant: 'local', role: 'grunt', write: true },
  { type: 'result', participant: 'local', servedBy: 'local', role: 'grunt', ok: true },
  { type: 'call', participant: 'codex', role: 'reviewer', write: false },
  { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true },
  { type: 'chunk-done', index: 0, by: 'local' },
  { type: 'phase', name: 'final' },
  { type: 'call', participant: 'codex', role: 'reviewer', write: false },
  { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true },
];
const ROUND1 = [
  ...BUILT,
  { type: 'council-start', round: 1, members: ['security', 'legal', 'correctness'] },
  { type: 'council-member', member: 'security', stage: 'tools' },
];

test('while the council works, the final check says reviewed, not waiting for approval', () => {
  const lines = run(ROUND1);
  assert.equal(lines[2], '  ✓ Final check                       codex reviewed ✓');
  assert.equal(lines[3], '  ⟳ Council (round 1)                 Security running its checks…');
  const interp = run([...ROUND1,
    { type: 'council-member', member: 'correctness', stage: 'interpreting' },
    { type: 'call', participant: 'claude-backup', role: 'reviewer', write: false }]);
  assert.equal(interp[2], '  ✓ Final check                       codex reviewed ✓', 'a council call does not rename the final reviewer');
  assert.equal(interp[3], '  ⟳ Council (round 1)                 Correctness: claude-backup reading the findings…');
});

test('blocked with rounds left: the fix step is queued and the council line says so', () => {
  assert.deepEqual(run([...ROUND1,
    { type: 'council-verdict', round: 1, verdict: 'blocked', blocking: 2, warning: 0, note: 0 },
    { type: 'council-fix', round: 1, title: 'Council fixes, round 1', blocking: 2 }]), [
    '  ✓ Plan agreed                       claude drafted · codex reviewed (1 round)',
    '  ✓ Step 1/2   Add parser             local ✎ · codex reviewed ✓',
    '    Step 2/2   Council fixes, round 1 queued',
    '  ↺ Council (round 1)                 2 problems sent back to be fixed',
    '  frontier cost reported so far: ~$0.00 · local steps: 1',
  ]);
});

test('round 2 approved: the gate waits; landing ticks the final check', () => {
  const round2 = [...ROUND1,
    { type: 'council-verdict', round: 1, verdict: 'blocked', blocking: 2, warning: 0, note: 0 },
    { type: 'council-fix', round: 1, title: 'Council fixes, round 1', blocking: 2 },
    { type: 'chunk', index: 1, title: 'Council fixes, round 1' },
    { type: 'chunk-done', index: 1, by: 'local' },
    { type: 'phase', name: 'final' },
    { type: 'result', participant: 'codex', servedBy: 'codex', role: 'reviewer', ok: true }];
  assert.equal(run(round2)[3], '  ✓ Final check                       codex reviewed ✓', 'a known council means the gate is not next yet');
  const approved = [...round2,
    { type: 'council-start', round: 2, members: [] },
    { type: 'council-verdict', round: 2, verdict: 'approved-with-warnings', blocking: 0, warning: 1, note: 0 }];
  const lines = run(approved);
  assert.equal(lines[3], '  ⟳ Final check                       waiting for your approval');
  assert.equal(lines[4], '  ✓ Council (round 2)                 approved · 1 warning');
  assert.equal(run([...approved, { type: 'finish', status: 'landed' }])[3], '  ✓ Final check                       done');
});

test('still blocking at the cap: shown plainly; approving the escalation moves on to the gate', () => {
  const stuck = [...ROUND1, { type: 'council-verdict', round: 1, verdict: 'blocked', blocking: 1, warning: 0, note: 0 }];
  assert.equal(run(stuck)[3], '  ✗ Council (round 1)                 1 problem still blocking');
  assert.equal(run([...stuck, { type: 'decision', kind: 'council', title: 'the council review', decision: 'approve' }])[2],
    '  ⟳ Final check                       waiting for your approval');
});

test('a run that ends while the council is working does not look busy', () => {
  assert.equal(run([...ROUND1, { type: 'finish', status: 'paused' }])[3], '  ⏸ Council (round 1)                 paused');
  assert.equal(run([...ROUND1, { type: 'finish', status: 'failed' }])[3], '  ✗ Council (round 1)                 failed');
  assert.equal(run([...ROUND1, { type: 'finish', status: 'interrupted' }])[3], '  ✗ Council (round 1)                 stopped');
  const done = [...ROUND1, { type: 'council-verdict', round: 1, verdict: 'approved', blocking: 0, warning: 0, note: 0 }, { type: 'finish', status: 'rejected' }];
  assert.equal(run(done)[3], '  ✓ Council (round 1)                 approved', 'a finished council keeps its verdict');
});

test('no council: the final check behaves exactly as before', () => {
  assert.equal(run(BUILT)[2], '  ⟳ Final check                       waiting for your approval');
  assert.equal(run(BUILT).some((l) => l.includes('Council')), false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/status-council.test.js`
Expected: FAIL. There is no council line, and the final check shows `waiting for your approval` during the council.

- [ ] **Step 3: Implement in `src/ui/status.js`**

- Import `MEMBER_LABEL` from `../council/findings.js`, add `ICON.fixing = '↺'`, and set `this.council = null` in the constructor.
- `call`: when `this.council?.status === 'running'`, set `this.council.by = e.participant` and **do nothing else**. Otherwise the existing branches run.
- `result`: still add up the cost first. When the council is running, do nothing more. In the final branch, a reviewer result sets `final.reviewer = who` and `final.status = this.council ? 'reviewed' : 'gate'`.
- `council-start`: set `this.council = { status: 'running', round: e.round, member: null, stage: null, by: null }`. When `this.final` exists, set its status to `'reviewed'`.
- `council-member`: set `member` and `stage`, and reset `by = null` when the stage is `tools`.
- `council-verdict`: set `status` to `'blocked'` or `'done'`, and copy `blocking` and `warning`. On `'done'` with a final, set `final.status = 'gate'`.
- `council-fix`: push `{ title: e.title, status: 'queued' }` onto `this.chunks`, set `council.status = 'fixing'`, and set `this.final = null`.
- `decision`: when `e.kind === 'council' && e.decision === 'approve' && this.final`, set `final.status = 'gate'`.
- `finish`: keep the existing final-line handling. In addition, when `this.council?.status === 'running'`, set `this.council.status = 'ended'` and `this.council.ending` to `e.status` when it is `paused` or `failed`, otherwise `stopped`. A council that already has a verdict keeps it.
- `lines()`:
  - **Final line.** A final status of `'reviewed'` renders `line(ICON.done, pad('Final check', DETAIL_COL), `${f.reviewer ?? 'the reviewer'} reviewed ✓`)`.
  - **Council line.** After the final block (or straight after the steps when `final` is null), when `this.council` is set, render `line(icon, pad(`Council (round ${c.round})`, DETAIL_COL), detail)` with:
    - `running` → `⟳`. The detail is `` `${MEMBER_LABEL[c.member]}: ${c.by ?? 'the AI'} reading the findings…` `` while interpreting, `` `${MEMBER_LABEL[c.member]} running its checks…` `` for tools, or `starting…` before any member.
    - `done` → `✓`, `'approved'`, plus `` ` · ${n} warning${n === 1 ? '' : 's'}` `` when `warning > 0`.
    - `blocked` → `✗`, `` `${n} problem${n === 1 ? '' : 's'} still blocking` ``.
    - `fixing` → `↺`, `` `${n} problem${n === 1 ? '' : 's'} sent back to be fixed` ``.
    - `ended` → `FINAL_ENDINGS[c.ending].icon` and `FINAL_ENDINGS[c.ending].text` (`⏸ paused`, `✗ failed`, `✗ stopped`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/status-council.test.js test/status.test.js && npm test`
Expected: all PASS, with the existing status tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/ui/status.js test/status-council.test.js
git commit -m "feat(council): status line for the council and queued fix steps"
```
