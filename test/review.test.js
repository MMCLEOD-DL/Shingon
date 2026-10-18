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
