# Task 8: Chunk phase

One chunk, start to finish:

1. The local agent edits the workspace and Conductor runs the tests.
2. A frontier reviewer checks the diff, with up to `localRounds` attempts.
3. If the local agent can't satisfy the reviewer, the workspace is reset to the chunk's base and the *other* frontier implements the chunk, with up to `frontierRounds` attempts and the same reviewer.
4. If that is still blocked, it's a frontier-vs-frontier deadlock, and `settleDeadlock` decides: accept with a note, or ask the user.
5. A successful chunk is squashed into exactly one commit. A stopped chunk leaves the workspace exactly at its base.

Reviewer and fallback alternate per chunk so neither vendor is always in charge.

**Files:**
- Create: `src/chunkPhase.js`
- Test: `test/chunkPhase.test.js`

**Interfaces:**
- Consumes: `reviewLoop` (Task 4); `prompts.chunkExec`, `prompts.chunkReview` (Task 3); `settleDeadlock` (Task 5); `callRole` (Task 6); `askUser` (Task 7); the `Workspace` methods `head`, `diff`, `runTests`, `resetHard`, `squashSince` (Task 2); and the test helpers from Task 6.
- Produces:
  - `chunkRoles(index, team) -> { reviewer, fallback }`. For even `index`, the reviewer is `team.reviewer` and the fallback is `team.author`. For odd `index` they swap.
  - `runChunk(ctx, chunk, index) -> Promise<{ status: 'done', sha: string | null, note: string | null } | { status: 'stopped', reason }>`
    - Reads `ctx.state.plan` for the prompts.
    - Local runs with role `grunt` and the fallback with role `author`, both `{ cwd: ws.dir, write: true, timeoutMs: options.agentTimeoutMs }`. The reviewer runs with `write: false`.
    - The commit message is `conductor: step <i+1>/<total> — <title>`. `sha` is `null` if the approved chunk changed nothing.
    - A failed agent call is a blocked round (`could not produce a result: <name> failed: <error>`), not a crash.

- [ ] **Step 1: Write the failing tests**

`test/chunkPhase.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/chunkPhase.js` not found.

- [ ] **Step 3: Implement**

`src/chunkPhase.js`:

```js
// src/chunkPhase.js
import { reviewLoop } from './review.js';
import * as prompts from './prompts.js';
import { settleDeadlock } from './deadlock.js';
import { callRole } from './runlog.js';
import { askUser } from './askUser.js';

// Rotate vendors: the frontier that reviews a chunk is never the one that implements its fallback.
export function chunkRoles(index, team) {
  return index % 2 === 0
    ? { reviewer: team.reviewer, fallback: team.author }
    : { reviewer: team.author, fallback: team.reviewer };
}

const join = (a, b) => (a ? `${a} ${b}` : b);

export async function runChunk(ctx, chunk, index) {
  const { request, team, options, ws, log, state } = ctx;
  const plan = state.plan;
  const total = plan.chunks.length;
  const step = `Step ${index + 1} (${chunk.title})`;
  const base = await ws.head();
  const { reviewer, fallback } = chunkRoles(index, team);
  const writeOpts = { cwd: ws.dir, write: true, timeoutMs: options.agentTimeoutMs };
  const readOpts = { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs };
  log.event('chunk', { index, title: chunk.title, base });

  const attempt = (who, role) => async (round, feedback) => {
    const r = await callRole(log, who, role, prompts.chunkExec({ request, plan, chunk, index, total, feedback }), '', writeOpts);
    if (!r.ok) return { error: `${who.name} failed: ${r.error}` };
    const tests = await ws.runTests(options.testCommand, { timeoutMs: options.testTimeoutMs });
    return { diff: await ws.diff(base), tests };
  };
  const review = (a) => callRole(log, reviewer, 'reviewer',
    prompts.chunkReview({ request, plan, chunk, index, total, diff: a.diff, tests: a.tests }), '', readOpts);

  let note = null;
  let loop = await reviewLoop({ maxRounds: options.localRounds, produce: attempt(team.local, 'grunt'), review });

  if (loop.status !== 'approved') {
    log.event('chunk-fallback', { index, to: fallback.name, reason: loop.lastReason });
    await ws.resetHard(base);
    loop = await reviewLoop({ maxRounds: options.frontierRounds, produce: attempt(fallback, 'author'), review });
    note = `${step} was done by ${fallback.name} because the local model could not finish it.`;
  }

  if (loop.status !== 'approved') {
    // The workspace reflects the LAST attempt, so judge that one.
    const last = loop.artifact;
    const settle = settleDeadlock({ reason: loop.lastReason, tests: last?.tests ?? null, produced: !last?.error });
    log.event('deadlock', { phase: 'chunk', index, action: settle.action, note: settle.note });
    if (settle.action === 'accept') {
      note = join(note, `${step}: ${settle.note}`);
    } else {
      const decision = await askUser(ctx, {
        kind: 'chunk', title: `step ${index + 1}: ${chunk.title}`, reason: loop.lastReason, recommendation: settle.recommendation,
      });
      if (decision !== 'approve') {
        await ws.resetHard(base);
        return { status: 'stopped', reason: `You stopped the run at step ${index + 1} (${chunk.title}).` };
      }
      note = join(note, `${step}: you approved it over the concern: ${loop.lastReason}`);
    }
  }

  const sha = await ws.squashSince(base, `conductor: step ${index + 1}/${total} — ${chunk.title}`);
  log.event('chunk-done', { index, sha });
  return { status: 'done', sha, note };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chunkPhase.js test/chunkPhase.test.js
git commit -m "feat: chunk cycle — local execute, rival review, frontier fallback, deadlock"
```
