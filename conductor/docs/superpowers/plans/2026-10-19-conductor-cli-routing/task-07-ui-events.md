# Task 7: Vendor tracking, UI events & gate note

This task makes the run's record tell the truth about who did what, and adds what the terminal needs.

- **Same-vendor reviews.** When a frontier model's work was reviewed by a model **from the same vendor**, whether the Seats collapsed mid-run or the team was built that way, the run is flagged. The final summary then says the cross-checking was weaker (`SAME_VENDOR_WARNING`).
- **Who actually did a step.** The "done by X because the local model could not finish it" note names the participant that actually produced the step (`servedBy`), not the Seat.
- **New events and fields for the status view and `--watch-diffs`:** `plan-agreed`; `chunk-done` gains `files`, `by` and an optional `diff`; escalations carry the transcript path for "[s] see details".
- **"Reject with a note"** at the final gate (spec §8) keeps the user's note in the outcome and the transcript.
- **Optional plan approval** (spec §8 stop point 1, off by default): with `options.approvePlan`, the agreed plan goes to a new `approvePlan` hook before any step runs.

**Files:**
- Modify: `src/runlog.js`, `src/planPhase.js`, `src/chunkPhase.js`, `src/conductor.js`, `src/askUser.js`, `src/options.js`
- Test: `test/chunkPhase.test.js`, `test/planPhase.test.js`, `test/conductor.test.js`, `test/askUser.test.js` (append)

**Interfaces:**
- Consumes:
  - `vendorOf` (Task 2);
  - `SAME_VENDOR_WARNING` (Task 5, `src/team.js`);
  - `servedBy`/`servedKind` on results (Task 4);
  - `clip` (`src/text.js`);
  - `redact` (`src/secrets.js`);
  - `ws.filesRange(from, to)` and `ws.diffRange(from, to)` (`src/workspace.js`).
- Produces:
  - **`noteSameVendor`.** `noteSameVendor(ctx, { phase, index = null, producerVendor, result, participant })`, exported from `src/runlog.js`.
    - When `result.ok` and `vendorOf(result.servedKind ?? participant.adapter.kind) === producerVendor`, it sets `ctx.state.flags.sameVendor = true` and logs `same-vendor-review { phase, index, vendor }`.
    - The `local` vendor never counts.
  - **Artifact fields.** Producer artifacts in the plan and chunk phases carry `producedBy` (`r.servedBy ?? who.name`) and `vendor`.
  - **`plan-agreed` event.** `{ chunks: string[] (titles), rounds, author, reviewer }`, logged once whenever `runPlanPhase` returns `status: 'ok'`.
    - `author` is the `producedBy` of the plan used.
    - `reviewer` is the `servedBy` of the last review, else `team.reviewer.name`.
  - **`chunk-done` event.** It gains `files` (from `ws.filesRange(base, sha)`) and `by` (who produced the step). When `options.watchDiffs`, it also gains `diff` (`clip(ws.diffRange(base, sha), 20000)`). `DEFAULT_OPTIONS.watchDiffs = false`.
  - **Final summary.** It includes `SAME_VENDOR_WARNING` (once) when `state.flags?.sameVendor`.
  - **Gate note.** When `approveResult` returns an object whose `note` is a non-empty string, the run finishes `rejected` with `note` (trimmed, `redact`ed, clipped to 2000) in the outcome, and logs `gate-note { note }`. Only exactly `true` lands; `{ approved: true }` is still a rejection.
  - **Escalation transcript.** The escalation object passed to `hooks.escalate` gains `transcript` (`ctx.log.transcript`).
  - **Plan approval.**
    - `DEFAULT_OPTIONS.approvePlan = false`.
    - `validateHooks` requires `hooks.approvePlan` to be a function when `approvePlan` is set (error: `hooks.approvePlan is required when approvePlan is set`).
    - After the plan phase succeeds, and **before** `phase` becomes `'chunks'` (so a Ctrl-C at that prompt re-plans and asks again on resume), `drive` calls `approvePlan(redact({ summary, steps, note }))`. Here `steps` are the chunk titles and `note` is the plan note in plain words, or null.
    - Anything but exactly `true` finishes the run `stopped` with reason `You did not approve the plan, so nothing was changed.`

- [ ] **Step 1: Write the failing tests**

Append to `test/chunkPhase.test.js`:

```js
import { Participant as P7 } from '../src/participant.js';
import { makeResult as mk7 } from '../src/result.js';

// A participant whose results look Seat-served: servedBy/servedKind set.
function served(name, kind, servedBy, servedKind, script) {
  return new P7({
    name, roles: ['author', 'reviewer', 'grunt'], capabilities: { is_agentic: true, can_edit_files: true },
    adapter: { kind, run: async (...a) => Object.assign(mk7(await script(...a)), { servedBy, servedKind }) },
  });
}

test('the fallback note names who actually produced the step', async () => {
  const t = team({ local: () => ({ ok: false, error: 'timed out', failure: 'timeout' }) });
  t.author = served('claude', 'claude-code', 'codex-backup', 'codex', writes('a.txt'));
  const r = await runChunk(await ctxFor(t), PLAN.chunks[0], 0);
  assert.match(r.note, /was done by codex-backup because the local model could not finish it/);
});

test('a frontier step reviewed by the same vendor is flagged; local work never is', async () => {
  const events = [];
  const t = team({ local: () => ({ ok: false, error: 'timed out', failure: 'timeout' }) });
  t.reviewer = fakeParticipant({ name: 'other-claude', kind: 'claude-code', script: approve });
  const ctx = await ctxFor(t, {}, { onEvent: (e) => events.push(e) });
  await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(ctx.state.flags?.sameVendor, true);
  assert.ok(events.some((e) => e.type === 'same-vendor-review' && e.phase === 'chunk' && e.index === 0 && e.vendor === 'anthropic'));

  const clean = team({ local: writes('a.txt') });
  clean.reviewer = fakeParticipant({ name: 'other-claude', kind: 'claude-code', script: approve });
  const ctx2 = await ctxFor(clean);
  await runChunk(ctx2, PLAN.chunks[0], 0);
  assert.equal(ctx2.state.flags?.sameVendor, undefined);
});

test('chunk-done carries files and who did it; the diff only with watchDiffs', async () => {
  for (const watchDiffs of [false, true]) {
    const events = [];
    const ctx = await ctxFor(team({ local: writes('a.txt', 'hello\n') }), { watchDiffs }, { onEvent: (e) => events.push(e) });
    await runChunk(ctx, PLAN.chunks[0], 0);
    const done = events.find((e) => e.type === 'chunk-done');
    assert.deepEqual(done.files, ['a.txt']);
    assert.equal(done.by, 'local');
    if (watchDiffs) assert.match(done.diff, /\+hello/);
    else assert.equal('diff' in done, false);
  }
});
```

Append to `test/planPhase.test.js`:

```js
test('plan-agreed names the chunks, rounds, author and reviewer', async () => {
  const events = [];
  const reviews = [block('too big'), approve()];
  const t = team({ author: planReply, reviewer: () => reviews.shift() });
  const ctx = await makeCtx({ team: t, hooks: { onEvent: (e) => events.push(e) } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'ok');
  const agreed = events.filter((e) => e.type === 'plan-agreed');
  assert.equal(agreed.length, 1);
  assert.deepEqual({ chunks: agreed[0].chunks, rounds: agreed[0].rounds, author: agreed[0].author, reviewer: agreed[0].reviewer },
    { chunks: ['A'], rounds: 2, author: 'claude', reviewer: 'codex' });
});
```

Append to `test/askUser.test.js`:

```js
test('the escalation carries the transcript path for "see details"', async () => {
  let got = null;
  const ctx = await makeCtx({ hooks: { escalate: async (e) => { got = e; return 'reject'; } } });
  await askUser(ctx, esc);
  assert.equal(got.transcript, ctx.log.transcript);
});
```

Append to `test/conductor.test.js`:

```js
import { SAME_VENDOR_WARNING } from '../src/team.js';

test('a same-vendor run says so once in the summary (Review Focus 4)', async () => {
  const h = hooks();
  const t = makeTeam();
  t.reviewer = fakeParticipant({ name: 'claude-2', kind: 'claude-code', script: () => approve() });
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: t, hooks: h, baseDir: base(), options: { allowSameVendor: true }, warnings: [SAME_VENDOR_WARNING] });
  assert.equal(out.status, 'landed');
  const summary = h.calls.find((c) => c.name === 'approveResult').arg.summary;
  assert.equal(summary.split(SAME_VENDOR_WARNING).length, 2);
});

test('the plan-agreed event reaches onEvent during a real run', async () => {
  const events = [];
  await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: hooks({ onEvent: (e) => events.push(e) }), baseDir: base() });
  const agreed = events.find((e) => e.type === 'plan-agreed');
  assert.deepEqual(agreed.chunks, ['One', 'Two']);
  assert.equal(agreed.author, 'claude');
});

test('approvePlan: shown the plan before any step; anything but true stops', async () => {
  let seen = null;
  const t = makeTeam();
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: t, hooks: hooks({ approvePlan: async (p) => { seen = p; return 'yes'; } }), baseDir: base(), options: { approvePlan: true } });
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, 'You did not approve the plan, so nothing was changed.');
  assert.deepEqual(seen.steps, ['One', 'Two']);
  assert.equal(t.local.calls.length, 0);
  const ok = await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: hooks({ approvePlan: async () => true }), baseDir: base(), options: { approvePlan: true } });
  assert.equal(ok.status, 'landed');
  await assert.rejects(runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base(), options: { approvePlan: true } }), /hooks\.approvePlan is required/);
});

test('reject with a note keeps the note; only exactly true lands', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const noted = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveResult: async () => ({ approved: false, note: '  please use smaller steps  ' }) }), baseDir: base() });
  assert.equal(noted.status, 'rejected');
  assert.equal(noted.note, 'please use smaller steps');
  assert.match(readFileSync(noted.transcript, 'utf8'), /"type":"gate-note"[^\n]*please use smaller steps/);
  const objTrue = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveResult: async () => ({ approved: true }) }), baseDir: base() });
  assert.equal(objTrue.status, 'rejected');
  assert.equal('note' in objTrue, false);
  assert.equal(await refsOf(repo), before);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the new tests FAIL. The note says `claude`, there is no `same-vendor-review`/`plan-agreed` event, `chunk-done` has no `files`, there is no `transcript` on the escalation, and the outcome has no `note`.

- [ ] **Step 3: Implement**

`src/options.js`: add after `allowSameVendor`:

```js
  watchDiffs: false,      // true: chunk-done events carry the step's diff (--watch-diffs)
  approvePlan: false,     // true: the user approves the agreed plan before any step runs (spec §8 stop point 1)
```

`src/runlog.js`:
- Add `import { vendorOf } from './vendors.js';`. Task 6 already imports `isApiKind` from the same module, so merge them into one line: `import { vendorOf, isApiKind } from './vendors.js';`.
- Add:

```js
// Two-vendor rule at run time (spec §7): a frontier model's work reviewed by the same
// vendor is allowed, but the run is flagged so the summary can say so. Local work never counts.
export function noteSameVendor(ctx, { phase, index = null, producerVendor, result, participant }) {
  if (!producerVendor || producerVendor === 'local' || !result?.ok) return;
  const vendor = vendorOf(result.servedKind ?? participant.adapter?.kind);
  if (vendor !== producerVendor) return;
  ctx.state.flags ??= {};
  ctx.state.flags.sameVendor = true;
  ctx.log.event('same-vendor-review', { phase, index, vendor });
}
```

`src/askUser.js`: change the first line of `askUser` to:

```js
  const esc = redact({ ...buildEscalation({ kind, title, reason, recommendation, situation }), transcript: ctx.log.transcript });
```

`src/planPhase.js`:
- Change the imports: `import { callAgent, noteSameVendor } from './runlog.js';` and add `import { vendorOf } from './vendors.js';`.
- Replace the `reviewLoop({...})` call with:

```js
  let lastReviewer = team.reviewer.name;
  const loop = await reviewLoop({
    maxRounds: options.planRounds,
    produce: async (round, feedback, feedbackKind) => {
      const r = await callAgent(ctx, team.author, 'author',
        prompts.planAuthor({ request, maxChunks: options.maxChunks, feedback, feedbackKind }), opts);
      if (!r.ok) return r.failure === 'no-participant' ? { error: r.error, pause: r.error } : { error: `author failed: ${r.error}` };
      const parsed = parsePlan(r.text, { maxChunks: options.maxChunks });
      const who = { producedBy: r.servedBy ?? team.author.name, vendor: vendorOf(r.servedKind ?? team.author.adapter.kind) };
      return parsed.ok ? { plan: parsed.plan, text: r.text, ...who } : { error: parsed.error };
    },
    review: async (a) => {
      const rv = await callAgent(ctx, team.reviewer, 'reviewer', prompts.planReview({ request, planText: a.text }), opts);
      noteSameVendor(ctx, { phase: 'plan', producerVendor: a.vendor, result: rv, participant: team.reviewer });
      if (rv.ok) lastReviewer = rv.servedBy ?? team.reviewer.name;
      return rv;
    },
  });
  const agreed = (artifact) => log.event('plan-agreed', {
    chunks: artifact.plan.chunks.map((c) => c.title), rounds: loop.rounds, author: artifact.producedBy, reviewer: lastReviewer,
  });
```

- Change each of the three `return { status: 'ok', ... }` statements so that it first calls `agreed(...)` with the artifact whose plan it returns:
  - the approved return becomes `{ agreed(loop.artifact); return { status: 'ok', plan: loop.artifact.plan, note: null }; }`, written as an `if` block;
  - the two settle/approve returns call `agreed(loop.lastGood);` before returning `loop.lastGood.plan`.

`src/chunkPhase.js`:
- Change the imports: `import { callAgent, noteSameVendor } from './runlog.js';`, and add `import { vendorOf } from './vendors.js';` and `import { clip } from './text.js';`.
- In `attempt`, change the success return `return { diff, tests, base };` to:

```js
        return { diff, tests, base, producedBy: r.servedBy ?? who.name, vendor: vendorOf(r.servedKind ?? who.adapter.kind) };
```

- Replace the `review` arrow with:

```js
  const review = async (a) => {
    const rv = await callAgent(ctx, reviewer, 'reviewer',
      prompts.chunkReview({ request, plan, chunk, index, total, diff: a.diff, tests: a.tests, base }), readOpts);
    noteSameVendor(ctx, { phase: 'chunk', index, producerVendor: a.vendor, result: rv, participant: reviewer });
    return rv;
  };
```

- Change the fallback note line to:

```js
    note = `${step} was done by ${loop.artifact?.producedBy ?? fallback.name} because the local model could not finish it.`;
```

- Replace `log.event('chunk-done', { index, sha });` with:

```js
  const done = { index, sha, files: await ws.filesRange(base, sha), by: loop.artifact?.producedBy ?? null };
  if (options.watchDiffs) done.diff = clip(await ws.diffRange(base, sha), 20000);
  log.event('chunk-done', done);
```

`src/conductor.js`:
- Add `import { SAME_VENDOR_WARNING } from './team.js';` and `import { clip } from './text.js';`.
- In the final phase, directly after the paid-API block that Task 6 added, add:

```js
    if (state.flags?.sameVendor && !warnings.includes(SAME_VENDOR_WARNING)) warnings.push(SAME_VENDOR_WARNING);
```

- In `validateHooks`, after the `approveEachChunk` check, add:

```js
  if (options.approvePlan && typeof hooks.approvePlan !== 'function') {
    throw new Error('hooks.approvePlan is required when approvePlan is set');
  }
```

- In the plan block of `drive`, replace the lines from `state.plan = p.plan;` through `log.saveState(state);` with:

```js
      state.plan = p.plan;
      if (p.note) state.notes.push(p.note);
      // Spec §8 stop point 1 (off by default). Asked before phase moves on, so a Ctrl-C here re-plans and asks again on resume.
      if (options.approvePlan) {
        const ok = await safeHook(log, 'approvePlan', hooks.approvePlan, redact({
          summary: state.plan.summary, steps: state.plan.chunks.map((c) => c.title), note: p.note ? plainReason(p.note) : null,
        }));
        if (ok !== true) return finish('stopped', { reason: 'You did not approve the plan, so nothing was changed.' });
      }
      Object.assign(state, { phase: 'chunks', chunkIndex: 0, chunkShas: [] });
      log.saveState(state);
```

- Replace `if (approved !== true) return finish('rejected', { reason: 'You did not approve the result.' });` with:

```js
    if (approved !== true) {
      // "[n] reject with a note" (spec §8): keep the user's words with the run.
      const raw = approved && typeof approved === 'object' && typeof approved.note === 'string' ? approved.note.trim() : '';
      const note = raw ? clip(redact(raw), 2000) : null;
      if (note) log.event('gate-note', { note });
      return finish('rejected', { reason: 'You did not approve the result.', ...(note ? { note } : {}) });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS. The existing `fallback` note tests still pass: with plain fakes, `servedBy` is undefined, so `producedBy` is the participant's own name.

- [ ] **Step 5: Commit**

```bash
git add src test
git commit -m "feat: same-vendor flag, real producer in notes, plan-agreed/chunk-done fields, gate note"
```
