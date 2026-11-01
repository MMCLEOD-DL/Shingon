import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runChunk } from '../src/chunkPhase.js';
import { fakeParticipant, approve, makeCtx } from './helpers/fakes.js';
import { runCommand } from '../src/exec.js';
import { strictChildEnv } from '../src/secrets.js';

const chunk = { title: 'Synthetic edit', instructions: 'write result.txt' };
const pass = { ran: true, passed: true, code: 0, output: '' };
const fail = { ran: true, passed: false, code: 1, output: 'F8_ASSERTION: expected 4, got 3' };

async function context({ outcomes, localRounds = 2, frontierRounds = 1, hooks = {}, files } = {}) {
  const edit = (_role, _task, _ctx, opts) => {
    writeFileSync(path.join(opts.cwd, 'result.txt'), 'synthetic\n');
    return { text: 'done' };
  };
  const team = {
    local: fakeParticipant({ name: 'local', kind: 'local-agent', script: edit }),
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, ...args) => role === 'reviewer' ? approve() : edit(role, ...args) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: approve }),
  };
  const ctx = await makeCtx({ team, options: { localRounds, frontierRounds }, hooks, files });
  ctx.state.plan = { summary: 'synthetic', chunks: [chunk] };
  let i = 0;
  if (outcomes) ctx.ws.runTests = async () => outcomes[Math.min(i++, outcomes.length - 1)];
  return ctx;
}

test('F8: failed tests retry the producer before an approving rival is called', async () => {
  const ctx = await context({ outcomes: [fail, pass] });
  const result = await runChunk(ctx, chunk, 0);
  assert.equal(result.status, 'done');
  assert.equal(ctx.team.local.calls.length, 2);
  assert.equal(ctx.team.reviewer.calls.length, 1);
  assert.match(ctx.team.local.calls[1].task, /F8_ASSERTION/);
  assert.match(ctx.team.local.calls[1].task, /tests.*failed/i);
  assert.doesNotMatch(ctx.team.local.calls[1].task, /blocked by the reviewer|Reviewer's full notes/);
});

test('F8: exhausting both producer budgets never calls an approving reviewer or auto-commits', async () => {
  const ctx = await context({ outcomes: [fail], localRounds: 2, frontierRounds: 2 });
  const base = await ctx.ws.head();
  const result = await runChunk(ctx, chunk, 0);
  assert.equal(result.status, 'stopped');
  assert.equal(ctx.team.local.calls.length, 2);
  assert.equal(ctx.team.author.calls.length, 2);
  assert.equal(ctx.team.reviewer.calls.length, 0);
  assert.equal(ctx.hookCalls[0].name, 'escalate');
  assert.doesNotMatch(ctx.hookCalls[0].arg.message, /reviewers.*(?:agree|disagree)/i);
  assert.equal(await ctx.ws.head(), base);
  assert.equal(existsSync(path.join(ctx.ws.dir, 'result.txt')), false);
});

test('F8: fallback is reviewed only after its tests pass', async () => {
  const ctx = await context({ outcomes: [fail, fail, pass], localRounds: 1, frontierRounds: 2 });
  const result = await runChunk(ctx, chunk, 0);
  assert.equal(result.status, 'done');
  assert.equal(ctx.team.local.calls.length, 1);
  assert.equal(ctx.team.author.calls.length, 2);
  assert.equal(ctx.team.reviewer.calls.length, 1);
  assert.match(ctx.team.author.calls[1].task, /F8_ASSERTION/);
});

test('F8: no configured tests still requires rival review', async () => {
  const ctx = await context({ outcomes: [{ ran: false, passed: null, code: null, output: '' }] });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.equal(ctx.team.local.calls.length, 1);
  assert.equal(ctx.team.reviewer.calls.length, 1);
});

test('F8: a real failing test command cannot be waved through by an approving reviewer', async () => {
  const ctx = await context({ localRounds: 1, frontierRounds: 1, files: { 'f8-fail.cjs': "console.error('F8_REAL_FAIL'); process.exit(1);\n" } });
  const observed = [];
  // Exercise a real native failing command at the runner seam, independently of
  // platform shell quoting. All other workspace/commit behavior is real Git.
  ctx.ws.runTests = async () => {
    const r = await runCommand({ cmd: process.execPath, args: ['f8-fail.cjs'], cwd: ctx.ws.dir, env: strictChildEnv() });
    const tests = { ran: true, passed: r.code === 0, code: r.code, output: r.stdout + r.stderr };
    observed.push(tests); return tests;
  };
  const result = await runChunk(ctx, chunk, 0);
  assert.equal(result.status, 'stopped');
  assert.equal(ctx.team.reviewer.calls.length, 0);
  assert.equal(observed.length, 2);
  assert.ok(observed.every(r => r.ran && r.passed === false && r.code === 1 && r.output.includes('F8_REAL_FAIL')), JSON.stringify(observed));
});

test('F8: a timed-out test run is blocked and its output reaches the retry', async () => {
  const ctx = await context({ outcomes: [{ ...fail, code: -1, output: '[test command timed out]' }, pass] });
  assert.equal((await runChunk(ctx, chunk, 0)).status, 'done');
  assert.equal(ctx.team.reviewer.calls.length, 1);
  assert.match(ctx.team.local.calls[1].task, /test command timed out/);
});

test('F8: explicit escalation approval remains distinct from automatic approval', async () => {
  const ctx = await context({ outcomes: [fail], localRounds: 1, frontierRounds: 1, hooks: { escalate: async () => 'approve' } });
  const result = await runChunk(ctx, chunk, 0);
  assert.equal(result.status, 'done');
  assert.equal(ctx.team.reviewer.calls.length, 0);
  assert.match(result.note, /you approved it over the concern/);
});
