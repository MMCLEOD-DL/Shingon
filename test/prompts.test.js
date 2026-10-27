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

test('an empty diff shows "(no changes)" in both review prompts (T3)', () => {
  assert.match(P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: '', tests: { ran: false } }), /Diff for this chunk:\n\(no changes\)/);
  assert.match(P.finalReview({ request: 'r', plan, diff: '', tests: { ran: false } }), /finished branch:\n\(no changes\)/);
});

test('request, instructions and feedback are clipped (T3)', () => {
  const huge = 'q'.repeat(50000);
  const e = P.chunkExec({ request: huge, plan, chunk: { title: 'T', instructions: huge }, index: 0, total: 1, feedback: huge });
  assert.ok(e.length < 30000);
  assert.ok(P.planAuthor({ request: huge, maxChunks: 3, feedback: huge }).length < 20000);
});

test('a shortened diff tells the reviewer where the full change is and to BLOCK if unsure (T8-M5)', () => {
  const small = P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: '+x', tests: { ran: false }, base: 'abc123' });
  assert.doesNotMatch(small, /was shortened/);
  const big = P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: 'x'.repeat(40000), tests: { ran: false }, base: 'abc123' });
  assert.match(big, /The diff above was shortened[\s\S]*git diff abc123[\s\S]*BLOCK and say so/);
  assert.match(P.finalReview({ request: 'r', plan, diff: 'x'.repeat(50000), tests: { ran: false }, base: 'def456' }), /git diff def456/);
});

import { makeFinding as mkF } from '../src/council/findings.js';

test('councilMember: one member, its own evidence, the rules and the JSON shape', () => {
  const items = [
    { id: 'C1', finding: mkF({ member: 'correctness', tool: 'tests', grade: 'blocking', locked: true, title: 'The tests fail (exit code 1)', detail: 'not ok 3' }) },
    { id: 'C2', finding: mkF({ member: 'correctness', tool: 'test-files', grade: 'warning', title: 'The change adds or edits no tests', preExisting: true }) },
  ];
  const p = P.councilMember({ member: 'correctness', label: 'Correctness', request: 'Add VAT totals', plan: { summary: 'S', chunks: [{ title: 'One' }] },
    diff: '+x', base: 'abc', tests: { ran: true, passed: false, code: 1, output: 'not ok 3' }, items, notes: ['Semgrep (code scanner) is not installed, so this check did not run.'] });
  assert.match(p, /You are the Correctness member of a review council/);
  assert.match(p, /Add VAT totals/);
  assert.match(p, /C1 \[blocking\] the test command: The tests fail \(exit code 1\) \(a fact: you cannot set it aside or lower it\)/);
  assert.match(p, /C2 \[warning\] test coverage check: The change adds or edits no tests \(already there before this change\)/);
  assert.match(p, /Checks that did not run:\n- Semgrep/);
  assert.match(p, /"findings": \[\{"id": "S1", "decision": "keep"/);
  assert.match(p, /Without tool evidence they can only be warnings or notes/);
  assert.match(p, /Tests: FAILED/);
  assert.doesNotMatch(p, /Security member|Legal member/);
  const none = P.councilMember({ member: 'security', label: 'Security', request: 'r', plan: null, diff: '', base: 'abc', tests: null, items: [], notes: [] });
  assert.match(none, /\(the tools found nothing\)/);
  assert.doesNotMatch(none, /Tests:/, 'only Correctness is shown the test result');
});

test('planReview without firstChunk adds no blank line', async () => {
  const { planReview } = await import('../src/prompts.js');
  assert.doesNotMatch(planReview({ request: 'r', planText: 'p' }), /\n\n\n/);
});
