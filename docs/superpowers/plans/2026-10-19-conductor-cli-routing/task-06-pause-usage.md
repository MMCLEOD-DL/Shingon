# Task 6: Pause, usage & run warnings

This task connects the Seats to a run.

**Pausing.** When a frontier Seat has nothing left (`failure: 'no-participant'`), the run must not count it as a failed attempt, a deadlock or a rejection.
- It ends with the new, resumable status **`paused`**.
- The workspace is reset to the last finished step, and the user gets a plain reason.
- This applies wherever it happens: drafting the plan, reviewing, a frontier fallback, or the final review.
- A local Seat with nothing left is NOT a pause. It is already in `LOCAL_FATAL` (Task 1), so the frontier takes the step.

**Also in this task:**
- Totals of reported cost and paid-API calls, kept in the run state.
- `buildTeam`'s warnings passed into the run.
- Seats bound to the run's transcript, so their routing events are logged.
- Two small event fields the status view needs (Task 8).

**Files:**
- Modify: `src/review.js`, `src/planPhase.js`, `src/chunkPhase.js`, `src/conductor.js`, `src/runlog.js`
- Test: `test/review.test.js`, `test/planPhase.test.js`, `test/chunkPhase.test.js`, `test/conductor.test.js`, `test/runlog.test.js` (append)

**Interfaces:**
- Consumes:
  - `Seat` with `bind(emit)`, and results carrying `servedBy`/`servedKind` (Task 4);
  - `isApiKind` (Task 2);
  - `LOCAL_FATAL` (Task 1);
  - `buildTeam` warnings (Task 5, passed in by the CLI in Task 10).
- Produces:
  - **`reviewLoop`** returns `{ status: 'paused', artifact, lastGood, rounds, lastReason, history }`, in two cases:
    - the produced artifact has a truthy `pause` (its value becomes `lastReason`);
    - the review Result has `failure === 'no-participant'` (its `error` becomes `lastReason`).
  - **`runPlanPhase`** may return `{ status: 'paused', reason }`.
  - **`runChunk`** may return `{ status: 'paused', reason }`, after resetting the workspace to the chunk base.
  - **Run outcome:**
    - `outcome.status` may be `'paused'`, with `reason` = `pausedReason(why)` (below).
    - `paused` is resumable (`stateProblem` accepts `running | failed | paused`).
    - A paused run keeps its workspace, and its phase stays as it was.
  - **New parameters:** `runTask({ ..., warnings = [] })` and `resume({ ..., warnings = [] })` append each warning to `state.warnings` once, without duplicates, so they reach the final summary.
  - **Usage totals:** `state.usage = { costUsd, apiCostUsd, apiCalls }`, updated by `callAgent` for every call.
    - `costUsd` adds every finite `result.usage.costUsd`.
    - `apiCostUsd` and `apiCalls` count the calls whose served kind (`result.servedKind ?? participant.adapter.kind`) is an API.
    - When `apiCalls > 0`, the final summary gets the line: `Paid API use this run: <n> call(s), about $<x.xx>.` If no cost was reported, the line ends ` (the cost was not reported).` instead of the amount.
  - **Seat binding:** at the start of `drive`, every distinct team member with a `bind` method is bound to `(type, data) => log.event(type, data)`.
  - **Event fields:** the `call` event gains `write` (boolean), and the `result` event gains `servedBy` (string or null).

```js
// src/conductor.js
const pausedReason = (why) => `Conductor paused: ${why}. Your repository is unchanged and the finished steps are kept; run "conductor resume" when it is available again.`;
```

- [ ] **Step 1: Write the failing tests**

Append to `test/review.test.js`:

```js
test('a producer artifact with pause ends the loop as paused', async () => {
  let reviews = 0;
  const r = await reviewLoop({ produce: async () => ({ error: 'no model', pause: 'no AI model is available for claude (claude: rate-limited)' }), review: async () => { reviews++; return approve(); }, maxRounds: 3 });
  assert.equal(r.status, 'paused');
  assert.equal(r.rounds, 1);
  assert.equal(r.lastReason, 'no AI model is available for claude (claude: rate-limited)');
  assert.equal(reviews, 0);
});

test('a reviewer with nothing left pauses the loop instead of blocking', async () => {
  let produced = 0;
  const r = await reviewLoop({
    produce: async () => { produced++; return { v: 1 }; },
    review: async () => makeResult({ ok: false, error: 'no AI model is available for codex (codex: rate-limited)', failure: 'no-participant' }),
    maxRounds: 3,
  });
  assert.equal(r.status, 'paused');
  assert.equal(produced, 1);
  assert.match(r.lastReason, /no AI model is available for codex/);
});
```

Append to `test/planPhase.test.js`:

```js
const NOBODY = { ok: false, error: 'no AI model is available for claude (claude: rate-limited; codex: rate-limited)', failure: 'no-participant' };

test('an author seat with nothing left pauses the plan phase', async () => {
  const t = team({ author: () => NOBODY, reviewer: approve });
  const r = await runPlanPhase(await makeCtx({ team: t }));
  assert.equal(r.status, 'paused');
  assert.match(r.reason, /claude: rate-limited/);
  assert.equal(t.author.calls.length, 1);
  assert.equal(t.reviewer.calls.length, 0);
});

test('a reviewer seat with nothing left pauses the plan phase', async () => {
  const t = team({ author: planReply, reviewer: () => NOBODY });
  const r = await runPlanPhase(await makeCtx({ team: t }));
  assert.equal(r.status, 'paused');
});
```

Append to `test/chunkPhase.test.js`:

```js
const NOBODY = { ok: false, error: 'no AI model is available for codex (codex: rate-limited)', failure: 'no-participant' };

test('a reviewer with nothing left pauses the chunk and resets the workspace', async () => {
  const t = team({ local: writes('a.txt'), reviewer: () => NOBODY });
  const ctx = await ctxFor(t);
  const base = await ctx.ws.head();
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'paused');
  assert.match(r.reason, /no AI model is available for codex/);
  assert.equal(await commitsSince(ctx.ws, base), '0');
  assert.equal(await ctx.ws.isClean(), true);
});

test('a frontier fallback with nothing left pauses; a local seat with nothing left falls back', async () => {
  const paused = team({ local: () => ({ ok: false, error: 'x', failure: 'no-participant' }), author: () => NOBODY });
  const r = await runChunk(await ctxFor(paused), PLAN.chunks[0], 0);
  assert.equal(r.status, 'paused');
  assert.equal(paused.local.calls.length, 1, 'local no-participant is fatal for local, not a pause');
});
```

Append to `test/runlog.test.js`. It already imports `RunLog`, `callRole` and `fakeParticipant`. Add `callAgent` to the `../src/runlog.js` import, and `makeCtx` to the `./helpers/fakes.js` import, then use them directly:

```js

test('callAgent totals cost, and counts paid API calls; call/result events gain write and servedBy', async () => {
  const seen = [];
  const sub = fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => ({ text: 'x', usage: { costUsd: 0.25 } }) });
  const api = fakeParticipant({ name: 'gpt-api', kind: 'openai-api', script: () => ({ text: 'y', usage: { costUsd: 0.1 } }) });
  const ctx = await makeCtx({ team: { author: sub, reviewer: api, local: sub }, hooks: { onEvent: (e) => seen.push(e) } });
  await callAgent(ctx, sub, 'author', 't', { cwd: ctx.ws.dir, write: true });
  await callAgent(ctx, api, 'reviewer', 't', { cwd: ctx.ws.dir, write: false });
  assert.ok(Math.abs(ctx.state.usage.costUsd - 0.35) < 1e-9);
  assert.ok(Math.abs(ctx.state.usage.apiCostUsd - 0.1) < 1e-9);
  assert.equal(ctx.state.usage.apiCalls, 1);
  const calls = seen.filter((e) => e.type === 'call');
  assert.deepEqual(calls.map((e) => e.write), [true, false]);
  assert.ok(seen.filter((e) => e.type === 'result').every((e) => 'servedBy' in e));
});
```

Append to `test/conductor.test.js`:

```js
import { Seat } from '../src/router.js';
import { makeResult as mkResult } from '../src/result.js';

const NOBODY_R = { ok: false, error: 'no AI model is available for codex (codex: rate-limited)', failure: 'no-participant' };

test('a frontier seat with nothing left pauses the run; resume finishes it (Review Focus 2)', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam({ reviewer: () => NOBODY_R }), hooks: hooks(), baseDir: base() });
  assert.equal(out.status, 'paused');
  assert.match(out.reason, /^Conductor paused: no AI model is available for codex \(codex: rate-limited\)\. Your repository is unchanged/);
  assert.match(out.reason, /conductor resume/);
  assert.ok(out.workspaceDir, 'a paused run keeps its workspace');
  assert.equal(await refsOf(repo), before);
  const state = JSON.parse(readFileSync(path.join(`${out.workspaceDir}.conductor`, 'state.json'), 'utf8'));
  assert.equal(state.status, 'paused');
  const done = await resume({ workspaceDir: out.workspaceDir, repoDir: repo, team: makeTeam(), hooks: hooks() });
  assert.equal(done.status, 'landed');
});

test('a final review with nothing left pauses at the gate, never lands', async () => {
  const repo = await makeRepo();
  const h = hooks();
  const finalNobody = (role, task) => (/Review the whole branch/.test(task) ? NOBODY_R : approve());
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam({ reviewer: finalNobody }), hooks: h, baseDir: base() });
  assert.equal(out.status, 'paused');
  assert.equal(h.calls.filter((c) => c.name === 'approveResult').length, 0);
});

test('run warnings and paid API use reach the final summary', async () => {
  const repo = await makeRepo();
  const h = hooks();
  const t = makeTeam();
  t.reviewer = fakeParticipant({ name: 'gpt-api', kind: 'openai-api', script: () => ({ ...approve(), usage: { costUsd: 0.02 } }) });
  t.author = fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role) => (role === 'reviewer' ? approve() : planReply) });
  const out = await runTask({ repoDir: repo, request: 'x', team: t, hooks: h, baseDir: base(), warnings: ['WARNING-ONE', 'WARNING-ONE'] });
  assert.equal(out.status, 'landed');
  const summary = h.calls.find((c) => c.name === 'approveResult').arg.summary;
  assert.equal(summary.split('WARNING-ONE').length, 2, 'each warning appears once');
  assert.match(summary, /Paid API use this run: \d+ calls?, about \$0\.\d\d\./);
});

test('seats are bound to the transcript: their routing events are logged', async () => {
  const repo = await makeRepo();
  const events = [];
  const dead = new Participant({ name: 'claude', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true }, adapter: { kind: 'claude-code', run: async () => mkResult({ ok: false, error: 'HTTP 401: unauthorized', failure: 'infrastructure' }) } });
  const t = makeTeam();
  t.author = new Seat({ name: 'claude', candidates: [dead, t.author] });
  const out = await runTask({ repoDir: repo, request: 'x', team: t, hooks: hooks({ onEvent: (e) => events.push(e) }), baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.ok(events.some((e) => e.type === 'route-failover' && e.from === 'claude' && e.reason === 'unauthorized'));
});
```

(Add `import { Participant } from '../src/participant.js';` to `test/conductor.test.js` if it is not imported yet.)

`finalNobody` recognises the final-review prompt by the phrase `Review the whole branch`. Only `prompts.finalReview` contains that phrase.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the new tests FAIL. The status is `exhausted`/`failed`/`stopped` instead of `paused`, there is no `state.usage`, `warnings` is ignored, and there are no `route-failover` events.

- [ ] **Step 3: Implement**

`src/review.js`: in `reviewLoop`, replace the body of the `for` loop up to and including `history.push(...)` with:

```js
    artifact = await produce(round, feedback, feedbackKind);
    // No model left to do this at all: not a failed round, the run pauses (Seat 'no-participant').
    if (artifact?.pause) return { status: 'paused', artifact, lastGood, rounds: round, lastReason: String(artifact.pause), history };
    let v;
    if (artifact == null || artifact.error) {
      v = { decision: 'BLOCK', reason: `could not produce a result: ${artifact?.error ?? 'producer returned nothing'}` };
    } else {
      lastGood = artifact;
      const rv = await review(artifact, round);
      if (rv?.failure === 'no-participant') return { status: 'paused', artifact, lastGood, rounds: round, lastReason: String(rv.error), history };
      v = verdictOf(rv);
    }
    history.push({ round, ...v });
```

(The lines after it, `lastReason = v.reason;`, the fatal check, the approve return and the feedback lines, stay unchanged.)

`src/planPhase.js`:
- In `produce`, replace `if (!r.ok) return { error: \`author failed: ${r.error}\` };` with:

```js
      if (!r.ok) return r.failure === 'no-participant' ? { error: r.error, pause: r.error } : { error: `author failed: ${r.error}` };
```

- Directly after the `reviewLoop` call, before `if (loop.status === 'approved')`, add:

```js
  if (loop.status === 'paused') return { status: 'paused', reason: loop.lastReason };
```

`src/chunkPhase.js`:
- In `attempt`, replace the `if (!r.ok) return { ... fatal ... };` line with:

```js
      if (!r.ok) {
        // A frontier seat with no model left pauses the run; the local seat just falls back.
        if (r.failure === 'no-participant' && who !== team.local) return { error: r.error, pause: r.error };
        return { error: `${who.name} failed: ${r.error}`, fatal: who === team.local && LOCAL_FATAL.has(r.failure) };
      }
```

- Directly after `let loop = await reviewLoop({ ...local... });` add:

```js
  if (loop.status === 'paused') {
    await reset();
    return { status: 'paused', reason: loop.lastReason };
  }
```

- Directly after the fallback `loop = await reviewLoop({ ...fallback... });` line (inside the `if (loop.status !== 'approved')` block, before the `note =` line), add the same four-line `if (loop.status === 'paused') { ... }` block.

`src/runlog.js`:
- Add `import { isApiKind } from './vendors.js';`.
- In `callRole`, change the `call` event to:

```js
  log.event('call', { participant: participant.name, role, write: opts.write === true, task: clip(task, 1000) });
```

- In the `result` event object, add `servedBy: result.servedBy ?? null,` after `role,`.
- In `callAgent`, directly after `let result = await callRole(...)`, add:

```js
  // Usage totals (spec §7 budget awareness): cost as the CLIs/APIs report it, and paid API calls.
  const servedKind = result.servedKind ?? participant.adapter?.kind;
  const usage = (ctx.state.usage ??= { costUsd: 0, apiCostUsd: 0, apiCalls: 0 });
  const cost = result.usage?.costUsd;
  if (typeof cost === 'number' && Number.isFinite(cost)) {
    usage.costUsd += cost;
    if (isApiKind(servedKind)) usage.apiCostUsd += cost;
  }
  if (isApiKind(servedKind)) usage.apiCalls += 1;
```

`src/conductor.js`:
- Add the `pausedReason` constant shown above, below `INTERNAL_PROBLEM`.
- `stateProblem`: change the first line to `if (!['running', 'failed', 'paused'].includes(state.status)) return \`its status is ${state.status}\`;`.
- `runTask` signature: `export async function runTask({ repoDir, request, team, hooks, options = {}, baseDir, warnings = [] }) {`. After the `if (isUnderTmp(...)) state.warnings.push(TMP_BASEDIR_WARNING);` line, add:

```js
    for (const w of warnings) if (!state.warnings.includes(w)) state.warnings.push(w);
```

- `resume` signature: add `warnings = []` to the destructured parameters. Directly before `state.options = opts;`, add:

```js
  state.warnings ??= [];
  for (const w of warnings) if (!state.warnings.includes(w)) state.warnings.push(w);
```

- In `drive`, directly after the `finish` arrow function, add:

```js
  for (const member of new Set([team.author, team.reviewer, team.local])) member.bind?.((type, data) => log.event(type, data));
```

- Plan phase: change `if (p.status !== 'ok') return finish(p.status, { reason: p.reason });` to:

```js
      if (p.status === 'paused') return finish('paused', { reason: pausedReason(p.reason) });
      if (p.status !== 'ok') return finish(p.status, { reason: p.reason });
```

- Chunk loop: directly after `if (c.status === 'failed') return finish('failed', { reason: c.reason });`, add:

```js
        if (c.status === 'paused') return finish('paused', { reason: pausedReason(c.reason) });
```

- Final review: directly after the `const r = await callAgent(ctx, team.reviewer, 'reviewer', prompts.finalReview(...), {...});` statement, add:

```js
    if (r.failure === 'no-participant') return finish('paused', { reason: pausedReason(r.error) });
```

- Final summary: directly after `const warnings = [...(state.warnings ?? [])];`, add:

```js
    if (state.usage?.apiCalls) {
      const n = state.usage.apiCalls;
      const cost = state.usage.apiCostUsd > 0 ? `, about $${state.usage.apiCostUsd.toFixed(2)}.` : ' (the cost was not reported).';
      warnings.push(`Paid API use this run: ${n} call${n === 1 ? '' : 's'}${cost}`);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS, including every existing `conductor`, `chunkPhase` and `planPhase` test.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: paused runs when no model is left; usage totals; run warnings reach the summary"
```
