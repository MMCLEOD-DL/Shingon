# Task 4: Readiness — probe, wake, wait

This is the heart of the plan. Before `buildTeam`, `ensureWorkers` checks every worker. For one that is down, it runs the wake mechanism and then polls the real probe (Plan 3's 1-token completion) until the worker answers or `wake.waitMs` runs out.

- The results feed `buildTeam` through `cachedHealth`, so a down local model is not probed a second time for another 60 s.
- The same results produce the plain-English lines the CLI prints.
- Smoke run 2's failure mode (.109 off, CT110 LocalAI up) currently reads "the local model server answered HTTP 500". This task makes the probe recognize LocalAI's "no healthy nodes available" body and say **"its GPU worker is not connected"**. That tells the operator which machine to start (Ruling 7).

**Which workers:**
- the local model this run will use: `routing.local` when it names a local, else the first local in config order (the same choice `buildTeam` makes; a "local" is a participant that can play `grunt` and is not an API kind);
- every remembered local (it served an earlier run, so the spec says to check it first);
- every remembered non-local participant whose `wake.method` is not `warn` (for example a self-hosted reviewer on a machine that sleeps).

Remembered ones come first, newest first; the run's own local follows if it was not remembered. Other configured locals are **not** woken: the run will not use them, so Conductor does not switch on machines for nothing (`buildTeam` still probes them as it does today). API and subscription participants are never woken.

**Files:**
- Create: `src/readiness.js`
- Modify: `src/adapters/localAgent.js` (`probe`), `src/router.js` (`REASON_TEXT`)
- Test: `test/readiness.test.js` (new), `test/localAgent.test.js` (append)

**Interfaces:**
- Consumes:
  - `checkHealth` (`src/health.js`);
  - `wakeWorker`, `WAKE_METHOD_TEXT` (Task 3);
  - `participant.wake` (Task 2);
  - `recallWorkers` output `[{ participant, lastUsedAt }]` (Task 1);
  - `isApiKind` (`src/vendors.js`);
  - `REASON_TEXT` (`src/router.js`).
- Produces:
  - `workersToCheck(participants, recalled, { local = null } = {}) -> Participant[]` (rule above; no duplicates; `local` is `routing.local`).
  - `ensureWorkers(workers, { health = checkHealth, wake = wakeWorker, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now, onProgress = () => {} } = {}) -> Promise<WorkerStatus[]>`:
    - workers are handled concurrently, and the result is in input order;
    - `WorkerStatus = { name, kind, local, ok, reason, detail, woke, wakeDetail, waitedMs, hint, method }`, where `local` is `true` for a participant that can play `grunt`;
    - `woke` is one of:
      - `'not-needed'`: the first probe was fine;
      - `'not-configured'`: the method is `warn`;
      - `'failed'`: the wake itself failed, and there is no wait;
      - `'sent'`: the wake went out, followed by polling;
    - `ok`, `reason` and `detail` come from the **last** probe;
    - a probe that throws counts as `{ ok:false, reason:'unavailable', detail: <message> }`.
  - `cachedHealth(statuses, workers, health = checkHealth) -> (adapter, opts) => Promise<{ ok, reason, detail? }>`. It returns the stored `{ ok, reason, detail }` for the adapter of any checked worker (matched by **object identity** of `worker.adapter`) and delegates everything else to `health`.
  - `progressText(e) -> string`:
    - `waking` → `Waking <name> (<WAKE_METHOD_TEXT[method]>)…`;
    - `woke` → `<name> is awake (after <s> s).`;
    - `still-down` → `<name> did not wake up within <s> s.`, or `<name> could not be woken.` when `waitedMs` is 0 (the wake itself failed).
  - `downMessage(status) -> string`, three sentences joined by spaces:
    1. `The local model "<name>" is not answering: <REASON_TEXT[reason] ?? reason>.` For a status with `local: false` it starts `The worker "<name>"` instead.
    2. Depends on `woke`:
       - `'not-configured'`: `Conductor has no way to wake it set up.`;
       - `'failed'`: `Conductor tried to wake it, but <wakeDetail>.`;
       - `'sent'`: `Conductor tried <WAKE_METHOD_TEXT[method]> and waited <s> seconds.`
    3. `To fix it by hand: <hint>`
  - `workerLine(status, lastUsedAt = null) -> string`, the line `doctor` prints. It has the format `  ✓|✗ <name> (<kind>)`, then:
    - when not ok: `: <REASON_TEXT…>`;
    - when `woke` is `sent`: ` — woke it with <method text>` if it is now ok, else ` — tried <method text> and waited <s> s`;
    - when `woke` is `failed`: ` — tried <method text>: <wakeDetail>`;
    - when `lastUsedAt` is set: ` · last used <YYYY-MM-DD>` (ISO date).
  - `REASON_TEXT['worker-offline'] = 'its GPU worker is not connected'`.
  - `LocalAgentAdapter.probe`: on a non-2xx status other than 401/403/404, keep the body text (it is already read with `await res.text()`). If `res.status >= 500` and the body matches `/no healthy nodes/i`, return `{ ok:false, reason:'worker-offline', detail:'the local model server is running, but no GPU worker is connected to it' }`. Other statuses are unchanged.

**The wait loop** (per worker, after a wake with `ok: true`). The signature and the tests do not fix this, so spell it out:

```js
const start = now();
for (;;) {
  const left = wake.waitMs - (now() - start);
  if (left <= 0) break;
  await sleep(Math.min(wake.pollMs, left));
  const remaining = wake.waitMs - (now() - start);
  if (remaining <= 0) break;
  // Review Focus 1: a probe can hang until its timeout when the machine is off: never let it outrun the budget.
  h = await probe(worker, Math.min(remaining, probeTimeout(worker)));
  if (h.ok) break;
}
waitedMs = now() - start;
```

Here `probeTimeout(worker)` is 60000 for `local-agent` (as in `team.js`) and 15000 otherwise. The first probe, before any wake, uses `probeTimeout(worker)`. Emit `waking` before the wake, and then `woke` or `still-down` after the loop. A wake that fails emits `still-down` with `waitedMs: 0`.

- [ ] **Step 1: Write the failing tests**

Create `test/readiness.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workersToCheck, ensureWorkers, cachedHealth, downMessage, progressText, workerLine } from '../src/readiness.js';
import { normalizeWake } from '../src/wake.js';

const OK = { ok: true, reason: '' };
const OFF = { ok: false, reason: 'worker-offline', detail: 'the local model server is running, but no GPU worker is connected to it' };
function w(name, { kind = 'local-agent', roles = ['grunt'], wake = null } = {}) {
  return { name, roles, canPlay: (r) => roles.includes(r), adapter: { kind }, wake: normalizeWake(wake, name) };
}
// A fake clock: sleep advances it; probes may take time too.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test('workersToCheck: remembered first, then the run\'s own local; never APIs, subscriptions or unused locals', () => {
  const a = w('a');
  const b = w('b');
  const c = w('c');
  const api = w('api', { kind: 'openai-api', roles: ['grunt'] });
  const claude = w('claude', { kind: 'claude-code', roles: ['author'] });
  const claudeWol = w('claude-wol', { kind: 'claude-code', roles: ['author'], wake: { method: 'wol', mac: '00:11:22:33:44:66' } });
  const gpuBox = w('gpu-box', { kind: 'local-agent', roles: ['reviewer'], wake: { method: 'wol', mac: '00:11:22:33:44:55' } });
  const recalled = [{ participant: b, lastUsedAt: 9 }, { participant: gpuBox, lastUsedAt: 8 }, { participant: claude, lastUsedAt: 7 }, { participant: claudeWol, lastUsedAt: 6 }];
  const all = [claude, claudeWol, a, api, b, c, gpuBox];
  assert.deepEqual(workersToCheck(all, recalled).map((x) => x.name), ['b', 'gpu-box', 'a'], 'c is configured but neither used before nor this run\'s local');
  assert.deepEqual(workersToCheck(all, [], { local: 'c' }).map((x) => x.name), ['c']);
  assert.deepEqual(workersToCheck(all, [], { local: 'claude' }).map((x) => x.name), ['a'], 'routing.local naming a non-local falls back to the first local');
  assert.deepEqual(workersToCheck([claude], []), []);
});

test('a healthy worker is not woken', async () => {
  let woke = 0;
  const [s] = await ensureWorkers([w('local', { wake: { method: 'wol', mac: '00:11:22:33:44:55' } })], { health: async () => OK, wake: async () => { woke++; } });
  assert.equal(woke, 0);
  assert.deepEqual({ ok: s.ok, woke: s.woke, waitedMs: s.waitedMs }, { ok: true, woke: 'not-needed', waitedMs: 0 });
});

test('warn only: one probe, no wake, the hint is carried', async () => {
  let probes = 0;
  const [s] = await ensureWorkers([w('local', { wake: { hint: 'Turn on the desktop PC and start the LocalAI worker.' } })], { health: async () => { probes++; return OFF; } });
  assert.equal(probes, 1);
  assert.equal(s.woke, 'not-configured');
  assert.equal(s.ok, false);
  assert.equal(downMessage(s), 'The local model "local" is not answering: its GPU worker is not connected. Conductor has no way to wake it set up. To fix it by hand: Turn on the desktop PC and start the LocalAI worker.');
});

test('wol: wake, poll, and come up', async () => {
  const c = clock();
  const answers = [OFF, OFF, OFF, OK];
  const events = [];
  const [s] = await ensureWorkers([w('local', { wake: { method: 'wol', mac: '00:11:22:33:44:55', pollMs: 5000 } })], {
    health: async () => answers.shift(), wake: async () => ({ attempted: true, ok: true, detail: 'sent a Wake-on-LAN signal' }),
    now: c.now, sleep: c.sleep, onProgress: (e) => events.push(e),
  });
  assert.deepEqual({ ok: s.ok, woke: s.woke, waitedMs: s.waitedMs }, { ok: true, woke: 'sent', waitedMs: 15000 });
  assert.deepEqual(events.map((e) => e.type), ['waking', 'woke']);
  assert.equal(progressText(events[0]), 'Waking local (Wake-on-LAN)…');
  assert.equal(progressText(events[1]), 'local is awake (after 15 s).');
});

test('still down after waitMs: plain message says what was tried', async () => {
  const c = clock();
  const events = [];
  const [s] = await ensureWorkers([w('local', { wake: { method: 'wol', mac: '00:11:22:33:44:55', waitMs: 20000, pollMs: 5000, hint: 'Turn on the desktop.' } })], {
    health: async () => OFF, wake: async () => ({ attempted: true, ok: true, detail: '' }), now: c.now, sleep: c.sleep, onProgress: (e) => events.push(e),
  });
  assert.equal(s.ok, false);
  assert.equal(s.waitedMs, 20000);
  assert.equal(events.at(-1).type, 'still-down');
  assert.equal(downMessage(s), 'The local model "local" is not answering: its GPU worker is not connected. Conductor tried Wake-on-LAN and waited 20 seconds. To fix it by hand: Turn on the desktop.');
});

test('a failed wake does not wait', async () => {
  const c = clock();
  const [s] = await ensureWorkers([w('local', { wake: { method: 'command', cmd: 'x' } })], {
    health: async () => OFF, wake: async () => ({ attempted: true, ok: false, detail: 'its start command failed: exit code 255' }), now: c.now, sleep: c.sleep,
  });
  assert.deepEqual({ woke: s.woke, waitedMs: s.waitedMs, wakeDetail: s.wakeDetail }, { woke: 'failed', waitedMs: 0, wakeDetail: 'its start command failed: exit code 255' });
  assert.match(downMessage(s), /Conductor tried to wake it, but its start command failed: exit code 255\./);
});

test('a hanging probe never outruns waitMs (Review Focus 1)', async () => {
  const c = clock();
  const timeouts = [];
  // The machine is off: every probe hangs for its full timeout.
  const health = async (adapter, { timeoutMs }) => { timeouts.push(timeoutMs); c.advance(timeoutMs); return { ok: false, reason: 'unavailable', detail: 'the local model did not answer in time' }; };
  const [s] = await ensureWorkers([w('local', { wake: { method: 'wol', mac: '00:11:22:33:44:55', waitMs: 90000, pollMs: 5000 } })], {
    health, wake: async () => ({ attempted: true, ok: true, detail: '' }), now: c.now, sleep: c.sleep,
  });
  assert.equal(s.ok, false);
  assert.equal(timeouts[0], 60000, 'the first probe uses the normal local timeout');
  assert.ok(s.waitedMs <= 90000, `waited ${s.waitedMs}`);
  assert.ok(timeouts.slice(1).every((t) => t <= 90000 - 5000), timeouts.join(','));
});

test('a probe that throws counts as unavailable; workers run concurrently, results in input order', async () => {
  const order = [];
  const health = async (adapter) => {
    if (adapter.kind === 'boom') throw new Error('socket hang up');
    await new Promise((r) => setTimeout(r, adapter.kind === 'slow' ? 30 : 1));
    order.push(adapter.kind);
    return OK;
  };
  const r = await ensureWorkers([w('s', { kind: 'slow' }), w('f', { kind: 'fast' }), w('b', { kind: 'boom' })], { health });
  assert.deepEqual(r.map((x) => [x.name, x.ok, x.reason]), [['s', true, ''], ['f', true, ''], ['b', false, 'unavailable']]);
  assert.deepEqual(order, ['fast', 'slow']);
  assert.match(r[2].detail, /socket hang up/);
});

test('cachedHealth answers checked workers from the cache, others from health', async () => {
  const local = w('local');
  const claude = w('claude', { kind: 'claude-code' });
  const statuses = [{ name: 'local', ok: false, reason: 'worker-offline', detail: 'd' }];
  let calls = 0;
  const h = cachedHealth(statuses, [local], async () => { calls++; return OK; });
  assert.deepEqual(await h(local.adapter, { timeoutMs: 1 }), { ok: false, reason: 'worker-offline', detail: 'd' });
  assert.deepEqual(await h(claude.adapter, { timeoutMs: 1 }), OK);
  assert.equal(calls, 1);
});

test('workerLine: doctor format', () => {
  const day = Date.UTC(2026, 9, 24, 12);
  assert.equal(workerLine({ name: 'local', kind: 'local-agent', ok: true, woke: 'not-needed' }, day), '  ✓ local (local-agent) · last used 2026-10-24');
  assert.equal(workerLine({ name: 'local', kind: 'local-agent', ok: true, woke: 'sent', method: 'wol' }), '  ✓ local (local-agent) — woke it with Wake-on-LAN');
  assert.equal(workerLine({ name: 'local', kind: 'local-agent', ok: false, reason: 'worker-offline', woke: 'failed', method: 'command', wakeDetail: 'its start command failed: exit code 1' }),
    '  ✗ local (local-agent): its GPU worker is not connected — tried its start command: its start command failed: exit code 1');
  assert.equal(workerLine({ name: 'local', kind: 'local-agent', ok: false, reason: 'unavailable', woke: 'sent', method: 'wol', waitedMs: 180000 }),
    '  ✗ local (local-agent): not reachable — tried Wake-on-LAN and waited 180 s');
});

test('downMessage names a non-local worker as a worker; progressText for a failed wake', () => {
  const s = { name: 'gpu-box', kind: 'local-agent', local: false, ok: false, reason: 'unavailable', woke: 'not-configured', hint: 'Turn on the GPU box.' };
  assert.equal(downMessage(s), 'The worker "gpu-box" is not answering: not reachable. Conductor has no way to wake it set up. To fix it by hand: Turn on the GPU box.');
  assert.equal(progressText({ type: 'still-down', name: 'local', waitedMs: 0 }), 'local could not be woken.');
  assert.equal(progressText({ type: 'still-down', name: 'local', waitedMs: 20000 }), 'local did not wake up within 20 s.');
});

test('ensureWorkers marks locals and non-locals', async () => {
  const r = await ensureWorkers([w('local'), w('gpu-box', { roles: ['reviewer'] })], { health: async () => OK });
  assert.deepEqual(r.map((x) => [x.name, x.local]), [['local', true], ['gpu-box', false]]);
});
```

Append to `test/localAgent.test.js`. It reuses `okBin` from the Plan 3 probe tests; add a body-aware variant of `withLocalServer`:

```js
async function withBodyServer(status, body, fn) {
  const server = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); }); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}/v1`); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}

test('probe: LocalAI with no GPU worker is "worker-offline", other 5xx stay "unavailable"', async () => {
  await withBodyServer(500, '{"error":{"message":"no healthy nodes available"}}', async (baseUrl) => {
    const r = await new LocalAgentAdapter({ bin: okBin(), model: 'm', baseUrl }).probe();
    assert.deepEqual(r, { ok: false, reason: 'worker-offline', detail: 'the local model server is running, but no GPU worker is connected to it' });
  });
  await withBodyServer(500, '{"error":"boom"}', async (baseUrl) => {
    const r = await new LocalAgentAdapter({ bin: okBin(), model: 'm', baseUrl }).probe();
    assert.equal(r.reason, 'unavailable');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL. `src/readiness.js` is missing, and the probe answers `unavailable` for the "no healthy nodes" body.

- [ ] **Step 3: Implement the probe change and `REASON_TEXT['worker-offline']`**

In `src/router.js`, add the entry to `REASON_TEXT`:

```js
export const REASON_TEXT = Object.freeze({
  'rate-limit': 'rate-limited',
  unauthorized: 'not signed in, or its key was refused',
  'version-skew': 'its program is out of date',
  unavailable: 'not reachable',
  'model-missing': 'the model is not installed',
  'worker-offline': 'its GPU worker is not connected',
});
```

In `LocalAgentAdapter.probe` (`src/adapters/localAgent.js`), keep the body and add the branch. The method's `fetch` part becomes:

```js
    let res;
    let body = '';
    try {
      res = await fetch(`${String(this.baseUrl).replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: this.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 1 }),
        redirect: 'error', // never resend the key to wherever a redirect points
        signal: AbortSignal.timeout(timeoutMs),
      });
      body = await res.text();
    } catch (e) {
      const detail = e?.name === 'TimeoutError'
        ? 'the local model did not answer in time'
        : redact(`could not reach the local model server (${e?.cause?.code ?? e?.message ?? e})`);
      return { ok: false, reason: 'unavailable', detail };
    }
    if (res.ok) return { ok: true, reason: '' };
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthorized', detail: `the local model server refused the key (HTTP ${res.status})` };
    if (res.status === 404) return { ok: false, reason: 'model-missing', detail: `the local model server has no model named ${this.model}` };
    // LocalAI on CT110 is up but its GPU worker (the .109 desktop) is not connected (Ruling 7).
    if (res.status >= 500 && /no healthy nodes/i.test(body)) {
      return { ok: false, reason: 'worker-offline', detail: 'the local model server is running, but no GPU worker is connected to it' };
    }
    return { ok: false, reason: 'unavailable', detail: `the local model server answered HTTP ${res.status}` };
```

- [ ] **Step 4: Implement `src/readiness.js`**

Create `src/readiness.js`:

```js
// src/readiness.js
// Before a run (factory spec §4.2): check each worker, wake the ones that are down, and wait for them
// within a budget. The results feed buildTeam (so nothing is probed twice) and the plain-English lines.
import { checkHealth } from './health.js';
import { wakeWorker, normalizeWake, WAKE_METHOD_TEXT, DEFAULT_WAKE_HINT } from './wake.js';
import { isApiKind, isSubscriptionKind } from './vendors.js';
import { REASON_TEXT } from './router.js';
import { redact } from './secrets.js';

const PROBE_TIMEOUT_MS = { 'local-agent': 60000 }; // as in team.js: the first local call may load the model
const probeTimeout = (p) => PROBE_TIMEOUT_MS[p.adapter.kind] ?? 15000;
const isLocal = (p) => p.canPlay('grunt') && !isApiKind(p.adapter.kind);
const wakeable = (p) => !isApiKind(p.adapter.kind) && !isSubscriptionKind(p.adapter.kind) && (p.wake?.method ?? 'warn') !== 'warn';
const seconds = (ms) => Math.round((ms ?? 0) / 1000);
const plain = (reason) => REASON_TEXT[reason] ?? reason ?? 'not available';
const methodText = (m) => WAKE_METHOD_TEXT[m] ?? m;
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function workersToCheck(participants, recalled = [], { local = null } = {}) {
  const locals = participants.filter(isLocal);
  const runLocal = (local && locals.find((p) => p.name === local)) || locals[0] || null;
  const configured = new Set(participants);
  const out = [];
  const add = (p) => { if (p && configured.has(p) && !out.includes(p)) out.push(p); };
  for (const { participant: p } of recalled) {
    if (isApiKind(p.adapter.kind)) continue;
    if (isLocal(p) || wakeable(p)) add(p);
  }
  add(runLocal);
  return out;
}

export async function ensureWorkers(workers, { health = checkHealth, wake = wakeWorker, sleep = sleepMs, now = Date.now, onProgress = () => {} } = {}) {
  const probe = async (p, timeoutMs) => {
    try {
      const h = await health(p.adapter, { timeoutMs });
      return h?.ok === true ? { ok: true, reason: '', detail: null } : { ok: false, reason: h?.reason || 'unavailable', detail: h?.detail ?? null };
    } catch (e) {
      return { ok: false, reason: 'unavailable', detail: redact(String(e?.message ?? e)) };
    }
  };
  return Promise.all(workers.map(async (p) => {
    const w = p.wake ?? normalizeWake(null, p.name);
    const status = (h, extra = {}) => ({
      name: p.name, kind: p.adapter.kind, local: isLocal(p), ok: h.ok, reason: h.reason, detail: h.detail,
      woke: 'not-needed', wakeDetail: '', waitedMs: 0, hint: w.hint, method: w.method, ...extra,
    });
    let h = await probe(p, probeTimeout(p));
    if (h.ok) return status(h);
    if (w.method === 'warn') return status(h, { woke: 'not-configured' });

    onProgress({ type: 'waking', name: p.name, method: w.method });
    let r;
    try {
      r = await wake(p);
    } catch (e) {
      r = { attempted: true, ok: false, detail: redact(String(e?.message ?? e)) };
    }
    if (r?.ok !== true) {
      onProgress({ type: 'still-down', name: p.name, waitedMs: 0 });
      return status(h, { woke: 'failed', wakeDetail: r?.detail || 'the wake did not work' });
    }

    const start = now();
    for (;;) {
      const left = w.waitMs - (now() - start);
      if (left <= 0) break;
      await sleep(Math.min(w.pollMs, left));
      const remaining = w.waitMs - (now() - start);
      if (remaining <= 0) break;
      // Review Focus 1: a probe can hang until its timeout when the machine is off: never let it outrun the budget.
      h = await probe(p, Math.min(remaining, probeTimeout(p)));
      if (h.ok) break;
    }
    const waitedMs = now() - start;
    onProgress({ type: h.ok ? 'woke' : 'still-down', name: p.name, waitedMs });
    return status(h, { woke: 'sent', wakeDetail: r.detail ?? '', waitedMs });
  }));
}

// buildTeam's health function: a checked worker's adapter (matched by identity) answers from the
// readiness result; every other adapter is probed as usual.
export function cachedHealth(statuses, workers, health = checkHealth) {
  const cached = new Map();
  for (const p of workers) {
    const s = statuses.find((x) => x.name === p.name);
    if (s) cached.set(p.adapter, { ok: s.ok, reason: s.reason, ...(s.detail != null ? { detail: s.detail } : {}) });
  }
  return async (adapter, opts) => (cached.has(adapter) ? { ...cached.get(adapter) } : health(adapter, opts));
}

export function progressText(e) {
  if (e?.type === 'waking') return `Waking ${e.name} (${methodText(e.method)})…`;
  if (e?.type === 'woke') return `${e.name} is awake (after ${seconds(e.waitedMs)} s).`;
  if (e?.type === 'still-down') return e.waitedMs ? `${e.name} did not wake up within ${seconds(e.waitedMs)} s.` : `${e.name} could not be woken.`;
  return '';
}

export function downMessage(s) {
  const who = s.local === false ? `The worker "${s.name}"` : `The local model "${s.name}"`;
  const tried = s.woke === 'failed' ? `Conductor tried to wake it, but ${s.wakeDetail}.`
    : s.woke === 'sent' ? `Conductor tried ${methodText(s.method)} and waited ${seconds(s.waitedMs)} seconds.`
      : 'Conductor has no way to wake it set up.';
  return `${who} is not answering: ${plain(s.reason)}. ${tried} To fix it by hand: ${s.hint || DEFAULT_WAKE_HINT}`;
}

export function workerLine(s, lastUsedAt = null) {
  let line = `  ${s.ok ? '✓' : '✗'} ${s.name} (${s.kind})`;
  if (!s.ok) line += `: ${plain(s.reason)}`;
  if (s.woke === 'sent') line += s.ok ? ` — woke it with ${methodText(s.method)}` : ` — tried ${methodText(s.method)} and waited ${seconds(s.waitedMs)} s`;
  if (s.woke === 'failed') line += ` — tried ${methodText(s.method)}: ${s.wakeDetail}`;
  if (Number.isFinite(lastUsedAt)) line += ` · last used ${new Date(lastUsedAt).toISOString().slice(0, 10)}`;
  return line;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/readiness.js src/adapters/localAgent.js src/router.js test/readiness.test.js test/localAgent.test.js
git commit -m "feat: readiness — probe workers, wake the down ones, wait within a budget"
```
