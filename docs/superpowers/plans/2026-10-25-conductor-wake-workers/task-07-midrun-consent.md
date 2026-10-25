# Task 7: Mid-run consent

The pre-run check (Task 8) cannot catch a worker that goes down **during** a run: the desktop sleeps, the worker container stops, or LocalAI loses its node. Today the chunk phase then hands the step to Claude or Codex without a word.

With this task, when the local loop ends and the local model looks **down**, the chunk phase asks once per run through a new hook before the frontier fallback runs. "Down" means either:
- the failure says so: `infrastructure` or `no-participant` (`LOCAL_UNREACHABLE`); or
- the failure is ambiguous and a fresh probe says so. A worker that disappears mid-call (the desktop sleeps, the LocalAI node drops while the TCP connection to CT110 stays open) usually ends as a `timeout`, and an unclassified backend error ends as a plain failure. For any local failure except `context-overflow`, the chunk phase re-probes the local model once with `checkHealth` (60 s budget, as before a run). If that probe fails, the step counts as "local down" and the operator is asked; if it answers, the local model was up and just could not finish, so the fallback runs without a question.

The answers:
- Yes (exactly `true`) records consent in `state.flags.localFallbackOk`, so later steps do not ask again, and adds `LOCAL_DOWN_WARNING` to the run's warnings.
- Anything else resets the workspace to the step's base and pauses the run. `conductor resume` later starts with the readiness check again (Task 8). A hook may say **why** it declined by returning `{ reason: '<plain text>' }`; the CLI uses this when `routing.localDown` is `"pause"`, because then the operator made no choice in this run (`LOCAL_PAUSE_SETTING_REASON`). Every other "no" uses `LOCAL_DECLINED_REASON`.

Local failures that are clearly about the model's **work** still fall back with no question, as today: review rejections (the loop exhausted with real diffs), a context overflow, or an ambiguous failure while the re-probe shows the model up. That is the MVP loop the operator already accepted, and the summary keeps saying so.

The option is off by default (`confirmLocalFallback: false`), so library callers and the existing tests are unchanged, and nothing is re-probed. The CLI turns it on (Task 8).

**Files:**
- Modify: `src/chunkPhase.js`, `src/conductor.js`, `src/options.js`
- Test: `test/chunkPhase.test.js` (append), `test/conductor.test.js` (append)

**Interfaces:**
- Consumes:
  - `LOCAL_DOWN_WARNING` (`src/team.js`);
  - `checkHealth` (`src/health.js`), `redact` (`src/secrets.js`);
  - `ctx.hooks`, `ctx.state`, `ctx.log`, `ctx.options`, `ctx.team` (existing);
  - the attempt artifact from `attempt()` in `runChunkFrom`;
  - `reviewLoop` returning `loop.artifact` (the last artifact).
- Produces:
  - `DEFAULT_OPTIONS.confirmLocalFallback = false`.
  - `LOCAL_UNREACHABLE = new Set(['infrastructure', 'no-participant'])`, exported from `src/chunkPhase.js`.
  - `LOCAL_DECLINED_REASON = 'the local model stopped answering, and you chose not to use your subscription for its steps'`, exported from `src/chunkPhase.js`. Through the existing `pausedReason` it reads "Conductor paused: the local model stopped answering, … run "conductor resume" when it is available again."
  - `LOCAL_PAUSE_SETTING_REASON = 'the local model stopped answering, and your settings say to pause instead of using your subscription'`, exported from `src/chunkPhase.js` (the CLI's `"pause"` hook returns it as `{ reason }`).
  - The attempt artifact for a failed call gains `localFailed` (`who === team.local`), `localFailure` (`r.failure` for the local, else `null`) and `localDown` (`localFailed && LOCAL_UNREACHABLE.has(r.failure)`).
  - The local re-probe: `checkHealth((team.local.candidates?.[0] ?? team.local).adapter, { timeoutMs: 60000 })`. A Seat's real adapter sits on its first candidate; a plain Participant (the tests) carries it directly. A throw counts as down. It logs `local-recheck { index, ok, reason }`, and a failed probe sets `artifact.localDown = true`.
  - In `runChunkFrom`, after the local loop's `paused` check and before `chunk-fallback`, consent is asked only when **all** of these hold, checked in this order (so the re-probe runs only when it can matter):
    - `loop.status !== 'approved'`;
    - `options.confirmLocalFallback`;
    - `!state.flags?.localFallbackOk`;
    - the local is down: `loop.artifact.localDown`, or the re-probe above failed for a `localFailed` artifact whose `localFailure !== 'context-overflow'`.

    The call is `await ctx.hooks.confirmLocalFallback(redact({ index, title: chunk.title, reason: loop.lastReason }))`, inside `try/catch`, where a throw counts as "no" and logs `hook-error` (`{ hook: 'confirmLocalFallback', error }`).
    - Exactly `true` → `state.flags ??= {}; state.flags.localFallbackOk = true`. Then `state.warnings ??= []` and push `LOCAL_DOWN_WARNING` if it is absent, log `local-fallback-approved { index }`, and carry on to the existing fallback.
    - Otherwise → log `local-fallback-declined { index }`, `await reset()`, and return `{ status: 'paused', reason }`, where `reason` is the answer's non-empty string `reason` property if it has one, else `LOCAL_DECLINED_REASON`.
  - `validateHooks` (used by `runTask` and `resume`, next to the `approvePlan` check): `if (options.confirmLocalFallback && typeof hooks.confirmLocalFallback !== 'function') throw new Error('hooks.confirmLocalFallback is required when confirmLocalFallback is set')`.

- [ ] **Step 1: Write the failing tests**

Append to `test/chunkPhase.test.js`. It uses the file's own `team`, `ctxFor`, `writes` and `PLAN` helpers. `makeCtx` passes `hooks.onEvent` to the `RunLog`, which is how the events are collected.

```js
import { LOCAL_DECLINED_REASON, LOCAL_PAUSE_SETTING_REASON } from '../src/chunkPhase.js';
import { LOCAL_DOWN_WARNING } from '../src/team.js';

const UNREACHABLE = () => ({ ok: false, failure: 'no-participant', error: 'no AI model is available for local (local: not reachable)' });
const collect = (events) => (e) => events.push(e);

test('local unreachable mid-run: asks once; yes falls back and records consent', async () => {
  const asked = [];
  const events = [];
  const t = team({ local: UNREACHABLE });
  const ctx = await ctxFor(t, { confirmLocalFallback: true }, { onEvent: collect(events), confirmLocalFallback: async (q) => { asked.push(q); return true; } });
  const r1 = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r1.status, 'done');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].index, 0);
  assert.equal(asked[0].title, 'Add a');
  assert.match(asked[0].reason, /not reachable/);
  assert.equal(ctx.state.flags.localFallbackOk, true);
  assert.ok(ctx.state.warnings.includes(LOCAL_DOWN_WARNING));
  assert.ok(events.some((e) => e.type === 'local-fallback-approved' && e.index === 0));
  assert.ok(events.some((e) => e.type === 'chunk-fallback'));
  const r2 = await runChunk(ctx, PLAN.chunks[1], 1);
  assert.equal(r2.status, 'done');
  assert.equal(asked.length, 1, 'a second step does not ask again');
});

test('local unreachable mid-run: no, a non-true answer or a throwing hook pauses at the step base with no frontier edit (Review Focus 5)', async () => {
  for (const hook of [async () => false, async () => 'yes', async () => { throw new Error('tty gone'); }]) {
    const events = [];
    const t = team({ local: UNREACHABLE });
    const ctx = await ctxFor(t, { confirmLocalFallback: true }, { onEvent: collect(events), confirmLocalFallback: hook });
    const base = await ctx.ws.head();
    const r = await runChunk(ctx, PLAN.chunks[0], 0);
    assert.deepEqual(r, { status: 'paused', reason: LOCAL_DECLINED_REASON });
    assert.equal(t.author.calls.filter((c) => c.opts.write).length, 0, 'the frontier never edited');
    assert.equal(await ctx.ws.head(), base);
    assert.ok(events.some((e) => e.type === 'local-fallback-declined'));
    assert.equal(ctx.state.flags?.localFallbackOk, undefined);
  }
});

test('a hook can say why it declined (localDown "pause")', async () => {
  const t = team({ local: UNREACHABLE });
  const ctx = await ctxFor(t, { confirmLocalFallback: true }, { confirmLocalFallback: async () => ({ reason: LOCAL_PAUSE_SETTING_REASON }) });
  assert.deepEqual(await runChunk(ctx, PLAN.chunks[0], 0), { status: 'paused', reason: LOCAL_PAUSE_SETTING_REASON });
});

test('local failing on the work itself (context overflow) still falls back without asking or probing', async () => {
  let asked = 0;
  let probed = 0;
  const t = team({ local: () => ({ ok: false, failure: 'context-overflow', error: 'prompt is too long' }) });
  t.local.adapter.probe = async () => { probed++; return { ok: false, reason: 'unavailable' }; };
  const ctx = await ctxFor(t, { confirmLocalFallback: true }, { confirmLocalFallback: async () => { asked++; return false; } });
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.equal(asked, 0);
  assert.equal(probed, 0);
});

const TIMED_OUT = () => ({ ok: false, failure: 'timeout', error: 'the local model did not finish in time' });

test('local times out and a fresh probe says it is down: the operator is asked', async () => {
  const events = [];
  const asked = [];
  const t = team({ local: TIMED_OUT });
  t.local.adapter.probe = async ({ timeoutMs }) => { assert.equal(timeoutMs, 60000); return { ok: false, reason: 'unavailable', detail: 'the local model did not answer in time' }; };
  const ctx = await ctxFor(t, { confirmLocalFallback: true }, { onEvent: collect(events), confirmLocalFallback: async (q) => { asked.push(q); return false; } });
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.deepEqual(r, { status: 'paused', reason: LOCAL_DECLINED_REASON });
  assert.equal(asked.length, 1);
  assert.ok(events.some((e) => e.type === 'local-recheck' && e.ok === false && e.reason === 'unavailable'));
  assert.equal(t.author.calls.filter((c) => c.opts.write).length, 0);
});

test('local times out but a fresh probe says it is up: falls back without asking', async () => {
  const events = [];
  let asked = 0;
  const t = team({ local: TIMED_OUT });
  t.local.adapter.probe = async () => ({ ok: true, reason: '' });
  const ctx = await ctxFor(t, { confirmLocalFallback: true }, { onEvent: collect(events), confirmLocalFallback: async () => { asked++; return false; } });
  const r = await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(r.status, 'done');
  assert.equal(asked, 0);
  assert.ok(events.some((e) => e.type === 'local-recheck' && e.ok === true));
  assert.ok(events.some((e) => e.type === 'chunk-fallback'));
});

test('a probe that throws counts as down', async () => {
  let asked = 0;
  const t = team({ local: TIMED_OUT });
  t.local.adapter.probe = async () => { throw new Error('socket hang up'); };
  const ctx = await ctxFor(t, { confirmLocalFallback: true }, { confirmLocalFallback: async () => { asked++; return true; } });
  assert.equal((await runChunk(ctx, PLAN.chunks[0], 0)).status, 'done');
  assert.equal(asked, 1);
});

test('confirmLocalFallback off (the library default): unreachable local falls back as before', async () => {
  const t = team({ local: UNREACHABLE });
  const ctx = await ctxFor(t);
  assert.equal((await runChunk(ctx, PLAN.chunks[0], 0)).status, 'done');
});
```

Append to `test/conductor.test.js`, reusing that file's existing `runTask` setup helper:

```js
test('confirmLocalFallback without its hook is a programming error', async () => {
  await assert.rejects(runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base(), options: { confirmLocalFallback: true } }),
    /hooks\.confirmLocalFallback is required when confirmLocalFallback is set/);
});
```

(`makeRepo`, `makeTeam`, `hooks` and `base` are the helpers the `approvePlan` hook-required test in that file already uses.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/chunkPhase.test.js test/conductor.test.js`
Expected: FAIL. `LOCAL_PAUSE_SETTING_REASON` is not exported, no question is asked, nothing is re-probed, the step falls back, and the missing hook is not rejected.

- [ ] **Step 3: Implement**

`src/options.js`, add after `approvePlan`:

```js
  confirmLocalFallback: false, // true: ask (hooks.confirmLocalFallback) before the frontier does a step because the local model is down (factory spec §4.2)
```

`src/conductor.js`, at the end of `validateHooks`:

```js
  if (options.confirmLocalFallback && typeof hooks.confirmLocalFallback !== 'function') {
    throw new Error('hooks.confirmLocalFallback is required when confirmLocalFallback is set');
  }
```

`src/chunkPhase.js`, add to the imports:

```js
import { checkHealth } from './health.js';
import { redact } from './secrets.js';
import { LOCAL_DOWN_WARNING } from './team.js';
```

Under `LOCAL_FATAL`, add:

```js
// The local model cannot be reached at all: the frontier may not cover for it without consent (factory spec §4.2).
export const LOCAL_UNREACHABLE = new Set(['infrastructure', 'no-participant']);
export const LOCAL_DECLINED_REASON = 'the local model stopped answering, and you chose not to use your subscription for its steps';
export const LOCAL_PAUSE_SETTING_REASON = 'the local model stopped answering, and your settings say to pause instead of using your subscription';
const LOCAL_RECHECK_TIMEOUT_MS = 60000; // the same budget as the pre-run local probe

// A Seat's real adapter sits on its first candidate; a plain Participant carries it directly.
const localAdapterOf = (local) => (local.candidates?.[0] ?? local).adapter;

// Is the local model down, rather than failing at the work? Sure for an unreachable failure; for an
// ambiguous one (a hang ends as 'timeout') ask the model server once. A context overflow is always the work.
async function localWentDown(ctx, index, artifact) {
  if (artifact?.localDown) return true;
  if (!artifact?.localFailed || artifact.localFailure === 'context-overflow') return false;
  let h;
  try {
    h = await checkHealth(localAdapterOf(ctx.team.local), { timeoutMs: LOCAL_RECHECK_TIMEOUT_MS });
  } catch {
    h = { ok: false, reason: 'unavailable' };
  }
  const down = h?.ok !== true;
  ctx.log.event('local-recheck', { index, ok: !down, reason: down ? (h?.reason || 'unavailable') : '' });
  if (down) artifact.localDown = true;
  return down;
}
```

In `attempt()`, replace the `!r.ok` branch's last line

```js
        return { error: `${who.name} failed: ${r.error}`, fatal: who === team.local && LOCAL_FATAL.has(r.failure) };
```

with:

```js
        const isLocal = who === team.local;
        return {
          error: `${who.name} failed: ${r.error}`,
          fatal: isLocal && LOCAL_FATAL.has(r.failure),
          localFailed: isLocal,
          localFailure: isLocal ? r.failure : null,
          localDown: isLocal && LOCAL_UNREACHABLE.has(r.failure),
        };
```

Then, in `runChunkFrom`, replace

```js
  if (loop.status !== 'approved') {
    log.event('chunk-fallback', { index, to: fallback.name, reason: loop.lastReason });
```

with:

```js
  // Mid-run consent (factory spec §4.2): the local model went down, so covering for it spends the
  // operator's subscription. Asked once per run; only exactly true goes ahead.
  if (loop.status !== 'approved' && options.confirmLocalFallback && !state.flags?.localFallbackOk && (await localWentDown(ctx, index, loop.artifact))) {
    let answer;
    try {
      answer = await ctx.hooks.confirmLocalFallback(redact({ index, title: chunk.title, reason: loop.lastReason }));
    } catch (e) {
      log.event('hook-error', { hook: 'confirmLocalFallback', error: String(e?.message ?? e) });
      answer = undefined;
    }
    if (answer !== true) {
      log.event('local-fallback-declined', { index });
      await reset();
      const why = typeof answer?.reason === 'string' && answer.reason ? answer.reason : LOCAL_DECLINED_REASON;
      return { status: 'paused', reason: why };
    }
    state.flags ??= {};
    state.flags.localFallbackOk = true;
    state.warnings ??= [];
    if (!state.warnings.includes(LOCAL_DOWN_WARNING)) state.warnings.push(LOCAL_DOWN_WARNING);
    log.event('local-fallback-approved', { index });
  }

  if (loop.status !== 'approved') {
    log.event('chunk-fallback', { index, to: fallback.name, reason: loop.lastReason });
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/chunkPhase.js src/conductor.js src/options.js test/chunkPhase.test.js test/conductor.test.js
git commit -m "feat: ask before the frontier covers a step when the local model goes down mid-run"
```
