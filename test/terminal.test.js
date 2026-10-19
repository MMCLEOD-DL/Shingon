import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createTerminal, NO_TTY_ESCALATION, NO_TTY_GATE } from '../src/ui/terminal.js';

function sink() {
  let text = '';
  const out = new Writable({ write(chunk, enc, cb) { text += chunk.toString(); cb(); } });
  return { out, text: () => text };
}
function term({ answers = null, isTTY = true, bell = true } = {}) {
  const input = new PassThrough();
  const o = sink();
  if (answers != null) {
    input.write(answers.map((a) => `${a}\n`).join(''));
    input.end();
  }
  return { t: createTerminal({ input, output: o.out, isTTY, bell }), text: o.text };
}
const ESC = { kind: 'chunk', title: 'step 2', message: 'Conductor needs your decision on: step 2', options: ['approve', 'reject'], transcript: '/runs/x/transcript.jsonl' };
const GATE = { summary: 'Request: add X\nTests: passing', diff: 'diff --git a/x b/x\n+hello', files: ['x'], tests: { ran: true, passed: true }, finalReview: { decision: 'APPROVE' } };

test('escalate: see details, then approve; rings the bell first', async () => {
  const { t, text } = term({ answers: ['s', 'a'] });
  assert.equal(await t.escalate(ESC), 'approve');
  assert.match(text(), /Conductor needs your decision on: step 2/);
  assert.match(text(), /Full details of this run are saved in: \/runs\/x\/transcript\.jsonl/);
  assert.ok(text().includes('\x07'));
  t.close();
});

test('escalate: an unknown answer is asked again; EOF rejects', async () => {
  const a = term({ answers: ['yes please', 'r'] });
  assert.equal(await a.t.escalate(ESC), 'reject');
  assert.match(a.text(), /Please type one of: a, r, s/);
  const b = term({ answers: [] });
  assert.equal(await b.t.escalate(ESC), 'reject');
});

test('gate: view the diff, then reject with a note', async () => {
  const { t, text } = term({ answers: ['v', 'n', 'Please keep the old button'] });
  assert.deepEqual(await t.approveResult(GATE), { approved: false, note: 'Please keep the old button' });
  assert.match(text(), /Request: add X/);
  assert.match(text(), /\+hello/);
  assert.match(text(), /\[v\] view diff · \[a\] approve → new branch · \[r\] reject · \[n\] reject with a note/);
});

test('gate: a approves (exactly true), r rejects, EOF rejects', async () => {
  assert.equal(await term({ answers: ['A'] }).t.approveResult(GATE), true);
  assert.equal(await term({ answers: ['r'] }).t.approveResult(GATE), false);
  assert.equal(await term({ answers: [] }).t.approveResult(GATE), false);
});

test('per-step approval shows what changed', async () => {
  const { t, text } = term({ answers: ['a'] });
  assert.equal(await t.approveChunk({ index: 0, title: 'export util', total: 3, files: ['a.js', 'b.js'], note: null, tests: { ran: true, passed: false } }), true);
  assert.match(text(), /Step 1\/3 done: export util/);
  assert.match(text(), /a\.js, b\.js/);
  assert.match(text(), /Tests: FAILING/);
  assert.equal(await term({ answers: ['r'] }).t.approveChunk({ index: 0, title: 'x', total: 1, files: [], tests: null }), false);
});

test('plan approval lists the steps', async () => {
  const { t, text } = term({ answers: ['a'] });
  assert.equal(await t.approvePlan({ summary: 'Add an export util, then a button.', steps: ['export util', 'button'], note: null }), true);
  assert.match(text(), /Proposed plan:\nAdd an export util, then a button\.\n  1\. export util\n  2\. button/);
  assert.equal(await term({ answers: ['r'] }).t.approvePlan({ summary: '', steps: [] }), false);
  assert.equal(await term({ isTTY: false }).t.approvePlan({ summary: '', steps: [] }), false);
});

test('no terminal: every prompt fails closed and says why (Review Focus 3)', async () => {
  const { t, text } = term({ isTTY: false });
  assert.equal(await t.escalate(ESC), 'reject');
  assert.equal(await t.approveResult(GATE), false);
  assert.equal(await t.approveChunk({ index: 0, title: 'x', total: 1, files: [], tests: null }), false);
  assert.ok(text().includes(NO_TTY_ESCALATION));
  assert.ok(text().includes(NO_TTY_GATE));
  assert.ok(!text().includes('\x07'), 'no bell when nobody can answer');
});

test('onEvent redraws in place on a TTY', () => {
  const { t, text } = term();
  t.onEvent({ type: 'phase', name: 'plan' });
  t.onEvent({ type: 'call', participant: 'claude', role: 'author', write: false });
  assert.match(text(), /\x1b\[\d+F\x1b\[J/);
  assert.match(text(), /claude drafting the plan…/);
});

test('onEvent without a TTY prints each line once, no escape codes', () => {
  const { t, text } = term({ isTTY: false });
  t.onEvent({ type: 'phase', name: 'plan' });
  t.onEvent({ type: 'plan-agreed', chunks: ['One'], rounds: 1, author: 'claude', reviewer: 'codex' });
  t.onEvent({ type: 'plan-agreed', chunks: ['One'], rounds: 1, author: 'claude', reviewer: 'codex' });
  assert.equal(text().split('Plan agreed').length, 2);
  assert.ok(!text().includes('\x1b['));
});

test('watch-diffs and warnings are printed above the status', () => {
  const { t, text } = term({ isTTY: false });
  t.onEvent({ type: 'plan-agreed', chunks: ['One'], rounds: 1, author: 'claude', reviewer: 'codex' });
  t.onEvent({ type: 'chunk-done', index: 0, by: 'local', files: ['a'], diff: '+added line' });
  t.onEvent({ type: 'warning', kind: 'uncommitted-changes', detail: 'the repository has uncommitted changes' });
  assert.match(text(), /--- Step 1 changes ---\n\+added line/);
  assert.match(text(), /Note: the repository has uncommitted changes/);
});

test('bell can be turned off', async () => {
  const { t, text } = term({ answers: ['a'], bell: false });
  await t.escalate(ESC);
  assert.ok(!text().includes('\x07'));
});
