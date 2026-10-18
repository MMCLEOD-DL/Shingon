# Task 9: Conductor — `runTask` & `resume`

This task is the public entry point. It validates the team and hooks, creates the workspace, and runs the plan, then each chunk, then the final review. It saves state after every step and hands a plain-English summary to the user's final gate. On approval it lands the result as a new branch in the real repo.

`resume` picks up a crashed or failed run. It rolls the workspace back to the last completed chunk and continues from there.

**Files:**
- Create: `src/conductor.js`
- Test: `test/conductor.test.js`

**Interfaces:**
- Consumes:
  - `Workspace` (Task 2), `RunLog`, `callRole` and `DEFAULT_OPTIONS` (Task 6).
  - `runPlanPhase` (Task 7), `runChunk` (Task 8), `verdictOf` (Task 4).
  - `prompts.finalReview` (Task 3), `buildSummary` and `plainReason` (Task 5).
  - Test helpers `fakeParticipant`, `approve`, `block` (Task 6) and `makeRepo`, `refsOf` (Task 2).
- Produces:
  - `DEFAULT_OPTIONS`, re-exported.
  - `validateTeam(team)`. It throws unless all of the following hold:
    - `author`, `reviewer` and `local` are all present.
    - Both frontier participants can play `author` *and* `reviewer`.
    - `local` can play `grunt`.
    - All three have `can_edit_files`.
    - The frontier adapters' `kind`s differ (the two-vendor rule).
  - `validateHooks(hooks, options)`. It throws unless `escalate` and `approveResult` are functions, and `approveChunk` too when `options.approveEachChunk` is set.
  - `runTask({ repoDir, request, team, hooks, options = {}, baseDir }) -> Promise<RunOutcome>`. It rejects only on invalid input (bad team, hooks or repo, or an empty request). Any later error becomes `{ status: 'failed', reason }`.
  - `resume({ workspaceDir, team, hooks, options = {} }) -> Promise<RunOutcome>`.
    - A run whose status is `landed`, `rejected` or `stopped` returns that outcome without calling any agent.
    - A run whose status is `running` or `failed` continues.
    - Options come from `{ ...DEFAULT_OPTIONS, ...state.options, ...options }`.
  - `RunOutcome = { status: 'landed' | 'rejected' | 'stopped' | 'failed', workspaceDir, branch?, reason? }`.
  - Hook payloads:
    - `approveChunk({ index, title, total })`. Only `true` continues.
    - `approveResult({ summary, files, tests, finalReview: { decision, reason }, diff })`. Only `true` lands.
  - Landing:
    - The target is `ws.branch`.
    - If that name already exists in the real repo, the run tries `-2` through `-9`.
    - If every name is taken, the run ends as `failed` and the workspace is kept.

- [ ] **Step 1: Write the failing tests**

`test/conductor.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTask, resume, validateTeam } from '../src/conductor.js';
import { git } from '../src/workspace.js';
import { fakeParticipant, approve, block } from './helpers/fakes.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';

const PLAN = { summary: 'S', chunks: [{ title: 'One', instructions: 'make one' }, { title: 'Two', instructions: 'make two' }] };
const planReply = { text: '```json\n' + JSON.stringify(PLAN) + '\n```' };
const stepOf = (task) => Number(/chunk (\d+) of/.exec(task)?.[1] ?? 0);

function makeTeam({ reviewer = () => approve(), local } = {}) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, task) => (role === 'reviewer' ? approve() : planReply) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task, c, o, n) => reviewer(role, task, n) }),
    local: fakeParticipant({
      name: 'local', kind: 'local-agent', roles: ['grunt'],
      script: local ?? ((role, task, c, opts) => { writeFileSync(path.join(opts.cwd, `step${stepOf(task)}.txt`), 'x\n'); return { text: 'ok' }; }),
    }),
  };
}

function hooks(over = {}) {
  const calls = [];
  const rec = (name, ret) => async (arg) => { calls.push({ name, arg }); return ret; };
  return { calls, escalate: rec('escalate', 'reject'), approveResult: rec('approveResult', true), approveChunk: rec('approveChunk', true), ...over };
}

const base = () => mkdtempSync(path.join(tmpdir(), 'cond-'));

test('validateTeam enforces roles, editing and the two-vendor rule', () => {
  const t = makeTeam();
  assert.doesNotThrow(() => validateTeam(t));
  assert.throws(() => validateTeam({ ...t, reviewer: fakeParticipant({ name: 'c2', kind: 'claude-code', script: approve }) }), /two-vendor/);
  assert.throws(() => validateTeam({ ...t, reviewer: fakeParticipant({ name: 'r', kind: 'codex', roles: ['reviewer'], script: approve }) }), /must be able to play author/);
  assert.throws(() => validateTeam({ ...t, local: fakeParticipant({ name: 'l', kind: 'x', roles: ['author'], script: approve }) }), /grunt/);
  assert.throws(() => validateTeam({ author: t.author }), /needs author, reviewer and local/);
});

test('runTask rejects bad input before touching anything', async () => {
  const h = hooks();
  await assert.rejects(runTask({ repoDir: await makeRepo(), request: '  ', team: makeTeam(), hooks: h, baseDir: base() }), /request/);
  await assert.rejects(runTask({ repoDir: base(), request: 'x', team: makeTeam(), hooks: h, baseDir: base() }), /not a git repository/);
  await assert.rejects(runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: { escalate: h.escalate }, baseDir: base() }), /approveResult/);
});

test('happy path lands a new branch with one commit per chunk; checkout untouched', async () => {
  const repo = await makeRepo();
  const h = hooks();
  const out = await runTask({ repoDir: repo, request: 'Add steps', team: makeTeam(), hooks: h, baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.equal(out.branch, 'conductor/add-steps');
  assert.equal((await git(repo, ['rev-list', '--count', `main..${out.branch}`])).stdout.trim(), '2');
  assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main');
  assert.equal((await git(repo, ['status', '--porcelain'])).stdout, '');
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.match(gate.summary, /1\. One[\s\S]*2\. Two/);
  assert.deepEqual(gate.files.sort(), ['step1.txt', 'step2.txt']);
  assert.equal(gate.finalReview.decision, 'APPROVE');
  assert.match(gate.diff, /step2\.txt/);
});

test('a rejected result leaves the real repo exactly as it was', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveResult: async () => false }), baseDir: base() });
  assert.equal(out.status, 'rejected');
  assert.equal(await refsOf(repo), before);
  assert.equal((await git(repo, ['status', '--porcelain'])).stdout, '');
  assert.ok(existsSync(out.workspaceDir));
});

test('a throwing final gate is a rejection, not a landing', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveResult: async () => { throw new Error('ui died'); } }), baseDir: base() });
  assert.equal(out.status, 'rejected');
  assert.equal(await refsOf(repo), before);
});

test('user rejecting an escalated plan stops before any chunk runs', async () => {
  const t = makeTeam({ reviewer: () => block('IRREVERSIBLE: drops data') });
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: t, hooks: hooks(), baseDir: base(), options: { planRounds: 1 } });
  assert.equal(out.status, 'stopped');
  assert.equal(t.local.calls.length, 0);
});

test('approveEachChunk: declining after step 1 stops the run', async () => {
  const t = makeTeam();
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: t, hooks: hooks({ approveChunk: async () => false }), baseDir: base(), options: { approveEachChunk: true } });
  assert.equal(out.status, 'stopped');
  assert.equal(t.local.calls.length, 1);
});

test('a blocking final review still reaches the gate, with its concern in the summary', async () => {
  const reviewer = (role, task) => (/Full diff of the finished branch/.test(task) ? block('IRREVERSIBLE: removes a public API') : approve());
  const h = hooks({ approveResult: async (arg) => { h.calls.push({ name: 'approveResult', arg }); return false; } });
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam({ reviewer }), hooks: h, baseDir: base() });
  assert.equal(out.status, 'rejected');
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.finalReview.decision, 'BLOCK');
  assert.match(gate.summary, /Final review concern: removes a public API/);
});

test('landing picks a free name when the branch already exists', async () => {
  const repo = await makeRepo();
  await git(repo, ['branch', 'conductor/x']);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.equal(out.branch, 'conductor/x-2');
  assert.equal((await git(repo, ['rev-parse', 'conductor/x'])).stdout.trim(), (await git(repo, ['rev-parse', 'main'])).stdout.trim());
});

test('resume after a crash discards the half-done chunk and continues', async () => {
  const repo = await makeRepo();
  const first = makeTeam();
  const stopped = await runTask({ repoDir: repo, request: 'x', team: first, hooks: hooks({ approveChunk: async () => false }), baseDir: base(), options: { approveEachChunk: true, testCommand: 'true' } });
  assert.equal(stopped.status, 'stopped');
  // Simulate a crash mid-step-2: state still "running", half-written file in the workspace.
  const statePath = path.join(stopped.workspaceDir, '.git', 'conductor', 'state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...st, status: 'running' }));
  writeFileSync(path.join(stopped.workspaceDir, 'half.txt'), 'partial');

  const second = makeTeam();
  const out = await resume({ workspaceDir: stopped.workspaceDir, team: second, hooks: hooks(), options: { approveEachChunk: false } });
  assert.equal(out.status, 'landed');
  assert.equal(second.local.calls.length, 1);
  assert.match(second.local.calls[0].task, /chunk 2 of 2/);
  assert.equal(second.author.calls.filter((c) => c.role === 'author').length, 0);
  assert.deepEqual((await git(repo, ['show', '--name-only', '--format=', out.branch])).stdout.trim().split('\n'), ['step2.txt']);
  assert.ok(!existsSync(path.join(stopped.workspaceDir, 'half.txt')));
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).options.testCommand, 'true');
});

test('resume of a finished run returns its outcome without calling agents', async () => {
  const done = await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base() });
  const t = makeTeam();
  const again = await resume({ workspaceDir: done.workspaceDir, team: t, hooks: hooks() });
  assert.equal(again.status, 'landed');
  assert.equal(again.branch, done.branch);
  assert.equal(t.author.calls.length + t.reviewer.calls.length + t.local.calls.length, 0);
});

test('an unexpected error mid-run becomes failed, and resume continues it', async () => {
  const repo = await makeRepo();
  let wsDir = null;
  let headBackup = null;
  const h = hooks({
    onEvent: (e) => { if (e.type === 'start') wsDir = e.workspace; },
    approveChunk: async () => {
      headBackup = readFileSync(path.join(wsDir, '.git', 'HEAD'), 'utf8');
      writeFileSync(path.join(wsDir, '.git', 'HEAD'), 'garbage\n');
      return true;
    },
  });
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: h, baseDir: base(), options: { approveEachChunk: true } });
  assert.equal(out.status, 'failed');
  assert.ok(out.reason);

  writeFileSync(path.join(wsDir, '.git', 'HEAD'), headBackup);
  const again = await resume({ workspaceDir: wsDir, team: makeTeam(), hooks: hooks(), options: { approveEachChunk: false } });
  assert.equal(again.status, 'landed');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/conductor.js` not found.

- [ ] **Step 3: Implement**

`src/conductor.js`:

```js
// src/conductor.js
import path from 'node:path';
import { Workspace } from './workspace.js';
import { RunLog, callRole } from './runlog.js';
import { DEFAULT_OPTIONS } from './options.js';
import { runPlanPhase } from './planPhase.js';
import { runChunk } from './chunkPhase.js';
import { verdictOf } from './review.js';
import * as prompts from './prompts.js';
import { buildSummary, plainReason } from './escalation.js';

export { DEFAULT_OPTIONS };

const FINISHED = new Set(['landed', 'rejected', 'stopped']);

export function validateTeam(team) {
  const { author, reviewer, local } = team ?? {};
  if (!author || !reviewer || !local) throw new Error('team needs author, reviewer and local participants');
  for (const p of [author, reviewer]) {
    for (const role of ['author', 'reviewer']) {
      if (!p.canPlay(role)) throw new Error(`${p.name} must be able to play ${role} (frontier participants rotate roles)`);
    }
  }
  if (!local.canPlay('grunt')) throw new Error(`${local.name} must be able to play grunt`);
  for (const p of [author, reviewer, local]) {
    if (!p.capabilities.can_edit_files) throw new Error(`${p.name} must have can_edit_files`);
  }
  if (author.adapter.kind === reviewer.adapter.kind) {
    throw new Error(`two-vendor rule: ${author.name} and ${reviewer.name} both use ${author.adapter.kind}; pick frontier participants from different vendors`);
  }
}

export function validateHooks(hooks, options) {
  if (typeof hooks?.escalate !== 'function') throw new Error('hooks.escalate is required');
  if (typeof hooks?.approveResult !== 'function') throw new Error('hooks.approveResult is required');
  if (options.approveEachChunk && typeof hooks.approveChunk !== 'function') {
    throw new Error('hooks.approveChunk is required when approveEachChunk is set');
  }
}

async function safeHook(log, name, fn, arg) {
  try {
    return await fn(arg);
  } catch (e) {
    log.event('hook-error', { hook: name, error: String(e?.message ?? e) });
    return undefined;
  }
}

export async function runTask({ repoDir, request, team, hooks, options = {}, baseDir }) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  validateTeam(team);
  validateHooks(hooks, opts);
  if (typeof request !== 'string' || !request.trim()) throw new Error('request must be a non-empty string');

  const ws = await Workspace.create({ repoDir, baseDir, taskId: request });
  const log = new RunLog(ws.dir, { onEvent: hooks.onEvent });
  const state = {
    version: 1, taskId: ws.branch, request, repoDir: path.resolve(repoDir), options: opts,
    phase: 'plan', plan: null, chunkIndex: 0, chunkShas: [], notes: [], status: 'running',
  };
  log.saveState(state);
  log.event('start', { request, workspace: ws.dir, branch: ws.branch });
  return drive({ request, team, hooks, options: opts, ws, log, state });
}

export async function resume({ workspaceDir, team, hooks, options = {} }) {
  validateTeam(team);
  const ws = await Workspace.open(workspaceDir);
  const log = new RunLog(ws.dir, { onEvent: hooks?.onEvent });
  const state = log.loadState();
  if (!state) throw new Error(`no Conductor run state in ${workspaceDir}`);
  if (FINISHED.has(state.status)) {
    return { status: state.status, workspaceDir: ws.dir, branch: state.branch, reason: state.reason };
  }
  const opts = { ...DEFAULT_OPTIONS, ...state.options, ...options };
  validateHooks(hooks, opts);
  state.options = opts;
  state.status = 'running';
  // Anything after the last completed chunk is a half-done step: discard it.
  await ws.resetHard(state.chunkShas.at(-1) ?? ws.baseSha);
  log.event('resume', { phase: state.phase, chunkIndex: state.chunkIndex });
  return drive({ request: state.request, team, hooks, options: opts, ws, log, state });
}

async function drive(ctx) {
  const { team, hooks, options, ws, log, state } = ctx;
  const finish = (status, extra = {}) => {
    Object.assign(state, { status }, extra);
    log.saveState(state);
    log.event('finish', { status, ...extra });
    return { status, workspaceDir: ws.dir, ...extra };
  };

  try {
    if (state.phase === 'plan') {
      const p = await runPlanPhase(ctx);
      if (p.status !== 'ok') return finish(p.status, { reason: p.reason });
      state.plan = p.plan;
      if (p.note) state.notes.push(p.note);
      Object.assign(state, { phase: 'chunks', chunkIndex: 0, chunkShas: [] });
      log.saveState(state);
    }

    if (state.phase === 'chunks') {
      const total = state.plan.chunks.length;
      for (let i = state.chunkIndex; i < total; i++) {
        const chunk = state.plan.chunks[i];
        const c = await runChunk(ctx, chunk, i);
        if (c.status !== 'done') return finish('stopped', { reason: c.reason });
        if (c.note) state.notes.push(c.note);
        state.chunkShas.push(await ws.head());
        state.chunkIndex = i + 1;
        log.saveState(state);
        if (options.approveEachChunk && i < total - 1) {
          const ok = await safeHook(log, 'approveChunk', hooks.approveChunk, { index: i, title: chunk.title, total });
          if (ok !== true) return finish('stopped', { reason: `You stopped the run after step ${i + 1}.` });
        }
      }
      state.phase = 'final';
      log.saveState(state);
    }

    // Final whole-branch review, then the user's gate.
    log.event('phase', { name: 'final' });
    const diff = await ws.diff(ws.baseSha);
    const files = await ws.listFiles(ws.baseSha);
    const tests = await ws.runTests(options.testCommand, { timeoutMs: options.testTimeoutMs });
    const r = await callRole(log, team.reviewer, 'reviewer',
      prompts.finalReview({ request: state.request, plan: state.plan, diff, tests }), '',
      { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs });
    const finalReview = verdictOf(r);
    const notes = [...state.notes];
    if (finalReview.decision === 'BLOCK') notes.push(`Final review concern: ${plainReason(finalReview.reason)}`);
    const summary = buildSummary({ request: state.request, plan: state.plan, notes, files, tests });

    const approved = await safeHook(log, 'approveResult', hooks.approveResult, { summary, files, tests, finalReview, diff });
    if (approved !== true) return finish('rejected', { reason: 'You did not approve the result.' });

    for (const suffix of ['', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9']) {
      const landed = await ws.land({ repoDir: state.repoDir, branch: `${ws.branch}${suffix}` });
      if (landed.ok) return finish('landed', { branch: landed.branch });
      if (!/already exists/.test(landed.error)) return finish('failed', { reason: landed.error });
    }
    return finish('failed', { reason: `every branch name ${ws.branch}[-2..-9] is taken; the result is kept in ${ws.dir}` });
  } catch (e) {
    return finish('failed', { reason: String(e?.message ?? e) });
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/conductor.js test/conductor.test.js
git commit -m "feat: runTask/resume — full adversarial loop with final gate and safe landing"
```
