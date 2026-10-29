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

test('a key refusal is not a sleeping machine: no wake, no wait, the real cause (final review 3c/3b)', async () => {
  const c = clock();
  let woke = 0;
  let probes = 0;
  const KEY = { ok: false, reason: 'unauthorized', detail: 'the local model server refused the key (HTTP 401)' };
  const [s] = await ensureWorkers([w('local', { wake: { method: 'wol', mac: '00:11:22:33:44:55', hint: 'Turn on the desktop.' } })], {
    health: async () => { probes++; return KEY; }, wake: async () => { woke++; return { attempted: true, ok: true, detail: '' }; }, now: c.now, sleep: c.sleep,
  });
  assert.equal(woke, 0, 'no wake attempted');
  assert.equal(probes, 1, 'no polling');
  assert.equal(s.waitedMs, 0);
  assert.equal(c.now(), 0, 'no waiting');
  const msg = downMessage(s);
  assert.match(msg, /not signed in, or its key was refused \(the local model server refused the key \(HTTP 401\)\)/);
  assert.doesNotMatch(msg, /wake|Turn on the desktop|Start the machine/i);
  assert.match(msg, /key/i);
  const missing = downMessage({ ...s, reason: 'model-missing', detail: 'the local model server has no model named m' });
  assert.match(missing, /the model is not installed \(the local model server has no model named m\)/);
  assert.doesNotMatch(missing, /wake|Start the machine/i);
});

test('unreachable still wakes as before (final review 3c)', async () => {
  const c = clock();
  let woke = 0;
  const answers = [{ ok: false, reason: 'unavailable', detail: 'could not reach the local model server (ECONNREFUSED)' }, OK];
  const [s] = await ensureWorkers([w('local', { wake: { method: 'wol', mac: '00:11:22:33:44:55' } })], {
    health: async () => answers.shift(), wake: async () => { woke++; return { attempted: true, ok: true, detail: '' }; }, now: c.now, sleep: c.sleep,
  });
  assert.equal(woke, 1);
  assert.deepEqual({ ok: s.ok, woke: s.woke }, { ok: true, woke: 'sent' });
});

test('workerLine shows the probe detail (final review 3a)', () => {
  assert.equal(workerLine({ name: 'local', kind: 'local-agent', ok: false, reason: 'unauthorized', detail: 'the local model server refused the key (HTTP 401)', woke: 'not-tried' }),
    '  ✗ local (local-agent): not signed in, or its key was refused (the local model server refused the key (HTTP 401))');
});
