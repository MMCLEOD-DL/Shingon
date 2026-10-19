import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/prompts.js';

const plan = { summary: 'Add export', chunks: [{ title: 'Backend', instructions: 'add route' }, { title: 'UI', instructions: 'add button' }] };

test('formatTests covers the three states', () => {
  assert.match(P.formatTests({ ran: false }), /not configured/);
  assert.match(P.formatTests({ ran: true, passed: true, code: 0, output: 'ok' }), /PASSED/);
  const f = P.formatTests({ ran: true, passed: false, code: 4, output: 'boom' });
  assert.match(f, /FAILED \(exit 4\)/);
  assert.match(f, /boom/);
});

test('planAuthor includes request, chunk cap, json shape, and feedback only when given', () => {
  const a = P.planAuthor({ request: 'CSV export', maxChunks: 7 });
  assert.match(a, /CSV export/);
  assert.match(a, /At most 7 chunks/);
  assert.match(a, /```json/);
  assert.doesNotMatch(a, /blocked your previous plan/);
  assert.match(P.planAuthor({ request: 'r', maxChunks: 7, feedback: 'too big' }), /blocked your previous plan[\s\S]*too big/);
});

test('review prompts explain the IRREVERSIBLE marker', () => {
  assert.match(P.planReview({ request: 'r', planText: 'p' }), new RegExp(P.IRREVERSIBLE_MARK));
  assert.match(P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: 'd', tests: { ran: false } }), /IRREVERSIBLE:/);
  assert.match(P.finalReview({ request: 'r', plan, diff: 'd', tests: { ran: false } }), /IRREVERSIBLE:/);
});

test('chunkExec numbers the chunk from 1 and carries feedback', () => {
  const e = P.chunkExec({ request: 'r', plan, chunk: plan.chunks[1], index: 1, total: 2, feedback: 'missing test' });
  assert.match(e, /chunk 2 of 2: UI/);
  assert.match(e, /add button/);
  assert.match(e, /missing test/);
  assert.match(e, /Do not commit/);
});

test('chunkReview includes the diff and test result, and clips huge diffs', () => {
  const r = P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: '+line', tests: { ran: true, passed: false, code: 1, output: 'F' } });
  assert.match(r, /\+line/);
  assert.match(r, /FAILED/);
  const big = P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: 'x'.repeat(100000), tests: { ran: false } });
  assert.ok(big.length < 50000);
  assert.match(big, /chars clipped/);
});

test('failure feedback is not framed as a reviewer block (I4)', () => {
  const plan = P.planAuthor({ request: 'r', maxChunks: 3, feedback: 'could not produce a result: plan has no chunks', feedbackKind: 'failed' });
  assert.match(plan, /Your previous reply could not be used as a plan: plan has no chunks/);
  assert.doesNotMatch(plan, /blocked/);
  const exec = P.chunkExec({ request: 'r', plan: { summary: '', chunks: [{ title: 'A', instructions: 'a' }] }, chunk: { title: 'A', instructions: 'a' }, index: 0, total: 1, feedback: 'could not produce a result: local failed: timed out', feedbackKind: 'failed' });
  assert.match(exec, /Your previous attempt did not finish \(local failed: timed out\)/);
  assert.doesNotMatch(exec, /blocked by the reviewer/);
});
