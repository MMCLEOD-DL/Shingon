import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, mkdirSync, mkdtempSync, cpSync, appendFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Workspace } from '../src/workspace.js';
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

test('agents that crash every time never leave a partial commit, and the user is not asked a pointless question (I4)', async () => {
  const crash = (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, 'partial.txt'), 'half'); return { ok: false, error: 'timed out' }; };
  const t = team({ local: crash, author: crash });
  const ctx = await ctxFor(t, { localRounds: 2, frontierRounds: 1 });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /Step 1 \(Add a\) could not be completed: neither the local model nor claude produced a usable result/);
  assert.match(r.reason, /resume/);
  assert.equal(t.reviewer.calls.filter((c) => c.role === 'reviewer').length, 0);
  assert.equal(ctx.hookCalls.length, 0);
  assert.match(t.local.calls[1].task, /Your previous attempt did not finish \(local failed: timed out\)/);
  assert.doesNotMatch(t.local.calls[1].task, /blocked by the reviewer/);
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

test('a crashed last attempt fails without asking, even with an approving hook; nothing partial is committed', async () => {
  const crash = (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, 'partial.txt'), 'half'); return { ok: false, error: 'timed out' }; };
  const t = team({ local: crash, author: crash });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1 }, { escalate: async () => 'approve' });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'failed');
  assert.equal(ctx.hookCalls.length, 0);
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
  assert.deepEqual(r, { status: 'done', sha: null, note: null, tests: { ran: false, passed: null, code: null, output: '' } });
  assert.equal(await ctx.ws.head(), base);
});

test('an unexpected error mid-chunk rolls the workspace back to base and rethrows', async () => {
  const t = team({ local: writes('a.txt') });
  const ctx = await ctxFor(t, { testCommand: 'true' });
  const base = await ctx.ws.head();
  // squashSince runs after approval, outside any attempt, so this is a genuine throw.
  ctx.ws.squashSince = async () => { throw new Error('disk on fire'); };
  await assert.rejects(runChunk(ctx, PLAN.chunks[0], 0), /disk on fire/);
  assert.equal(await ctx.ws.head(), base);
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'a.txt')));
  assert.equal((await git(ctx.ws.dir, ['status', '--porcelain'])).stdout.trim(), '');
});

// --- Fix round 1 pins ---

const porcelain = async (ws) => (await git(ws.dir, ['status', '--porcelain'])).stdout.trim();

test('a nested git repo created by an agent is removed when the user rejects', async () => {
  const nested = async (role, task, c, opts) => {
    const sub = path.join(opts.cwd, 'vendor');
    mkdirSync(sub, { recursive: true });
    await git(sub, ['init', '-q']);
    writeFileSync(path.join(sub, 'lib.js'), 'x');
    await git(sub, ['add', '-A']);
    await git(sub, ['commit', '-q', '-m', 'vendored']); // like a clone: a repo with a commit
    return { text: 'ok' };
  };
  const t = team({ local: nested, author: nested, reviewer: () => block('tests fail') });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1, testCommand: 'false' });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'stopped');
  assert.equal(await ctx.ws.head(), base);
  assert.equal(await porcelain(ctx.ws), '');
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'vendor')));
});

test('a failed rollback is recorded in chunk-error and the original error is rethrown', async () => {
  const events = [];
  const t = team({ local: writes('a.txt') });
  const ctx = await ctxFor(t, {}, { onEvent: (e) => events.push(e) });
  ctx.ws.squashSince = async () => { throw new Error('disk on fire'); };
  ctx.ws.resetHard = async () => { throw new Error('reset broke'); };
  await assert.rejects(runChunk(ctx, PLAN.chunks[0], 0), /disk on fire/);
  const ev = events.find((e) => e.type === 'chunk-error');
  assert.equal(ev.error, 'disk on fire');
  assert.equal(ev.resetError, 'reset broke');
});

test('tests rerun on round 2 and FAILED output reaches the reviewer', async () => {
  const reviews = [block('add more'), approve()];
  const t = team({
    local: (role, task, c, opts, n) => { writeFileSync(path.join(opts.cwd, `try${n}.txt`), 'x'); return { text: 'ok' }; },
    reviewer: () => reviews.shift(),
  });
  const ctx = await ctxFor(t, { testCommand: 'if [ -f try1.txt ]; then echo SECOND-RUN-FAIL; exit 3; fi' });
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.match(t.reviewer.calls[0].task, /Tests: PASSED/);
  assert.match(t.reviewer.calls[1].task, /Tests: FAILED \(exit 3\)/);
  assert.match(t.reviewer.calls[1].task, /SECOND-RUN-FAIL/);
});

for (const [label, reply] of [['gives no VERDICT line', { text: 'looks fine to me' }], ['crashes', { ok: false, error: 'reviewer timed out' }]]) {
  test(`fallback reviewer that ${label} escalates, never accepts; reject leaves 0 commits`, async () => {
    const t = team({ local: writes('a.txt'), reviewer: () => reply });
    const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1, testCommand: 'true' });
    const base = await ctx.ws.head();
    const r = await runChunk(ctx, PLAN.chunks[0], 0);
    assert.equal(r.status, 'stopped');
    assert.equal(ctx.hookCalls.length, 1);
    assert.equal(ctx.hookCalls[0].name, 'escalate');
    assert.equal(await commitsSince(ctx.ws, base), '0');
    assert.equal(await porcelain(ctx.ws), '');
  });
}

test('deadlock with no test command and a plain BLOCK is accepted with a note, one commit', async () => {
  const t = team({ local: writes('a.txt'), reviewer: () => block('naming nit') });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1, testCommand: null });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.match(r.note, /no tests configured/);
  assert.match(r.note, /naming nit/);
  assert.equal(ctx.hookCalls.length, 0);
  assert.equal(await commitsSince(ctx.ws, base), '1');
});

test('an uncommitted nested git init every round is a blocked round, never a crash', async () => {
  // git add -A refuses a nested repo with no commit; ws.diff fails, which must become an error artifact.
  const initVendor = async (role, task, c, opts) => {
    const sub = path.join(opts.cwd, 'vendor');
    mkdirSync(sub, { recursive: true });
    await git(sub, ['init', '-q']);
    writeFileSync(path.join(sub, 'lib.js'), 'x');
    return { text: 'ok' };
  };
  const t = team({ local: initVendor, author: initVendor });
  const ctx = await ctxFor(t, { localRounds: 2, frontierRounds: 1 });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'failed');
  assert.equal(t.local.calls.length, 2);
  assert.equal(t.author.calls.filter((c) => c.role === 'author').length, 1);
  assert.equal(t.reviewer.calls.filter((c) => c.role === 'reviewer').length, 0);
  assert.match(t.local.calls[1].task, /could not inspect the workspace/);
  assert.equal(ctx.hookCalls.length, 0);
  assert.equal(await commitsSince(ctx.ws, base), '0');
  assert.equal(await porcelain(ctx.ws), '');
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'vendor')));
});

test('a test-runner failure inside an attempt resets to base and the next round recovers', async () => {
  let fail = true;
  const t = team({
    local: (role, task, c, opts, n) => { writeFileSync(path.join(opts.cwd, `try${n}.txt`), 'x'); return { text: 'ok' }; },
  });
  const ctx = await ctxFor(t, { testCommand: 'true' });
  const base = await ctx.ws.head();
  const real = ctx.ws.runTests.bind(ctx.ws);
  ctx.ws.runTests = async (...a) => { if (fail) { fail = false; throw new Error('runner exploded'); } return real(...a); };
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.match(t.local.calls[1].task, /could not inspect the workspace: runner exploded/);
  assert.equal(await commitsSince(ctx.ws, base), '1');
  const files = (await git(ctx.ws.dir, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n');
  assert.deepEqual(files, ['try1.txt']); // round-1 edits were reset away
});

test('if the reset after an inspection failure itself fails, the chunk throws (infrastructure)', async () => {
  const events = [];
  const t = team({ local: writes('a.txt') });
  const ctx = await ctxFor(t, { testCommand: 'true' }, { onEvent: (e) => events.push(e) });
  ctx.ws.runTests = async () => { throw new Error('runner exploded'); };
  ctx.ws.resetHard = async () => { throw new Error('reset broke'); };
  await assert.rejects(runChunk(ctx, PLAN.chunks[0], 0), /reset broke/);
  assert.ok(events.some((e) => e.type === 'chunk-error'));
});

// ---- Final-review fixes: I3 (full critique reaches the fixer), I4 (honest escalations) ----

test('the fixer receives the reviewer\'s full notes, not just the one-line reason (I3)', async () => {
  const reviews = [
    { text: 'Line 3 of a.txt is wrong: it must end with a newline, and add a test for empty input.', ...block('a.txt is wrong') },
    approve(),
  ];
  const t = team({ local: writes('a.txt'), reviewer: () => reviews.shift() });
  const ctx = await ctxFor(t);
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.match(t.local.calls[1].task, /blocked by the reviewer:\na\.txt is wrong\n\nReviewer's full notes:\nLine 3 of a\.txt is wrong/);
  assert.match(t.local.calls[1].task, /add a test for empty input/);
});

test('an escalation because the reviewer crashed says so, not that the reviewers disagreed (I4)', async () => {
  const t = team({ local: writes('a.txt'), reviewer: () => ({ ok: false, error: 'codex timed out' }) });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1, testCommand: 'true' });
  await runChunk(ctx, PLAN.chunks[0], 0);
  const msg = ctx.hookCalls[0].arg.message;
  assert.match(msg, /What happened: The AI reviewer could not check this step \(it failed or gave no clear answer\)/);
  assert.doesNotMatch(msg, /could not agree/);
});

test('an escalation over failing tests names the failing tests (I4)', async () => {
  const t = team({ local: writes('a.txt'), reviewer: () => block('still broken') });
  const ctx = await ctxFor(t, { localRounds: 1, frontierRounds: 1, testCommand: 'false' });
  await runChunk(ctx, PLAN.chunks[0], 0);
  assert.match(ctx.hookCalls[0].arg.message, /What happened: The tests are failing/);
});

// ---- Final-review fixes: Task 8 / Task 9 ledger minors ----

test('a rejected chunk removes an agent\'s new ignored build output but keeps pre-existing deps (T8-M4)', async () => {
  const build = (role, task, c, opts) => {
    mkdirSync(path.join(opts.cwd, 'dist'), { recursive: true });
    writeFileSync(path.join(opts.cwd, 'dist', 'new.js'), 'built');
    writeFileSync(path.join(opts.cwd, 'a.txt'), 'x');
    return { text: 'ok' };
  };
  const t = team({ local: build, author: build, reviewer: () => block('tests fail') });
  const ctx = await makeCtx({ team: t, files: { '.gitignore': 'node_modules/\ndist/\n' }, options: { localRounds: 1, frontierRounds: 1, testCommand: 'false' } });
  ctx.state.plan = PLAN;
  mkdirSync(path.join(ctx.ws.dir, 'node_modules'));
  writeFileSync(path.join(ctx.ws.dir, 'node_modules', 'x'), 'dep');
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'stopped');
  assert.ok(!existsSync(path.join(ctx.ws.dir, 'dist')));
  assert.ok(existsSync(path.join(ctx.ws.dir, 'node_modules', 'x')));
});

test('a reset after an inspection failure keeps the earlier blocked rounds\' work (T8 re-review)', async () => {
  const reviews = [block('add a test'), approve()];
  const local = async (role, task, c, opts, n) => {
    if (n === 0) writeFileSync(path.join(opts.cwd, 'round1.txt'), 'kept');
    if (n === 1) { // an uncommitted nested repo makes the inspection fail
      mkdirSync(path.join(opts.cwd, 'vendor'), { recursive: true });
      await git(path.join(opts.cwd, 'vendor'), ['init', '-q']);
      writeFileSync(path.join(opts.cwd, 'vendor', 'lib.js'), 'x');
    }
    if (n === 2) {
      assert.ok(existsSync(path.join(opts.cwd, 'round1.txt')), 'round 3 lost round 1\'s work');
      writeFileSync(path.join(opts.cwd, 'round3.txt'), 'x');
    }
    return { text: 'ok' };
  };
  const t = team({ local, reviewer: () => reviews.shift() });
  const ctx = await ctxFor(t, { localRounds: 3 });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.equal(t.local.calls.length, 3);
  assert.equal(await commitsSince(ctx.ws, base), '1');
  const files = (await git(ctx.ws.dir, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n').sort();
  assert.deepEqual(files, ['round1.txt', 'round3.txt']);
});

test('an agent that switches branches gets that attempt discarded and the next one runs on the run branch (T9)', async () => {
  const events = [];
  const local = async (role, task, c, opts, n) => {
    if (n === 0) await git(opts.cwd, ['checkout', '-q', '-b', 'elsewhere']);
    writeFileSync(path.join(opts.cwd, `try${n}.txt`), 'x');
    return { text: 'ok' };
  };
  const t = team({ local });
  const ctx = await ctxFor(t, {}, { onEvent: (e) => events.push(e) });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.ok(events.some((e) => e.type === 'branch-switched'));
  assert.match(t.local.calls[1].task, /switched the workspace off its branch/);
  assert.equal(await ctx.ws.currentBranch(), ctx.ws.branch);
  assert.deepEqual((await git(ctx.ws.dir, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n'), ['try1.txt']);
  assert.equal(await commitsSince(ctx.ws, base), '1');
});

// ---- Re-review follow-up: N3, N5 ----

const plantFilter = (marker) => {
  const d = mkdtempSync(path.join(tmpdir(), 'pwn-'));
  const hook = path.join(d, 'clean.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
  return { d, config: `[filter "pwn"]\n\tclean = ${hook}\n\trequired = true\n` };
};

test('a planted .git/commondir with a filter.clean never fires; the round is discarded and the next recovers (N3)', async () => {
  const marker = path.join(mkdtempSync(path.join(tmpdir(), 'mk-')), 'filter-ran');
  const events = [];
  const local = (role, task, c, opts, n) => {
    if (n === 0) {
      const { d, config } = plantFilter(marker);
      const common = path.join(d, 'common');
      cpSync(path.join(opts.cwd, '.git'), common, { recursive: true });
      appendFileSync(path.join(common, 'config'), config);
      writeFileSync(path.join(opts.cwd, '.gitattributes'), '* filter=pwn\n');
      writeFileSync(path.join(opts.cwd, '.git', 'commondir'), `${common}\n`);
    }
    writeFileSync(path.join(opts.cwd, `try${n}.txt`), 'x');
    return { text: 'ok' };
  };
  const t = team({ local });
  const ctx = await ctxFor(t, {}, { onEvent: (e) => events.push(e) });
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.ok(!existsSync(marker), 'the planted filter ran');
  assert.ok(events.some((e) => e.type === 'gitdir-tampered' && e.repaired === true));
  assert.ok(!existsSync(path.join(ctx.ws.dir, '.git', 'commondir')));
  assert.match(t.local.calls[1].task, /tampered with the workspace git directory/);
  assert.equal(t.reviewer.calls.filter((c) => /Review chunk/.test(c.task)).length, 1); // round 1 never reviewed
  assert.deepEqual((await git(ctx.ws.dir, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n'), ['try1.txt']);
  assert.equal(await commitsSince(ctx.ws, base), '1');
});

test('a .git replaced by a gitfile is unrepairable: the chunk fails and the planted filter never fires (N3)', async () => {
  const marker = path.join(mkdtempSync(path.join(tmpdir(), 'mk-')), 'filter-ran');
  const events = [];
  const local = (role, task, c, opts) => {
    const { d, config } = plantFilter(marker);
    const moved = path.join(d, 'gitdir');
    renameSync(path.join(opts.cwd, '.git'), moved);
    appendFileSync(path.join(moved, 'config'), config);
    writeFileSync(path.join(opts.cwd, '.git'), `gitdir: ${moved}\n`);
    writeFileSync(path.join(opts.cwd, '.gitattributes'), '* filter=pwn\n');
    writeFileSync(path.join(opts.cwd, 'a.txt'), 'x');
    return { text: 'ok' };
  };
  const ctx = await ctxFor(team({ local }), {}, { onEvent: (e) => events.push(e) });
  await assert.rejects(runChunk(ctx, PLAN.chunks[0], 0), /git directory was tampered with/);
  assert.ok(!existsSync(marker), 'the planted filter ran');
  assert.ok(events.some((e) => e.type === 'gitdir-tampered' && e.repaired === false));
  Workspace.unpoison(ctx.ws.dir);
});

test('.git/config replaced by a directory is restored, not a crash (N5)', async () => {
  const events = [];
  const local = (role, task, c, opts) => {
    const cfg = path.join(opts.cwd, '.git', 'config');
    rmSync(cfg);
    mkdirSync(cfg);
    writeFileSync(path.join(opts.cwd, 'a.txt'), 'x');
    return { text: 'ok' };
  };
  const ctx = await ctxFor(team({ local }), {}, { onEvent: (e) => events.push(e) });
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.ok(events.some((e) => e.type === 'config-tampered' && e.found === 'not a regular file'));
});
