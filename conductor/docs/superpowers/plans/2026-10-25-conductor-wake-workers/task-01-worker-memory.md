# Task 1: Worker memory

The spec (§4.2) says the factory "remembers which workers earlier runs used … and checks or wakes them first". This task adds the memory: a small JSON file that records which participants served calls, and a tracker that collects them from the run's events.

- The file lives in the run base directory (`~/.conductor/workspaces/.workers.json` by default). Because it sits under `CONDUCTOR_BASE_DIR`, tests and smokes that set that variable never touch the operator's real memory.
- `listRuns` only reads `*.conductor` entries, so the file cannot be mistaken for a run.
- Memory is a convenience. A missing, corrupt or unwritable file must never stop or break a run (Review Focus 2).

**Files:**
- Create: `src/workerMemory.js`
- Test: `test/workerMemory.test.js`

**Interfaces:**
- Consumes: the `result` event shape from `callRole` (`src/runlog.js`: `{ type: 'result', participant, servedBy, ok, … }`); `Participant` (`name`, `adapter.kind`).
- Produces:
  - `memoryFileFor(baseDir) -> string`: `path.join(baseDir, '.workers.json')`.
  - `readWorkerMemory(file) -> { version: 1, workers: { [name]: { kind: string, lastUsedAt: number, runs: number } } }`. Any read or parse failure, a non-object, a wrong `version`, or a non-object `workers` gives `{ version: 1, workers: {} }`. Entries whose `lastUsedAt` is not a finite number are dropped.
  - `rememberWorkers(file, used, { now = Date.now } = {}) -> boolean`:
    - merges `used` (`[{ name, kind }]`, duplicates allowed) into the file. Each distinct name gets `lastUsedAt = now()`, `runs += 1` (starting at 1) and `kind` updated.
    - creates the directory (`mkdirSync(..., { recursive: true })`) and writes `<file>.<pid>.tmp`, then `renameSync`s it over the file.
    - An empty `used` writes nothing and returns `true`. Any error returns `false` and never throws; on an error it also tries to delete `<file>.<pid>.tmp`, so a failed rename (the target is a directory, the disk filled up) leaves no temp file behind.
  - `recallWorkers(memory, participants) -> [{ participant, lastUsedAt }]`: only names present in `participants`, newest first (Review Focus 3).
  - `createUsageTracker(byName) -> { onEvent(e), used() -> [{ name, kind }] }`. It counts `result` events with `ok === true`, using `servedBy ?? participant`. It ignores names not in `byName`, such as Seat names that differ from the candidate that served. `used()` lists each name once, in first-seen order, with `kind = byName.get(name).adapter.kind`.

- [ ] **Step 1: Write the failing tests**

Create `test/workerMemory.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { memoryFileFor, readWorkerMemory, rememberWorkers, recallWorkers, createUsageTracker } from '../src/workerMemory.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'wm-'));
const part = (name, kind) => ({ name, adapter: { kind } });

test('memoryFileFor puts the file in the run base directory', () => {
  assert.equal(memoryFileFor('/b/ws'), path.join('/b/ws', '.workers.json'));
});

test('remember then read: runs count up, lastUsedAt moves, kind follows the config', () => {
  const file = memoryFileFor(path.join(tmp(), 'nested', 'ws'));
  assert.equal(rememberWorkers(file, [{ name: 'local', kind: 'local-agent' }, { name: 'local', kind: 'local-agent' }, { name: 'claude', kind: 'claude-code' }], { now: () => 1000 }), true);
  assert.equal(rememberWorkers(file, [{ name: 'local', kind: 'local-agent' }], { now: () => 2000 }), true);
  const m = readWorkerMemory(file);
  assert.deepEqual(m, { version: 1, workers: {
    local: { kind: 'local-agent', lastUsedAt: 2000, runs: 2 },
    claude: { kind: 'claude-code', lastUsedAt: 1000, runs: 1 },
  } });
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, 'the temp file is renamed away');
});

test('missing, corrupt or wrong-shaped memory reads as empty (Review Focus 2)', () => {
  const dir = tmp();
  const empty = { version: 1, workers: {} };
  assert.deepEqual(readWorkerMemory(path.join(dir, 'none.json')), empty);
  for (const body of ['{not json', '[]', '{"version":2,"workers":{}}', '{"version":1,"workers":[]}', 'null']) {
    const f = path.join(dir, 'm.json');
    writeFileSync(f, body);
    assert.deepEqual(readWorkerMemory(f), empty, body);
  }
  const f = path.join(dir, 'bad-entry.json');
  writeFileSync(f, JSON.stringify({ version: 1, workers: { a: { kind: 'x', lastUsedAt: 'yesterday', runs: 1 }, b: { kind: 'y', lastUsedAt: 5, runs: 1 } } }));
  assert.deepEqual(Object.keys(readWorkerMemory(f).workers), ['b']);
});

test('an unwritable memory file returns false and never throws (Review Focus 2)', { skip: process.getuid?.() === 0 && 'root ignores file modes' }, () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'ro'));
  chmodSync(path.join(dir, 'ro'), 0o500);
  assert.equal(rememberWorkers(path.join(dir, 'ro', '.workers.json'), [{ name: 'local', kind: 'local-agent' }]), false);
});

test('a path that cannot be a file returns false and never throws (Review Focus 2)', () => {
  const dir = tmp();
  const file = path.join(dir, 'is-a-dir');
  mkdirSync(file);
  assert.equal(rememberWorkers(file, [{ name: 'local', kind: 'local-agent' }]), false);
  assert.equal(existsSync(`${file}.${process.pid}.tmp`), false, 'a failed rename leaves no temp file behind');
  assert.equal(rememberWorkers(path.join(dir, 'x.json'), []), true, 'nothing to remember is not a failure');
  assert.equal(existsSync(path.join(dir, 'x.json')), false);
});

test('recallWorkers keeps configured participants only, newest first (Review Focus 3)', () => {
  const memory = { version: 1, workers: {
    old: { kind: 'local-agent', lastUsedAt: 10, runs: 1 },
    gone: { kind: 'local-agent', lastUsedAt: 99, runs: 4 },
    local: { kind: 'local-agent', lastUsedAt: 50, runs: 2 },
  } };
  const ps = [part('local', 'local-agent'), part('old', 'local-agent'), part('claude', 'claude-code')];
  assert.deepEqual(recallWorkers(memory, ps).map((x) => [x.participant.name, x.lastUsedAt]), [['local', 50], ['old', 10]]);
});

test('the usage tracker records who really served successful calls', () => {
  const byName = new Map([['claude', part('claude', 'claude-code')], ['codex', part('codex', 'codex')], ['local', part('local', 'local-agent')]]);
  const t = createUsageTracker(byName);
  t.onEvent({ type: 'call', participant: 'local' });
  t.onEvent({ type: 'result', participant: 'local', servedBy: 'local', ok: false });
  t.onEvent({ type: 'result', participant: 'claude', servedBy: 'codex', ok: true });
  t.onEvent({ type: 'result', participant: 'local', servedBy: null, ok: true });
  t.onEvent({ type: 'result', participant: 'seat-x', servedBy: 'not-configured', ok: true });
  t.onEvent({ type: 'result', participant: 'codex', servedBy: 'codex', ok: true });
  t.onEvent(null);
  assert.deepEqual(t.used(), [{ name: 'codex', kind: 'codex' }, { name: 'local', kind: 'local-agent' }]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/workerMemory.test.js`
Expected: FAIL with `Cannot find module '…/src/workerMemory.js'`.

- [ ] **Step 3: Implement `src/workerMemory.js`**

Create `src/workerMemory.js`:

```js
// src/workerMemory.js
// Which participants served calls in earlier runs (factory spec §4.2), so readiness checks them first.
// A convenience only: a missing, corrupt or unwritable file never stops or breaks a run.
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const empty = () => ({ version: 1, workers: {} });
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
// A JSON key "__proto__" would set the prototype of a plain object: never store it.
const usableName = (n) => typeof n === 'string' && n !== '' && n !== '__proto__';

export function memoryFileFor(baseDir) {
  return path.join(baseDir, '.workers.json');
}

export function readWorkerMemory(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return empty();
  }
  if (!isObject(parsed) || parsed.version !== 1 || !isObject(parsed.workers)) return empty();
  const out = empty();
  for (const [name, w] of Object.entries(parsed.workers)) {
    if (!usableName(name) || !isObject(w) || !Number.isFinite(w.lastUsedAt)) continue;
    out.workers[name] = {
      kind: typeof w.kind === 'string' ? w.kind : '',
      lastUsedAt: w.lastUsedAt,
      runs: Number.isInteger(w.runs) && w.runs > 0 ? w.runs : 1,
    };
  }
  return out;
}

export function rememberWorkers(file, used, { now = Date.now } = {}) {
  if (!Array.isArray(used) || used.length === 0) return true;
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const memory = readWorkerMemory(file);
    const at = now();
    const seen = new Set();
    for (const u of used) {
      if (!usableName(u?.name) || seen.has(u.name)) continue;
      seen.add(u.name);
      const prev = memory.workers[u.name];
      memory.workers[u.name] = { kind: String(u.kind ?? prev?.kind ?? ''), lastUsedAt: at, runs: (prev?.runs ?? 0) + 1 };
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(memory, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch {}
    return false;
  }
}

// Configured participants only (Review Focus 3), the most recently used first.
export function recallWorkers(memory, participants) {
  const byName = new Map(participants.map((p) => [p.name, p]));
  return Object.entries(memory?.workers ?? {})
    .filter(([name]) => byName.has(name))
    .map(([name, w]) => ({ participant: byName.get(name), lastUsedAt: w.lastUsedAt }))
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

// Collects, from the run's events, who really served a successful call (a Seat's servedBy).
export function createUsageTracker(byName) {
  const names = [];
  return {
    onEvent(e) {
      if (e?.type !== 'result' || e.ok !== true) return;
      const name = e.servedBy ?? e.participant;
      if (byName.has(name) && !names.includes(name)) names.push(name);
    },
    used: () => names.map((name) => ({ name, kind: byName.get(name).adapter.kind })),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (405 existing + 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/workerMemory.js test/workerMemory.test.js
git commit -m "feat: worker memory — remember which participants served earlier runs"
```
