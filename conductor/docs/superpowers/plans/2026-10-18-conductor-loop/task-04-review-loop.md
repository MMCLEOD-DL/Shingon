# Task 4: Review loop

One generic, capped produce → review → feedback loop. Plan phase, local chunk execution and the frontier fallback all use it. It **fails closed**: a reviewer that crashes, errors, or forgets the `VERDICT:` line counts as BLOCK.

**Files:**
- Create: `src/review.js`
- Test: `test/review.test.js`

**Interfaces:**
- Consumes: `makeResult` (Plan 1, tests only). A reviewer `Result` has `ok`, `error`, and `verdict: { decision: 'APPROVE' | 'BLOCK', reason } | null` (Plan 1 normalizer).
- Produces:
  - `verdictOf(result) -> { decision: 'APPROVE' | 'BLOCK', reason: string }`
  - `reviewLoop({ produce, review, maxRounds }) -> { status, artifact, lastGood, rounds, lastReason, history }`
    - `produce(round, feedback)` — `round` starts at 1; `feedback` is the previous BLOCK reason or `null`.
    - If the returned artifact has a truthy `.error`, review is skipped and the round is a BLOCK with reason `could not produce a result: <error>`.
    - `review(artifact, round) -> Result`.
    - `history: [{ round, decision, reason }]`; `lastGood`: most recent artifact without `.error`, else `null`.
    - Throws if `maxRounds < 1`. Exceptions from `produce`/`review` propagate (callers pass functions that don't throw — Task 6 `callRole`).

- [ ] **Step 1: Write the failing tests**

`test/review.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf, reviewLoop } from '../src/review.js';
import { makeResult } from '../src/result.js';

const approve = () => makeResult({ verdict: { decision: 'APPROVE', reason: '' } });
const block = (reason) => makeResult({ verdict: { decision: 'BLOCK', reason } });

test('verdictOf passes through a real verdict', () => {
  assert.deepEqual(verdictOf(approve()), { decision: 'APPROVE', reason: '' });
  assert.deepEqual(verdictOf(block('bug')), { decision: 'BLOCK', reason: 'bug' });
});

test('verdictOf fails closed', () => {
  assert.equal(verdictOf(makeResult({ text: 'looks good to me' })).decision, 'BLOCK');
  assert.match(verdictOf(makeResult({ text: 'looks good' })).reason, /no VERDICT line/);
  assert.match(verdictOf(makeResult({ ok: false, error: 'exit 1' })).reason, /reviewer failed: exit 1/);
  assert.match(verdictOf(null).reason, /reviewer failed/);
  assert.match(verdictOf(block('')).reason, /no reason given/);
});

test('approves on the first round', async () => {
  const r = await reviewLoop({ produce: async () => ({ v: 1 }), review: async () => approve(), maxRounds: 3 });
  assert.equal(r.status, 'approved');
  assert.equal(r.rounds, 1);
  assert.deepEqual(r.artifact, { v: 1 });
});

test('feeds the block reason back to the producer', async () => {
  const seen = [];
  const reviews = [block('missing test'), approve()];
  const r = await reviewLoop({
    produce: async (round, feedback) => { seen.push([round, feedback]); return { round }; },
    review: async () => reviews.shift(),
    maxRounds: 3,
  });
  assert.deepEqual(seen, [[1, null], [2, 'missing test']]);
  assert.equal(r.status, 'approved');
  assert.equal(r.rounds, 2);
  assert.deepEqual(r.history.map((h) => h.decision), ['BLOCK', 'APPROVE']);
});

test('exhausts after maxRounds with the last reason', async () => {
  let n = 0;
  const r = await reviewLoop({ produce: async () => ({}), review: async () => block(`no ${++n}`), maxRounds: 2 });
  assert.equal(r.status, 'exhausted');
  assert.equal(r.rounds, 2);
  assert.equal(r.lastReason, 'no 2');
});

test('a reviewer with no VERDICT line never approves', async () => {
  const r = await reviewLoop({ produce: async () => ({}), review: async () => makeResult({ text: 'LGTM!' }), maxRounds: 2 });
  assert.equal(r.status, 'exhausted');
});

test('producer error skips review, feeds the error back, and is not lastGood', async () => {
  let reviewed = 0;
  const outputs = [{ ok: 1 }, { error: 'bad json' }];
  const fb = [];
  const r = await reviewLoop({
    produce: async (round, feedback) => { fb.push(feedback); return outputs[round - 1]; },
    review: async () => { reviewed++; return block('weak'); },
    maxRounds: 2,
  });
  assert.equal(reviewed, 1);
  assert.equal(r.status, 'exhausted');
  assert.match(r.lastReason, /could not produce a result: bad json/);
  assert.deepEqual(fb, [null, 'weak']);
  assert.deepEqual(r.lastGood, { ok: 1 });
  assert.deepEqual(r.artifact, { error: 'bad json' });
});

test('maxRounds below 1 throws', async () => {
  await assert.rejects(reviewLoop({ produce: async () => ({}), review: async () => approve(), maxRounds: 0 }), /maxRounds/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/review.js` not found.

- [ ] **Step 3: Implement**

`src/review.js`:

```js
// src/review.js
// Fail closed: anything other than an explicit APPROVE from a healthy reviewer is a BLOCK.
export function verdictOf(result) {
  if (!result || result.ok !== true) {
    return { decision: 'BLOCK', reason: `reviewer failed: ${result?.error ?? 'no result'}` };
  }
  const v = result.verdict;
  if (!v || (v.decision !== 'APPROVE' && v.decision !== 'BLOCK')) {
    return { decision: 'BLOCK', reason: 'reviewer gave no VERDICT line' };
  }
  if (v.decision === 'BLOCK') return { decision: 'BLOCK', reason: v.reason?.trim() || 'no reason given' };
  return { decision: 'APPROVE', reason: v.reason ?? '' };
}

export async function reviewLoop({ produce, review, maxRounds }) {
  if (!(maxRounds >= 1)) throw new Error(`maxRounds must be >= 1 (got ${maxRounds})`);
  const history = [];
  let feedback = null;
  let artifact = null;
  let lastGood = null;
  let lastReason = '';

  for (let round = 1; round <= maxRounds; round++) {
    artifact = await produce(round, feedback);
    let v;
    if (artifact?.error) {
      v = { decision: 'BLOCK', reason: `could not produce a result: ${artifact.error}` };
    } else {
      lastGood = artifact;
      v = verdictOf(await review(artifact, round));
    }
    history.push({ round, ...v });
    lastReason = v.reason;
    if (v.decision === 'APPROVE') return { status: 'approved', artifact, lastGood, rounds: round, lastReason, history };
    feedback = v.reason;
  }
  return { status: 'exhausted', artifact, lastGood, rounds: maxRounds, lastReason, history };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/review.js test/review.test.js
git commit -m "feat: generic capped review loop that fails closed"
```
