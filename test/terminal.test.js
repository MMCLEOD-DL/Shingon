import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { createTerminal, NO_TTY_ESCALATION, NO_TTY_GATE, NO_TTY_LOCAL } from '../src/ui/terminal.js';

// A question is shown when the output ends with its "> " (or the note's ": ") prompt.
const isPrompt = (s) => s.endsWith('> ') || s.endsWith('(one line): ');
function sink(onPrompt = () => {}) {
  let text = '';
  const out = new Writable({ write(chunk, enc, cb) { const s = chunk.toString(); text += s; if (isPrompt(s)) onPrompt(); cb(); } });
  return { out, text: () => text };
}
// The user types each answer only once its question is on screen (type-ahead is discarded);
// with no answers left, the next question sees end-of-input.
function term({ answers = null, isTTY = true, bell = true } = {}) {
  const input = new PassThrough();
  const queue = answers == null ? null : [...answers];
  const o = sink(() => {
    if (!queue) return;
    setImmediate(() => (queue.length ? input.write(`${queue.shift()}\n`) : input.end()));
  });
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

test('type-ahead is discarded: a leftover answer cannot approve the gate', async () => {
  const input = new PassThrough();
  let first = true;
  // At the first question the user types its answer twice; the spare line must not answer the gate.
  const o = sink(() => { if (first) { first = false; setImmediate(() => input.write('a\na\n')); } });
  const t = createTerminal({ input, output: o.out, isTTY: true });
  assert.equal(await t.escalate(ESC), 'approve');
  await new Promise((r) => setImmediate(r));
  const gate = t.approveResult(GATE);
  input.end();
  assert.equal(await gate, false);
});

test('a prompt after close() answers end-of-input instead of hanging', async () => {
  const { t } = term({ answers: ['a', 'a'] });
  assert.equal(await t.escalate(ESC), 'approve');
  t.close();
  assert.equal(await t.escalate(ESC), 'reject');
  assert.equal(await t.approveResult(GATE), false);
  assert.equal(await t.approveChunk({ index: 0, title: 'x', total: 1, files: [] }), false);
});

test('null files, steps or payload fail closed without throwing', async () => {
  assert.equal(await term({ answers: ['a'] }).t.approveChunk({ index: 0, title: 'x', total: 1, files: null, tests: null }), true);
  assert.equal(await term({ answers: ['a'] }).t.approvePlan({ summary: null, steps: null }), true);
  assert.equal(await term({ answers: [] }).t.approveResult(null), false);
  const n = term({ isTTY: false });
  assert.equal(await n.t.approveChunk({ index: 0, title: 'x', total: 1, files: null }), false);
  assert.equal(await n.t.approvePlan({ steps: null }), false);
  assert.equal(await n.t.escalate(null), 'reject');
});

test('type-ahead before the FIRST prompt is discarded: it cannot approve the gate (C2)', async () => {
  const input = new PassThrough();
  const o = sink();
  const t = createTerminal({ input, output: o.out, isTTY: true, bell: false });
  input.write('a\n'); // typed while the run was working, long before any question
  await new Promise((r) => setTimeout(r, 20));
  t.onEvent({ type: 'phase', name: 'final' });
  const gate = t.approveResult(GATE);
  await new Promise((r) => setImmediate(r));
  input.end();
  assert.equal(await gate, false);
  t.close();
});

const DOWN_MSG = 'The local model "local" is not answering: its GPU worker is not connected.';

test('local consent before a run: wait, frontier, stop; message shown, bell rung', async () => {
  for (const [answer, expected] of [['w', 'wait'], ['f', 'frontier'], ['s', 'stop']]) {
    const { t, text } = term({ answers: [answer] });
    assert.equal(await t.confirmLocalFallback({ message: DOWN_MSG, method: 'wol' }), expected);
    assert.match(text(), /its GPU worker is not connected/);
    assert.match(text(), /\[w\] try to wake it again · \[f\] go ahead without it \(Claude\/Codex do its steps; uses your subscription\) · \[s\] stop > /);
    assert.ok(text().includes('\x07'));
  }
});

test('local consent: with no wake method set up, [w] only promises to check again', async () => {
  for (const args of [{ message: DOWN_MSG }, { message: DOWN_MSG, method: 'warn' }]) {
    const { t, text } = term({ answers: ['w'] });
    assert.equal(await t.confirmLocalFallback(args), 'wait');
    assert.match(text(), /\[w\] check again \(after you have started it\) · \[f\] go ahead without it/);
    assert.doesNotMatch(text(), /try to wake it again/);
  }
  const cmd = term({ answers: ['s'] });
  await cmd.t.confirmLocalFallback({ message: DOWN_MSG, method: 'command' });
  assert.match(cmd.text(), /\[w\] try to wake it again/);
});

test('local consent mid-run: no wait option; p pauses; an unknown answer is asked again', async () => {
  const { t, text } = term({ answers: ['w', 'p'] });
  assert.equal(await t.confirmLocalFallback({ message: DOWN_MSG, midRun: true }), 'stop');
  assert.match(text(), /Please type one of: f, p/);
  assert.match(text(), /\[p\] pause \(start it, then run: conductor resume\) > /);
  const f = term({ answers: ['f'] });
  assert.equal(await f.t.confirmLocalFallback({ message: DOWN_MSG, midRun: true }), 'frontier');
});

test('local consent fails closed: EOF and no terminal both stop, and say why', async () => {
  const eof = term({ answers: [] });
  assert.equal(await eof.t.confirmLocalFallback({ message: DOWN_MSG }), 'stop');
  const noTty = term({ isTTY: false });
  assert.equal(await noTty.t.confirmLocalFallback({ message: DOWN_MSG }), 'stop');
  assert.ok(noTty.text().includes(NO_TTY_LOCAL));
  assert.ok(noTty.text().includes(DOWN_MSG), 'the operator is still told what is wrong');
});

test('local consent: type-ahead cannot answer it', async () => {
  const input = new PassThrough();
  let text = '';
  const out = new Writable({ write(c, e, cb) { text += c; if (String(c).endsWith('> ')) setImmediate(() => input.write('s\n')); cb(); } });
  const t = createTerminal({ input, output: out, isTTY: true });
  input.write('f\n'); // typed before the question
  await new Promise((r) => setImmediate(r));
  assert.equal(await t.confirmLocalFallback({ message: DOWN_MSG }), 'stop');
});
