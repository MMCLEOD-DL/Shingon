# Task 7: Plan phase

The frontier author drafts the plan (read-only, inside the workspace). The rival frontier reviewer critiques it in a capped loop. An unparsable plan counts as a blocked round and the parse error is fed back. If the two models still disagree after the cap, `settleDeadlock` decides between accepting with a note and asking the user. This task also adds `askUser`, the single path every escalation takes (Task 8 reuses it).

**Files:**
- Create: `src/askUser.js`, `src/planPhase.js`
- Test: `test/askUser.test.js`, `test/planPhase.test.js`

**Interfaces:**
- Consumes: `reviewLoop` (Task 4), `parsePlan`, `prompts.planAuthor`, `prompts.planReview` (Task 3), `settleDeadlock` (Task 5), `buildEscalation` (Task 5), `callRole` (Task 6), test helpers `fakeParticipant`, `approve`, `block`, `makeCtx` (Task 6).
- Produces:
  - `askUser(ctx, { kind, title, reason, recommendation }) -> Promise<'approve' | 'reject'>`. Logs an `escalation` event and a `decision` event. Anything other than the exact string `'approve'`, including a throwing hook, becomes `'reject'`.
  - `runPlanPhase(ctx) -> Promise<{ status: 'ok', plan, note } | { status: 'stopped' | 'failed', reason }>`
    - Uses `ctx.team.author` (role `author`) and `ctx.team.reviewer` (role `reviewer`), both with `{ cwd: ctx.ws.dir, write: false, timeoutMs: ctx.options.agentTimeoutMs }`.
    - `failed` when no round ever produced a valid plan (no escalation: there is nothing to approve).
    - `note` is `null` on a clean approval, otherwise a string explaining what was accepted.

- [ ] **Step 1: Write the failing tests**

`test/askUser.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askUser } from '../src/askUser.js';
import { makeCtx } from './helpers/fakes.js';

const esc = { kind: 'plan', title: 'the plan', reason: 'IRREVERSIBLE: x', recommendation: 'Reject.' };

test('passes a plain-English escalation to the hook and returns approve', async () => {
  let got = null;
  const ctx = await makeCtx({ hooks: { escalate: async (e) => { got = e; return 'approve'; } } });
  assert.equal(await askUser(ctx, esc), 'approve');
  assert.match(got.message, /the plan/);
  assert.deepEqual(got.options, ['approve', 'reject']);
});

test('anything but "approve" is a reject, including a throwing hook', async () => {
  for (const hook of [async () => 'yes', async () => undefined, async () => { throw new Error('ui gone'); }]) {
    const ctx = await makeCtx({ hooks: { escalate: hook } });
    assert.equal(await askUser(ctx, esc), 'reject');
  }
});
```

`test/planPhase.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanPhase } from '../src/planPhase.js';
import { fakeParticipant, approve, block, makeCtx } from './helpers/fakes.js';

const PLAN = { summary: 'S', chunks: [{ title: 'A', instructions: 'do a' }] };
const planReply = () => ({ text: 'Plan:\n```json\n' + JSON.stringify(PLAN) + '\n```' });

function team({ author, reviewer }) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: author }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: reviewer }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: () => ({}) }),
  };
}

test('clean approval returns the plan with no note; agents run read-only in the workspace', async () => {
  const t = team({ author: planReply, reviewer: approve });
  const ctx = await makeCtx({ team: t });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plan, PLAN);
  assert.equal(r.note, null);
  assert.equal(t.author.calls[0].opts.cwd, ctx.ws.dir);
  assert.equal(t.author.calls[0].opts.write, false);
  assert.equal(t.reviewer.calls[0].role, 'reviewer');
});

test('an unparsable plan is fed back to the author and not sent for review', async () => {
  const t = team({
    author: (role, task, c, o, n) => (n === 0 ? { text: 'no json here' } : planReply()),
    reviewer: approve,
  });
  const r = await runPlanPhase(await makeCtx({ team: t }));
  assert.equal(r.status, 'ok');
  assert.equal(t.reviewer.calls.length, 1);
  assert.match(t.author.calls[1].task, /blocked your previous plan[\s\S]*no ```json plan block/);
});

test('a reversible deadlock is accepted with a note', async () => {
  const t = team({ author: planReply, reviewer: () => block('I would name it differently') });
  const ctx = await makeCtx({ team: t, options: { planRounds: 2 } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'ok');
  assert.match(r.note, /name it differently/);
  assert.equal(ctx.hookCalls.filter((h) => h.name === 'escalate').length, 0);
});

test('an irreversible deadlock escalates; reject stops the run', async () => {
  const t = team({ author: planReply, reviewer: () => block('IRREVERSIBLE: deletes the user table') });
  const ctx = await makeCtx({ team: t, options: { planRounds: 2 } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'stopped');
  const esc = ctx.hookCalls.find((h) => h.name === 'escalate');
  assert.match(esc.arg.message, /deletes the user table/);
});

test('an irreversible deadlock the user approves continues with a note', async () => {
  const t = team({ author: planReply, reviewer: () => block('IRREVERSIBLE: deletes the user table') });
  const ctx = await makeCtx({ team: t, options: { planRounds: 1 }, hooks: { escalate: async () => 'approve' } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'ok');
  assert.match(r.note, /approved/i);
});

test('an author that never produces a valid plan fails without asking the user', async () => {
  const t = team({ author: () => ({ ok: false, error: 'rate limited' }), reviewer: approve });
  const ctx = await makeCtx({ team: t, options: { planRounds: 2 } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /rate limited/);
  assert.equal(ctx.hookCalls.length, 0);
});

test('a valid plan followed by a broken retry settles on the valid plan', async () => {
  const t = team({
    author: (role, task, c, o, n) => (n === 0 ? planReply() : { text: 'oops' }),
    reviewer: () => block('minor ordering preference'),
  });
  const r = await runPlanPhase(await makeCtx({ team: t, options: { planRounds: 2 } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plan, PLAN);
  assert.match(r.note, /minor ordering preference/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/askUser.js` / `../src/planPhase.js` not found.

- [ ] **Step 3: Implement**

`src/askUser.js`:

```js
// src/askUser.js
// The single path to the user. Fails closed: only an explicit 'approve' continues.
import { buildEscalation } from './escalation.js';

export async function askUser(ctx, { kind, title, reason, recommendation }) {
  const esc = buildEscalation({ kind, title, reason, recommendation });
  ctx.log.event('escalation', { kind, title, message: esc.message });
  let answer;
  try {
    answer = await ctx.hooks.escalate(esc);
  } catch (e) {
    ctx.log.event('hook-error', { hook: 'escalate', error: String(e?.message ?? e) });
    answer = null;
  }
  const decision = answer === 'approve' ? 'approve' : 'reject';
  ctx.log.event('decision', { kind, title, decision });
  return decision;
}
```

`src/planPhase.js`:

```js
// src/planPhase.js
import { reviewLoop } from './review.js';
import { parsePlan } from './plan.js';
import * as prompts from './prompts.js';
import { settleDeadlock } from './deadlock.js';
import { callRole } from './runlog.js';
import { askUser } from './askUser.js';

const PRODUCE_FAILED = 'could not produce a result';

export async function runPlanPhase(ctx) {
  const { request, team, options, ws, log } = ctx;
  const opts = { cwd: ws.dir, write: false, timeoutMs: options.agentTimeoutMs };
  log.event('phase', { name: 'plan' });

  const loop = await reviewLoop({
    maxRounds: options.planRounds,
    produce: async (round, feedback) => {
      const r = await callRole(log, team.author, 'author',
        prompts.planAuthor({ request, maxChunks: options.maxChunks, feedback }), '', opts);
      if (!r.ok) return { error: `author failed: ${r.error}` };
      const parsed = parsePlan(r.text, { maxChunks: options.maxChunks });
      return parsed.ok ? { plan: parsed.plan, text: r.text } : { error: parsed.error };
    },
    review: (a) => callRole(log, team.reviewer, 'reviewer', prompts.planReview({ request, planText: a.text }), '', opts),
  });

  if (loop.status === 'approved') return { status: 'ok', plan: loop.artifact.plan, note: null };
  if (!loop.lastGood) {
    return { status: 'failed', reason: `No valid plan after ${loop.rounds} rounds. Last problem: ${loop.lastReason}` };
  }

  // Settle on the last valid plan, judged by the last real review of a plan.
  const lastReview = [...loop.history].reverse().find((h) => !h.reason.startsWith(PRODUCE_FAILED));
  const reason = lastReview?.reason ?? loop.lastReason;
  const settle = settleDeadlock({ reason });
  log.event('deadlock', { phase: 'plan', action: settle.action, note: settle.note });
  if (settle.action === 'accept') return { status: 'ok', plan: loop.lastGood.plan, note: `Plan: ${settle.note}` };

  const decision = await askUser(ctx, { kind: 'plan', title: 'the plan', reason, recommendation: settle.recommendation });
  if (decision === 'approve') {
    return { status: 'ok', plan: loop.lastGood.plan, note: `Plan: you approved it over the concern: ${reason}` };
  }
  return { status: 'stopped', reason: 'You rejected the plan.' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/askUser.js src/planPhase.js test/askUser.test.js test/planPhase.test.js
git commit -m "feat: adversarial plan phase with fail-closed escalation"
```
