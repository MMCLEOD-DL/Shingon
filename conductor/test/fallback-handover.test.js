import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runChunk } from '../src/chunkPhase.js';
import { clip } from '../src/text.js';
import { fakeParticipant, approve, block, makeCtx } from './helpers/fakes.js';

const chunk = { title: 'Step four', instructions: 'write result.txt' };
const passing = { ran: true, passed: true, code: 0, output: '' };
const failing = (output) => ({ ran: true, passed: false, code: 1, output });

async function setup({ outcomes, reviews = [approve()], localRounds, frontierRounds = 1 }) {
  const events = [];
  const edit = (_role, _task, _ctx, opts) => { writeFileSync(path.join(opts.cwd, 'result.txt'), 'x\n'); return { text: 'done' }; };
  let r = 0;
  const verdicts = (role) => (role === 'reviewer' ? reviews[Math.min(r++, reviews.length - 1)] : null);
  const team = {
    local: fakeParticipant({ name: 'local', kind: 'local-agent', script: edit }),
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, ...a) => (role === 'reviewer' ? verdicts(role) : edit(role, ...a)) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role) => verdicts(role) }),
  };
  const ctx = await makeCtx({ team, options: { localRounds, frontierRounds, testCommand: 'x' }, hooks: { onEvent: (e) => events.push(e) } });
  ctx.state.plan = { summary: 's', chunks: [chunk] };
  let i = 0;
  ctx.ws.runTests = async () => outcomes[Math.min(i++, outcomes.length - 1)];
  return { ctx, team, events };
}
const fallbackEvent = (events) => events.find((e) => e.type === 'chunk-fallback' || e.event === 'chunk-fallback' || e.kind === 'chunk-fallback');

test('G2: the first frontier attempt inherits the last local reason and test excerpt', async () => {
  const { ctx, team, events } = await setup({
    localRounds: 3,
    outcomes: [failing('OUT_ONE'), failing('OUT_TWO'), failing('OUT_THREE_LAST'), passing],
  });
  const result = await runChunk(ctx, chunk, 0);
  assert.equal(result.status, 'done');
  const task = team.author.calls.find((c) => c.role === 'author').task;
  assert.match(task, /The step tests failed/);
  assert.match(task, /OUT_THREE_LAST/);
  assert.doesNotMatch(task, /OUT_ONE|OUT_TWO/);
  assert.match(task, /reset/i);
  assert.doesNotMatch(task, /earlier edits are still in place/);
  const ev = fallbackEvent(events);
  assert.ok(ev, 'chunk-fallback event logged');
  assert.equal(ev.handover.attempts, 3);
  assert.equal(ev.handover.reasons.length, 3);
  assert.equal(ev.handover.testExcerpt, 'OUT_THREE_LAST');
  assert.match(result.note, /was done by claude/);
  assert.equal(events.find((e) => e.type === 'chunk-done').by, 'claude');
  console.log('SAMPLE PROMPT TAIL:\n' + task.slice(task.indexOf('A local model')));
});

test('G2: reviewer-driven fallback inherits the last block reason and no test section', async () => {
  const { ctx, team } = await setup({
    localRounds: 2,
    outcomes: [passing],
    reviews: [block('BLOCK_ONE'), block('BLOCK_TWO_LAST'), approve()],
  });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  const task = team.author.calls.find((c) => c.role === 'author').task;
  assert.match(task, /BLOCK_TWO_LAST/);
  assert.match(task, /BLOCK_ONE/);
  assert.doesNotMatch(task, /Test output from its last attempt/);
});

test('G2: only the first frontier attempt inherits', async () => {
  const { ctx, team } = await setup({
    localRounds: 1, frontierRounds: 2,
    outcomes: [passing],
    reviews: [block('LOCAL_BLOCK'), block('FRONTIER_BLOCK'), approve()],
  });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  const calls = team.author.calls.filter((c) => c.role === 'author');
  assert.equal(calls.length, 2);
  assert.match(calls[0].task, /could not get it approved/);
  assert.match(calls[1].task, /Your previous attempt was blocked by the reviewer/);
  assert.match(calls[1].task, /FRONTIER_BLOCK/);
  assert.doesNotMatch(calls[1].task, /could not get it approved|LOCAL_BLOCK/);
});

test('G2: no fallback means no handover', async () => {
  const { ctx, team, events } = await setup({ localRounds: 1, outcomes: [passing] });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.equal(fallbackEvent(events), undefined);
  assert.equal(team.author.calls.filter((c) => c.role === 'author').length, 0);
});

test('G2: the test excerpt is clipped to a fixed size', async () => {
  const big = 'a'.repeat(5000) + 'MIDDLE' + 'z'.repeat(5000);
  const { ctx, events } = await setup({ localRounds: 1, outcomes: [failing(big), passing] });
  await runChunk(ctx, chunk, 0);
  const ex = fallbackEvent(events).handover.testExcerpt;
  assert.equal(ex, clip(big, 2000));
  assert.ok(ex.length <= 2000 + 40);
});
