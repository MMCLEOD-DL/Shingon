# Task 1: Local failure kinds

Loop smoke run 2 showed two ways the local model wastes every retry:

- **A hung backend.** Each local round runs until the full 30-minute agent timeout.
- **A context overflow.** The same oversized prompt is sent again, and fails the same way.

This task adds two failure kinds, `timeout` and `context-overflow`. When the local model hits either one, it gives up at once and the frontier fallback takes over. Local calls also get their own, shorter timeout.

**Files:**
- Modify: `src/health.js`, `src/adapters/codex.js`, `src/adapters/claudeCode.js`, `src/chunkPhase.js`, `src/options.js`
- Test: `test/health.test.js`, `test/codex.test.js`, `test/claudeCode.test.js`, `test/chunkPhase.test.js` (append; one existing assertion changes, see Step 3)

**Interfaces:**
- Consumes (already exist):
  - `summarizeFailure(text)` and `isInfrastructureFailure(text)` from `src/health.js`.
  - `result.failure` from `makeResult`.
  - Codex classifies infrastructure only from its own `ERROR:` lines (master `179c675`).
- Produces:
  - `isContextOverflow(text) -> boolean` in `src/health.js`.
  - Adapters set `failure: 'timeout'` when the CLI timed out.
  - Codex sets `failure: 'context-overflow'` when its `ERROR:` line says so. Context overflow is checked BEFORE infrastructure, because an overflow often arrives as an HTTP 400 or 500.
  - `DEFAULT_OPTIONS.localTimeoutMs = 900000`.
  - `LOCAL_FATAL` in `src/chunkPhase.js` (exported) = `new Set(['infrastructure', 'timeout', 'context-overflow', 'no-participant'])`. A local failure of any of these kinds ends the local loop at once. (`no-participant` comes from Task 4 and is listed now so Task 4 needs no change here.)

- [ ] **Step 1: Write the failing tests**

Append to `test/health.test.js` (it already imports from `../src/health.js`; add `isContextOverflow` to that import line):

```js
test('isContextOverflow recognises the usual context-limit messages', () => {
  for (const s of [
    'ERROR: the request exceeds the available context size',
    'ERROR: unexpected status 400: prompt is too long: 40000 tokens > 32768 maximum',
    "ERROR: This model's maximum context length is 32768 tokens",
    'ERROR: input exceeds context window',
    'ERROR: n_ctx exceeded',
  ]) assert.equal(isContextOverflow(s), true, s);
  assert.equal(isContextOverflow('ERROR: stream disconnected before completion'), false);
  assert.equal(isContextOverflow(''), false);
});
```

Append to `test/codex.test.js`:

```js
test('a timed-out run is failure "timeout"', async () => {
  const bin = writeStubCli(tmp(), 'codex', `setTimeout(() => {}, 10000);`);
  const r = await new CodexAdapter({ bin }).run('grunt', 't', '', { timeoutMs: 300 });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'timed out');
  assert.equal(r.failure, 'timeout');
});

test('a context overflow wins over the infrastructure classification', async () => {
  const bin = writeStubCli(tmp(), 'codex', `process.stderr.write('ERROR: unexpected status 500: the request exceeds the available context size\\n'); process.exit(1);`);
  const r = await new CodexAdapter({ bin }).run('grunt', 't');
  assert.equal(r.failure, 'context-overflow');
});
```

Append to `test/claudeCode.test.js`:

```js
test('a timed-out claude run is failure "timeout"', async () => {
  const bin = writeStubCli(tmp(), 'claude', `setTimeout(() => {}, 10000);`);
  const r = await new ClaudeCodeAdapter({ bin }).run('author', 't', '', { timeoutMs: 300 });
  assert.equal(r.failure, 'timeout');
});
```

Append to `test/chunkPhase.test.js`:

```js
test('a local timeout or context overflow goes straight to the fallback', async () => {
  for (const failure of ['timeout', 'context-overflow']) {
    const t = team({ local: () => ({ ok: false, error: failure === 'timeout' ? 'timed out' : 'ERROR: context size exceeded', failure }) });
    const ctx = await ctxFor(t, { localRounds: 3 });
    const r = await runChunk(ctx, PLAN.chunks[0], 0);
    assert.equal(r.status, 'done', failure);
    assert.equal(t.local.calls.length, 1, failure);
  }
});

test('local calls use localTimeoutMs; the frontier fallback keeps agentTimeoutMs', async () => {
  const t = team({ local: () => ({ ok: false, error: 'timed out', failure: 'timeout' }) });
  const ctx = await ctxFor(t, { localTimeoutMs: 1234, agentTimeoutMs: 5678 });
  await runChunk(ctx, PLAN.chunks[0], 0);
  assert.equal(t.local.calls[0].opts.timeoutMs, 1234);
  assert.equal(t.author.calls.find((c) => c.role === 'author').opts.timeoutMs, 5678);
});

test('LOCAL_FATAL lists exactly the kinds that end the local loop', () => {
  assert.deepEqual([...LOCAL_FATAL].sort(), ['context-overflow', 'infrastructure', 'no-participant', 'timeout']);
});
```

and change that file's import line to `import { runChunk, chunkRoles, LOCAL_FATAL } from '../src/chunkPhase.js';`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: the new tests FAIL. `isContextOverflow` and `LOCAL_FATAL` are not exported, `failure` is null on a timeout, and the local loop retries 3 times.

- [ ] **Step 3: Implement**

`src/health.js`: add below `isInfrastructureFailure`:

```js
// The prompt did not fit the model's context window: sending it again cannot help.
const CONTEXT_OVERFLOW = /context (length|window|size)|maximum context|exceeds? the (available )?context|n_ctx|too many tokens|prompt is too long/i;

export function isContextOverflow(text = '') {
  return CONTEXT_OVERFLOW.test(String(text));
}
```

`src/adapters/codex.js`: change the import to `import { summarizeFailure, isInfrastructureFailure, isContextOverflow } from '../health.js';`. Then replace the failure block (the `if (code !== 0 || timedOut) { ... }` body) with:

```js
      if (code !== 0 || timedOut) {
        // Classify only Codex's own ERROR: lines, never raw stderr: it echoes the prompt there
        // (a task may mention "401"), and its last line may be the model's command output.
        const reason = summarizeFailure(stderr);
        const own = /^error:/i.test(reason);
        let failure = null;
        if (timedOut) failure = 'timeout';
        else if (own && isContextOverflow(reason)) failure = 'context-overflow';
        else if (own && isInfrastructureFailure(reason)) failure = 'infrastructure';
        return makeResult({ text: stdout, ok: false, error: timedOut ? 'timed out' : (reason || `exit ${code}`), failure });
      }
```

`src/adapters/claudeCode.js`: in the same block, change the `failure:` line to:

```js
        failure: timedOut ? 'timeout' : (isInfrastructureFailure(reason) ? 'infrastructure' : null),
```

`src/options.js`: add after `agentTimeoutMs`:

```js
  localTimeoutMs: 900000, // local grunt calls: a hung local backend gives up after 15 min, not 30
```

`src/chunkPhase.js`:
- Add below the imports:

```js
// Local failures that the same prompt to the same backend cannot fix: go to the fallback now.
export const LOCAL_FATAL = new Set(['infrastructure', 'timeout', 'context-overflow', 'no-participant']);
```

- In `runChunkFrom`, replace the single `writeOpts` line with:

```js
  const writeOpts = (who) => ({ cwd: ws.dir, write: true, timeoutMs: who === team.local ? options.localTimeoutMs : options.agentTimeoutMs });
```

- In `attempt`, change `prompts.chunkExec({ ... }), writeOpts);` to `prompts.chunkExec({ ... }), writeOpts(who));`.
- Change the `if (!r.ok)` line and its comment to:

```js
      // A local failure the same prompt cannot fix ends the local loop; the frontier
      // fallback keeps its retries (a 429 there may be a short per-minute limit).
      if (!r.ok) return { error: `${who.name} failed: ${r.error}`, fatal: who === team.local && LOCAL_FATAL.has(r.failure) };
```

The existing test `'local success becomes exactly one commit; reviewer sees the diff'` in `test/chunkPhase.test.js` asserts `timeoutMs: ctx.options.agentTimeoutMs` for `t.local.calls[0].opts`. Change that to `ctx.options.localTimeoutMs`. This is the intended behaviour change: local calls now use the local timeout.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (289 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/health.js src/adapters src/chunkPhase.js src/options.js test
git commit -m "feat: local timeout and context overflow go straight to the frontier fallback"
```
