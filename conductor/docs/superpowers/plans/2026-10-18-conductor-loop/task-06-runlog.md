# Task 6: Run log, state, safe calls & test fakes

Everything a run records lives in `<workspace>/.git/conductor/`: an append-only transcript (`transcript.jsonl`, the audit trail) and `state.json` (what `resume` reads). Because it sits inside `.git`, agents' work can never commit it. `callRole` wraps every participant call so that a crash becomes an `ok:false` Result and never throws out of the loop. This task also adds the shared test fakes that Tasks 7–9 use.

**Files:**
- Create: `src/options.js`, `src/runlog.js`, `test/helpers/fakes.js`
- Test: `test/runlog.test.js`

**Interfaces:**
- Consumes: `makeResult` (Plan 1), `Participant` (Plan 1, with Task 1 opts), `clip` (Task 2), `Workspace` (Task 2), `makeRepo` (Task 2 helper).
- Produces:
  - `DEFAULT_OPTIONS = { planRounds: 3, localRounds: 3, frontierRounds: 2, maxChunks: 12, testCommand: null, testTimeoutMs: 600000, agentTimeoutMs: 1800000, approveEachChunk: false }` (frozen).
  - `class RunLog`
    - `constructor(workspaceDir, { onEvent } = {})` creates `.git/conductor/`.
    - `event(type, data = {}) -> entry` appends `{ ts, type, ...data }` as one JSON line, then calls `onEvent(entry)`. A throwing `onEvent` is ignored.
    - `saveState(state)` writes atomically (temp file + rename).
    - `loadState() -> object | null` returns null if no state; throws `corrupt run state` if unparsable.
  - `callRole(log, participant, role, task, context = '', opts = {}) -> Promise<Result>` — logs `call` and `result` events (text clipped to 2000 chars), never throws.
  - `test/helpers/fakes.js`:
    - `fakeParticipant({ name, kind = name, roles, script }) -> Participant` with `.calls` (array of `{ role, task, context, opts }`). `script(role, task, context, opts, n)` returns a partial Result (it may throw, or write files into `opts.cwd`). `n` is the 0-based call count.
    - `approve()`, `block(reason)` — partial Results with a verdict.
    - `makeCtx({ files, request, team, hooks, options }) -> ctx` matching the index's ctx shape, on a fresh repo/workspace. Its default hooks record calls in `ctx.hookCalls`: `escalate` returns `'reject'`, `approveResult` returns `true`, `approveChunk` returns `true`.

- [ ] **Step 1: Write the fakes helper**

`test/helpers/fakes.js`:

```js
// test/helpers/fakes.js
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Participant } from '../../src/participant.js';
import { makeResult } from '../../src/result.js';
import { Workspace } from '../../src/workspace.js';
import { RunLog } from '../../src/runlog.js';
import { DEFAULT_OPTIONS } from '../../src/options.js';
import { makeRepo } from './gitRepo.js';

export const approve = () => ({ verdict: { decision: 'APPROVE', reason: '' } });
export const block = (reason) => ({ verdict: { decision: 'BLOCK', reason } });

export function fakeParticipant({ name, kind = name, roles = ['author', 'reviewer', 'grunt'], script }) {
  const calls = [];
  const adapter = {
    kind,
    async run(role, task, context, opts) {
      calls.push({ role, task, context, opts });
      return makeResult(await script(role, task, context, opts, calls.length - 1));
    },
  };
  const p = new Participant({ name, adapter, roles, capabilities: { is_agentic: true, can_edit_files: true } });
  p.calls = calls;
  return p;
}

export async function makeCtx({ files, request = 'do the thing', team, hooks = {}, options = {} } = {}) {
  const repoDir = await makeRepo(files);
  const ws = await Workspace.create({ repoDir, baseDir: mkdtempSync(path.join(tmpdir(), 'ctx-')), taskId: request });
  const hookCalls = [];
  const rec = (name, ret) => async (arg) => { hookCalls.push({ name, arg }); return ret; };
  const allHooks = {
    escalate: rec('escalate', 'reject'),
    approveResult: rec('approveResult', true),
    approveChunk: rec('approveChunk', true),
    ...hooks,
  };
  const log = new RunLog(ws.dir, { onEvent: allHooks.onEvent });
  const state = {
    version: 1, taskId: request, request, repoDir,
    phase: 'plan', plan: null, chunkIndex: 0, chunkShas: [], notes: [], status: 'running',
  };
  return { request, team, hooks: allHooks, options: { ...DEFAULT_OPTIONS, ...options }, ws, log, state, repoDir, hookCalls };
}
```

- [ ] **Step 2: Write the failing tests**

`test/runlog.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RunLog, callRole } from '../src/runlog.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { fakeParticipant, approve } from './helpers/fakes.js';

// RunLog only needs a directory with a .git folder.
function wsDir() {
  const d = mkdtempSync(path.join(tmpdir(), 'rl-'));
  mkdirSync(path.join(d, '.git'));
  return d;
}
const lines = (d) => readFileSync(path.join(d, '.git', 'conductor', 'transcript.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('DEFAULT_OPTIONS is frozen with the documented caps', () => {
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS));
  assert.equal(DEFAULT_OPTIONS.localRounds, 3);
  assert.equal(DEFAULT_OPTIONS.frontierRounds, 2);
});

test('event appends JSON lines and notifies onEvent', () => {
  const d = wsDir();
  const seen = [];
  const log = new RunLog(d, { onEvent: (e) => seen.push(e.type) });
  log.event('phase', { name: 'plan' });
  log.event('phase', { name: 'chunks' });
  const l = lines(d);
  assert.equal(l.length, 2);
  assert.equal(l[1].name, 'chunks');
  assert.ok(l[0].ts);
  assert.deepEqual(seen, ['phase', 'phase']);
});

test('a throwing onEvent does not break logging', () => {
  const d = wsDir();
  const log = new RunLog(d, { onEvent: () => { throw new Error('ui crashed'); } });
  assert.doesNotThrow(() => log.event('x'));
  assert.equal(lines(d).length, 1);
});

test('state round-trips atomically; missing is null; corrupt throws', () => {
  const d = wsDir();
  const log = new RunLog(d);
  assert.equal(log.loadState(), null);
  log.saveState({ phase: 'chunks', chunkIndex: 2 });
  assert.deepEqual(log.loadState(), { phase: 'chunks', chunkIndex: 2 });
  assert.deepEqual(readdirSync(path.join(d, '.git', 'conductor')).filter((n) => n.endsWith('.tmp')), []);
  writeFileSync(path.join(d, '.git', 'conductor', 'state.json'), '{oops');
  assert.throws(() => log.loadState(), /corrupt run state/);
});

test('callRole forwards opts, returns the Result, and logs call + result', async () => {
  const d = wsDir();
  const log = new RunLog(d);
  const p = fakeParticipant({ name: 'rev', script: () => ({ text: 'fine', ...approve() }) });
  const r = await callRole(log, p, 'reviewer', 'task', 'ctx', { cwd: d });
  assert.equal(r.ok, true);
  assert.deepEqual(p.calls[0].opts, { cwd: d });
  const l = lines(d);
  assert.deepEqual(l.map((e) => e.type), ['call', 'result']);
  assert.equal(l[1].participant, 'rev');
  assert.equal(l[1].verdict.decision, 'APPROVE');
});

test('callRole turns a throw into ok:false', async () => {
  const d = wsDir();
  const log = new RunLog(d);
  const p = fakeParticipant({ name: 'x', script: () => { throw new Error('spawn ENOENT'); } });
  const r = await callRole(log, p, 'author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /spawn ENOENT/);
  assert.equal(lines(d)[1].ok, false);
});

test('callRole clips long output in the transcript', async () => {
  const d = wsDir();
  const log = new RunLog(d);
  const p = fakeParticipant({ name: 'x', script: () => ({ text: 'y'.repeat(10000) }) });
  await callRole(log, p, 'author', 't');
  assert.ok(lines(d)[1].text.length < 2100);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — `../src/runlog.js` / `../src/options.js` not found.

- [ ] **Step 4: Implement**

`src/options.js`:

```js
// src/options.js
export const DEFAULT_OPTIONS = Object.freeze({
  planRounds: 3,          // author/reviewer rounds on the plan
  localRounds: 3,         // local-agent attempts per chunk before frontier takes over
  frontierRounds: 2,      // frontier attempts per chunk before deadlock settlement
  maxChunks: 12,
  testCommand: null,      // e.g. "npm test"; null = no tests configured
  testTimeoutMs: 600000,
  agentTimeoutMs: 1800000,
  approveEachChunk: false,
});
```

`src/runlog.js`:

```js
// src/runlog.js
import { mkdirSync, appendFileSync, writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { makeResult } from './result.js';
import { clip } from './text.js';

export class RunLog {
  constructor(workspaceDir, { onEvent } = {}) {
    this.dir = path.join(workspaceDir, '.git', 'conductor');
    mkdirSync(this.dir, { recursive: true });
    this.transcript = path.join(this.dir, 'transcript.jsonl');
    this.statePath = path.join(this.dir, 'state.json');
    this.onEvent = onEvent;
  }

  event(type, data = {}) {
    const entry = { ts: new Date().toISOString(), type, ...data };
    appendFileSync(this.transcript, JSON.stringify(entry) + '\n');
    try { this.onEvent?.(entry); } catch {}
    return entry;
  }

  saveState(state) {
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.statePath);
  }

  loadState() {
    if (!existsSync(this.statePath)) return null;
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8'));
    } catch (e) {
      throw new Error(`corrupt run state at ${this.statePath}: ${e.message}`);
    }
  }
}

export async function callRole(log, participant, role, task, context = '', opts = {}) {
  log.event('call', { participant: participant.name, role, task: clip(task, 1000) });
  let result;
  try {
    result = await participant.run(role, task, context, opts);
  } catch (e) {
    result = makeResult({ ok: false, error: String(e?.message ?? e) });
  }
  log.event('result', {
    participant: participant.name, role, ok: result.ok, error: result.error,
    verdict: result.verdict, costUsd: result.usage?.costUsd ?? null, text: clip(result.text, 2000),
  });
  return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/options.js src/runlog.js test/helpers/fakes.js test/runlog.test.js
git commit -m "feat: run transcript, atomic run state, never-throwing callRole"
```
