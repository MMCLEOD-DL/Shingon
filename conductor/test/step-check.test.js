import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { runChunk } from '../src/chunkPhase.js';
import { fakeParticipant, approve, makeCtx } from './helpers/fakes.js';

const pass = { ran: true, passed: true, code: 0, output: '' };
const fail = (output) => ({ ran: true, passed: false, code: 1, output });

async function context(chunk, { results, testCommand = 'suite', localRounds = 2 } = {}) {
  const edit = (_r, _t, _c, opts) => { writeFileSync(path.join(opts.cwd, 'out.txt'), 'x\n'); return { text: 'done' }; };
  const team = {
    local: fakeParticipant({ name: 'local', kind: 'local-agent', script: edit }),
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, ...a) => role === 'reviewer' ? approve() : edit(role, ...a) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: approve }),
  };
  const events = [];
  const ctx = await makeCtx({ team, options: { localRounds, frontierRounds: 1, testCommand }, hooks: { onEvent: (e) => events.push(e) } });
  ctx.state.plan = { summary: 's', chunks: [chunk] };
  const seen = [];
  ctx.ws.runTests = async (cmd) => { seen.push(cmd); return results[cmd] ? results[cmd].shift() ?? pass : pass; };
  return { ctx, seen, events };
}

test('G3: a failing step check blocks before the test command runs, with its own stage and output', async () => {
  const chunk = { title: 'T', instructions: 'i', check: 'node ok.cjs' };
  const { ctx, seen, events } = await context(chunk, { results: { 'node ok.cjs': [fail('CHECK_OUTPUT_7'), pass] } });
  const r = await runChunk(ctx, chunk, 0);
  assert.equal(r.status, 'done');
  assert.deepEqual(seen.slice(0, 1), ['node ok.cjs']);
  assert.equal(seen[1], 'node ok.cjs');
  assert.equal(seen[2], 'suite');
  const ev = events.find((e) => e.type === 'chunk-tests-failed');
  assert.equal(ev.stage, 'check');
  assert.match(ctx.team.local.calls[1].task, /Step check `node ok\.cjs` failed/);
  assert.match(ctx.team.local.calls[1].task, /CHECK_OUTPUT_7/);
  assert.equal(ctx.team.reviewer.calls.length, 1);
});

test('G3: a passing check is followed by the test command, in order', async () => {
  const chunk = { title: 'T', instructions: 'i', check: 'node ok.cjs' };
  const { ctx, seen } = await context(chunk, { results: {} });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.deepEqual(seen, ['node ok.cjs', 'suite']);
});

test('G3: a failing test command after a passing check reports stage tests', async () => {
  const chunk = { title: 'T', instructions: 'i', check: 'node ok.cjs' };
  const { ctx, events } = await context(chunk, { results: { suite: [fail('SUITE_RED'), pass] } });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.equal(events.find((e) => e.type === 'chunk-tests-failed').stage, 'tests');
  assert.match(ctx.team.local.calls[1].task, /SUITE_RED/);
});

test('G3: a step without check calls the test command once, as before', async () => {
  const chunk = { title: 'T', instructions: 'i' };
  const { ctx, seen } = await context(chunk, { results: {} });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.deepEqual(seen, ['suite']);
});

test('G3: existing-suite and none run no extra command', async () => {
  for (const check of ['existing-suite', 'none']) {
    const chunk = { title: 'T', instructions: 'i', check };
    const { ctx, seen } = await context(chunk, { results: {} });
    assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
    assert.deepEqual(seen, ['suite'], check);
  }
});

test('G3: a passing check with no test command is the step\'s evidence (stage check, Tests: PASSED)', async () => {
  const chunk = { title: 'T', instructions: 'i', check: 'node ok.cjs' };
  for (const testCommand of [null, '']) {
    const { ctx, seen } = await context(chunk, { results: {}, testCommand });
    const r = await runChunk(ctx, chunk, 0);
    assert.equal(r.status, 'done');
    assert.deepEqual(seen, ['node ok.cjs']);
    assert.equal(r.tests.ran, true);
    assert.equal(r.tests.passed, true);
    assert.equal(r.tests.stage, 'check');
    assert.match(ctx.team.reviewer.calls[0].task, /Tests: PASSED/);
  }
});
