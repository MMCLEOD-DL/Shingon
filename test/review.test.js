import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf, reviewLoop } from '../src/review.js';
import { makeResult } from '../src/result.js';

const approve = () => makeResult({ verdict: { decision: 'APPROVE', reason: '' } });
const block = (reason) => makeResult({ verdict: { decision: 'BLOCK', reason } });

test('verdictOf passes through a real verdict', () => {
  assert.deepEqual(verdictOf(approve()), { decision: 'APPROVE', reason: '', detail: '' });
  assert.deepEqual(verdictOf(block('bug')), { decision: 'BLOCK', reason: 'bug', detail: '' });
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

test('verdictOf carries the reviewer\'s full notes as detail (I3)', () => {
  const v = verdictOf(makeResult({ text: 'Long critique here.', verdict: { decision: 'BLOCK', reason: 'bug' } }));
  assert.deepEqual(v, { decision: 'BLOCK', reason: 'bug', detail: 'Long critique here.' });
  assert.ok(verdictOf(makeResult({ text: 'x'.repeat(10000), verdict: { decision: 'BLOCK', reason: 'r' } })).detail.length < 6100);
});

test('round 2 gets the reviewer body; history and lastReason keep the one-liner (I3)', async () => {
  const seen = [];
  const reviews = [makeResult({ text: 'Problem: f() returns null on empty input (see line 12).', verdict: { decision: 'BLOCK', reason: 'f() is wrong' } }), approve()];
  const r = await reviewLoop({
    produce: async (round, feedback, kind) => { seen.push({ feedback, kind }); return {}; },
    review: async () => reviews.shift(),
    maxRounds: 3,
  });
  assert.equal(seen[1].kind, 'blocked');
  assert.match(seen[1].feedback, /^f\(\) is wrong\n\nReviewer's full notes:\nProblem: f\(\) returns null on empty input \(see line 12\)\.$/);
  assert.equal(r.history[0].reason, 'f() is wrong');
});

test('a producer failure is fed back as kind "failed" (I4)', async () => {
  const kinds = [];
  await reviewLoop({
    produce: async (round, feedback, kind) => { kinds.push(kind); return round === 1 ? { error: 'crashed' } : {}; },
    review: async () => approve(),
    maxRounds: 2,
  });
  assert.deepEqual(kinds, [null, 'failed']);
});

// ---- Final-review fixes: Task 4 ledger minors ----

test('verdictOf tolerates a non-string reason (T4)', () => {
  assert.deepEqual(verdictOf(makeResult({ verdict: { decision: 'BLOCK', reason: 5 } })), { decision: 'BLOCK', reason: 'no reason given', detail: '' });
  assert.equal(verdictOf(makeResult({ verdict: { decision: 'APPROVE', reason: { x: 1 } } })).reason, '');
});

test('maxRounds must be a positive integer (T4)', async () => {
  for (const bad of [1.5, NaN, '2', -1]) {
    await assert.rejects(reviewLoop({ produce: async () => ({}), review: async () => approve(), maxRounds: bad }), /maxRounds/);
  }
});

test('a producer returning nothing is a BLOCK round and never lastGood (T4)', async () => {
  let reviewed = 0;
  const r = await reviewLoop({ produce: async () => null, review: async () => { reviewed++; return approve(); }, maxRounds: 2 });
  assert.equal(r.status, 'exhausted');
  assert.equal(reviewed, 0);
  assert.equal(r.lastGood, null);
  assert.match(r.lastReason, /producer returned nothing/);
});

test('round-1 error then exhaustion leaves lastGood null (T4)', async () => {
  const r = await reviewLoop({ produce: async () => ({ error: 'boom' }), review: async () => approve(), maxRounds: 1 });
  assert.equal(r.status, 'exhausted');
  assert.equal(r.lastGood, null);
});

test('a review that throws rejects reviewLoop (contract: callers wrap reviews with callRole) (T4)', async () => {
  await assert.rejects(reviewLoop({ produce: async () => ({}), review: async () => { throw new Error('kaput'); }, maxRounds: 2 }), /kaput/);
});
