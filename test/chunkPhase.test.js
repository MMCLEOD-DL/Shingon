import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { runChunk, chunkRoles } from '../src/chunkPhase.js';
import { git } from '../src/workspace.js';
import { fakeParticipant, approve, block, makeCtx } from './helpers/fakes.js';

const PLAN = { summary: 'S', chunks: [{ title: 'Add a', instructions: 'create a.txt' }, { title: 'Add b', instructions: 'create b.txt' }] };
const writes = (name, body = 'x\n') => (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, name), body); return { text: 'done' }; };

function team({ local, author = writes('author.txt'), reviewer = approve, authorReview = approve }) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, ...a) => (role === 'reviewer' ? authorReview(role, ...a) : author(role, ...a)) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role, ...a) => (role === 'reviewer' ? reviewer(role, ...a) : writes('codex.txt')(role, ...a)) }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: local }),
  };
}

async function ctxFor(t, options = {}, hooks = {}) {
  const ctx = await makeCtx({ team: t, options, hooks });
  ctx.state.plan = PLAN;
  return ctx;
}
const commitsSince = async (ws, base) => (await git(ws.dir, ['rev-list', '--count', `${base}..HEAD`])).stdout.trim();

test('chunkRoles alternates reviewer and fallback', () => {
  const t = { author: 'A', reviewer: 'R', local: 'L' };
  assert.deepEqual(chunkRoles(0, t), { reviewer: 'R', fallback: 'A' });
  assert.deepEqual(chunkRoles(1, t), { reviewer: 'A', fallback: 'R' });
  assert.deepEqual(chunkRoles(2, t), { reviewer: 'R', fallback: 'A' });
});

test('local success becomes exactly one commit; reviewer sees the diff', async () => {
  const t = team({ local: writes('a.txt', 'hello a\n') });
  const ctx = await ctxFor(t);
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.equal(r.note, null);
  assert.equal(await commitsSince(ctx.ws, base), '1');
  assert.equal((await git(ctx.ws.dir, ['log', '-1', '--format=%s'])).stdout.trim(), 'conductor: step 1/2 — Add a');
  assert.deepEqual(t.local.calls[0].opts, { cwd: ctx.ws.dir, write: true, timeoutMs: ctx.options.agentTimeoutMs });
  assert.equal(t.reviewer.calls[0].opts.write, false);
  assert.match(t.reviewer.calls[0].task, /\+hello a/);
});

test('a blocked local attempt gets the feedback and still yields one commit', async () => {
  const reviews = [block('missing newline'), approve()];
  const t = team({
    local: (role, task, c, opts, n) => { writeFileSync(path.join(opts.cwd, `try${n}.txt`), 'x'); return { text: 'ok' }; },
    reviewer: () => reviews.shift(),
  });
  const ctx = await ctxFor(t);
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.match(t.local.calls[1].task, /missing newline/);
  assert.equal(await commitsSince(ctx.ws, base), '1');
});

test('tests run after each attempt and their result reaches the reviewer', async () => {
  const t = team({ local: writes('a.txt') });
  const ctx = await ctxFor(t, { testCommand: 'echo TESTS-RAN' });
  await runChunk(ctx, PLAN.chunks[0], 0);
  assert.match(t.reviewer.calls[0].task, /Tests: PASSED/);
});

test('local exhausted: workspace reset, fallback frontier implements', async () => {
  const t = team({
    local: writes('local-junk.txt'),
    reviewer: (role, task) => (/author\.txt/.test(task) ? approve() : block('wrong file')),
  });
  const ctx = await ctxFor(t, { localRounds: 2 });
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.equal(t.local.calls.length, 2);
  assert.equal(t.author.calls[0].role, 'author');
  assert.equal(t.author.calls[0].opts.write, true);
  assert.ok(existsSync(path.join(ctx.ws.dir, 'author.txt')));
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'local-junk.txt')));
  assert.match(r.note, /claude/);
});

test('odd chunks swap reviewer and fallback', async () => {
  const t = team({ local: writes('l.txt'), authorReview: (role, task) => (/codex\.txt/.test(task) ? approve() : block('no')) });
  const ctx = await ctxFor(t, { localRounds: 1 });
  const r = await runChunk(ctx, PLAN.chunks[1], 1);
  assert.equal(r.status, 'done');
  assert.ok(existsSync(path.join(ctx.ws.dir, 'codex.txt')));
  assert.equal(t.reviewer.calls.filter((c) => c.role === 'reviewer').length, 0);
});

test('frontier deadlock, reversible with passing tests: accepted with a note', async () => {
  const t = team({ local: writes('a.txt'), reviewer: () => block('style preference') });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1, testCommand: 'true' });
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.match(r.note, /style preference/);
  assert.equal(ctx.hookCalls.length, 0);
});

test('frontier deadlock with failing tests escalates; reject leaves the workspace at base', async () => {
  const t = team({ local: writes('a.txt'), reviewer: () => block('tests fail') });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1, testCommand: 'false' });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'stopped');
  assert.equal(ctx.hookCalls[0].name, 'escalate');
  assert.match(ctx.hookCalls[0].arg.message, /tests do not pass/);
  assert.equal(await ctx.ws.head(), base);
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'author.txt')));
});

test('user approval of an escalated chunk commits it with a note', async () => {
  const t = team({ local: writes('a.txt'), reviewer: () => block('IRREVERSIBLE: renames a public function') });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1 }, { escalate: async () => 'approve' });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.match(r.note, /approved/);
  assert.equal(await commitsSince(ctx.ws, base), '1');
});

test('agents that crash every time never leave a partial commit', async () => {
  const crash = (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, 'partial.txt'), 'half'); return { ok: false, error: 'timed out' }; };
  const t = team({ local: crash, author: crash });
  const ctx = await ctxFor(t, { localRounds: 2, frontierRounds: 1 });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'stopped');
  assert.equal(t.reviewer.calls.filter((c) => c.role === 'reviewer').length, 0);
  assert.match(ctx.hookCalls[0].arg.message, /nothing usable/);
  assert.equal(await ctx.ws.head(), base);
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'partial.txt')));
});

// --- Non-negotiable pins added beyond the brief (Review Focus 3, write access) ---

test('reviewer runs read-only in the workspace with the agent timeout', async () => {
  const t = team({ local: writes('a.txt') });
  const ctx = await ctxFor(t);
  await runChunk(ctx, PLAN.chunks[0], 0);
  assert.deepEqual(t.reviewer.calls[0].opts, { cwd: ctx.ws.dir, write: false, timeoutMs: ctx.options.agentTimeoutMs });
});

test('user approving an escalation over a crashed last attempt still commits nothing partial', async () => {
  const crash = (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, 'partial.txt'), 'half'); return { ok: false, error: 'timed out' }; };
  const t = team({ local: crash, author: crash });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1 }, { escalate: async () => 'approve' });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /nothing usable/);
  assert.equal(await ctx.ws.head(), base);
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'partial.txt')));
  assert.equal((await git(ctx.ws.dir, ['status', '--porcelain'])).stdout.trim(), '');
});

test('a local crash mid-chunk leaves no trace once the fallback succeeds', async () => {
  const t = team({
    local: (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, 'partial.txt'), 'half'); return { ok: false, error: 'timed out' }; },
  });
  const ctx = await ctxFor(t, { localRounds: 1 });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.equal(await commitsSince(ctx.ws, base), '1');
  const files = (await git(ctx.ws.dir, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n');
  assert.deepEqual(files, ['author.txt']);
});

test('an agent that commits on its own still yields exactly one commit', async () => {
  const t = team({
    local: async (role, task, c, opts) => {
      writeFileSync(path.join(opts.cwd, 'one.txt'), '1');
      await git(opts.cwd, ['add', '-A']);
      await git(opts.cwd, ['commit', '-q', '-m', 'agent commit']);
      writeFileSync(path.join(opts.cwd, 'two.txt'), '2');
      return { text: 'ok' };
    },
  });
  const ctx = await ctxFor(t);
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.equal(await commitsSince(ctx.ws, base), '1');
  assert.equal(r.sha, await ctx.ws.head());
  assert.equal((await git(ctx.ws.dir, ['status', '--porcelain'])).stdout.trim(), '');
});

test('an approved chunk that changed nothing returns sha null and no commit', async () => {
  const t = team({ local: () => ({ text: 'nothing to do' }) });
  const ctx = await ctxFor(t);
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.deepEqual(r, { status: 'done', sha: null, note: null });
  assert.equal(await ctx.ws.head(), base);
});

test('an unexpected error mid-chunk rolls the workspace back to base and rethrows', async () => {
  const t = team({ local: writes('a.txt') });
  const ctx = await ctxFor(t, { testCommand: 'true' });
  const base = await ctx.ws.head();
  ctx.ws.runTests = async () => { throw new Error('disk on fire'); };
  await assert.rejects(runChunk(ctx, PLAN.chunks[0], 0), /disk on fire/);
  assert.equal(await ctx.ws.head(), base);
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'a.txt')));
});
