# Task 3: Wake mechanisms

This task adds the two active mechanisms behind `wake.method`.

- **`wol`:** sends a standard Wake-on-LAN magic packet over UDP. This is six `0xff` bytes followed by the MAC repeated 16 times, 102 bytes in all, sent to `broadcast:port` with broadcast enabled. It needs no credentials, only that the machine's BIOS and network card have Wake-on-LAN switched on (an operator follow-up, Task 9).
- **`command`:** runs the operator's program, for example a restricted `ssh` that starts the LocalAI worker on .109. Its environment is `strictChildEnv()` (no secret-looking names at all) plus exactly the variables named in `wake.env`. Its output is redacted, so a token it echoes never reaches the screen (Review Focus 4). It is killed after `timeoutMs`.

`wakeWorker` sends the wake and reports what happened. It does not wait for the worker to come up; that is readiness's job (Task 4).

**Files:**
- Modify: `src/wake.js`
- Test: `test/wake.test.js` (append)

**Interfaces:**
- Consumes: `Wake` and `normalizeWake` (Task 2); `runCommand` (`src/exec.js`); `strictChildEnv`, `redact`, `secretValues` (`src/secrets.js`); `summarizeFailure` (`src/health.js`).
- Produces:
  - `magicPacket(mac) -> Buffer`, length 102.
  - `sendMagicPacket({ mac, broadcast, port }, { createSocket = dgram.createSocket } = {}) -> Promise<void>`:
    - creates a `'udp4'` socket, calls `bind()`, then `setBroadcast(true)` once it is listening;
    - sends the packet to `port`/`broadcast`, closes the socket, and resolves;
    - rejects on a socket error, and closes the socket in every case.
  - `runWakeCommand(wake, { run = runCommand, env = process.env } = {}) -> Promise<{ ok, detail }>`:
    - the child env is `{ ...strictChildEnv({ env }), ...picked }`, where `picked` holds `env[name]` for each `wake.env` name that is set;
    - `ok` is `code === 0 && !timedOut`;
    - `detail`:
      - on success: `''`;
      - on timeout: `'its start command did not finish within <s> seconds'`;
      - otherwise: `` `its start command failed: ${summarizeFailure(stderr || stdout) || `exit code ${code}`}` ``;
    - the whole detail goes through `redact(…, secrets)`. `secrets` covers `secretValues(env)` plus the values of the named `wake.env` variables, even when those names do not look secret.
  - `wakeWorker(participant, { send = sendMagicPacket, runCmd = runWakeCommand } = {}) -> Promise<{ attempted, ok, detail }>`:
    - `warn` → `{ attempted: false, ok: false, detail: '' }`;
    - `wol` → `send(wake)`. Success gives `{ attempted: true, ok: true, detail: 'sent a Wake-on-LAN signal' }`. A throw gives `{ attempted: true, ok: false, detail: 'could not send the Wake-on-LAN signal (<e.code ?? e.message>)' }`;
    - `command` → `runCmd(wake)`. It returns `{ attempted: true, ok, detail: ok ? 'ran its start command' : detail }`, and never throws.
  - `WAKE_METHOD_TEXT = Object.freeze({ warn: 'none set up', wol: 'Wake-on-LAN', command: 'its start command' })`.

- [ ] **Step 1: Write the failing tests**

Append to `test/wake.test.js`:

```js
import dgram from 'node:dgram';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeStubCli } from './helpers/stubCli.js';
import { magicPacket, sendMagicPacket, runWakeCommand, wakeWorker } from '../src/wake.js';

test('magicPacket: 6 x 0xff then the MAC 16 times', () => {
  const b = magicPacket('01:23:45:67:89:ab');
  assert.equal(b.length, 102);
  assert.deepEqual([...b.subarray(0, 6)], [255, 255, 255, 255, 255, 255]);
  for (let i = 0; i < 16; i++) assert.deepEqual([...b.subarray(6 + i * 6, 12 + i * 6)], [0x01, 0x23, 0x45, 0x67, 0x89, 0xab]);
});

test('sendMagicPacket delivers the packet over UDP (to 127.0.0.1 in tests)', async () => {
  const server = dgram.createSocket('udp4');
  const got = new Promise((resolve) => server.on('message', (m) => resolve(m)));
  await new Promise((r) => server.bind(0, '127.0.0.1', r));
  try {
    await sendMagicPacket({ mac: '01:23:45:67:89:ab', broadcast: '127.0.0.1', port: server.address().port });
    assert.deepEqual(await got, magicPacket('01:23:45:67:89:ab'));
  } finally { server.close(); }
});

test('sendMagicPacket rejects on a socket error and closes the socket', async () => {
  let closed = false;
  const fake = () => {
    const handlers = {};
    return {
      on: (ev, fn) => { handlers[ev] = fn; },
      once: (ev, fn) => { handlers[ev] = fn; },
      bind: () => setImmediate(() => handlers.listening?.()),
      setBroadcast: () => {},
      send: (buf, port, host, cb) => cb(Object.assign(new Error('nope'), { code: 'ENETUNREACH' })),
      close: () => { closed = true; },
    };
  };
  await assert.rejects(sendMagicPacket({ mac: '01:23:45:67:89:ab', broadcast: '192.168.1.255', port: 9 }, { createSocket: fake }), /nope/);
  assert.equal(closed, true);
});

const stub = (body) => writeStubCli(mkdtempSync(path.join(tmpdir(), 'wk-')), 'start-worker', body);
const cmdWake = (cmd, extra = {}) => normalizeWake({ method: 'command', cmd, ...extra }, 'local');

test('runWakeCommand: success, and only named env vars reach the program', async () => {
  const bin = stub(`console.log(JSON.stringify({ named: process.env.WAKE_TOKEN_T ?? null, other: process.env.OTHER_SECRET_T ?? null, home: Boolean(process.env.PATH) }));`);
  const env = { ...process.env, WAKE_TOKEN_T: 'tok-1234567890', OTHER_SECRET_T: 'other-1234567890' };
  let seen = null;
  const run = async (o) => { seen = o.env; return (await import('../src/exec.js')).runCommand(o); };
  const r = await runWakeCommand(cmdWake(bin, { env: ['WAKE_TOKEN_T'] }), { env, run });
  assert.deepEqual(r, { ok: true, detail: '' });
  assert.equal(seen.WAKE_TOKEN_T, 'tok-1234567890');
  assert.equal(seen.OTHER_SECRET_T, undefined, 'strictChildEnv drops other secrets');
});

test('runWakeCommand: a failure is summarized and redacted (Review Focus 4)', async () => {
  const bin = stub(`console.error('ERROR: auth failed for token ' + process.env.WAKE_PLAIN_NAME); process.exit(3);`);
  const env = { ...process.env, WAKE_PLAIN_NAME: 'plainvalue-0987654321' };
  const r = await runWakeCommand(cmdWake(bin, { env: ['WAKE_PLAIN_NAME'] }), { env });
  assert.equal(r.ok, false);
  assert.match(r.detail, /^its start command failed: ERROR: auth failed for token \[redacted\]/);
  assert.doesNotMatch(r.detail, /plainvalue/);
});

test('runWakeCommand: a hung program is killed at timeoutMs (Review Focus 4)', async () => {
  const bin = stub('setInterval(() => {}, 1000);');
  const t0 = Date.now();
  const r = await runWakeCommand(cmdWake(bin, { timeoutMs: 1000 }));
  assert.equal(r.ok, false);
  assert.equal(r.detail, 'its start command did not finish within 1 seconds');
  assert.ok(Date.now() - t0 < 8000);
});

test('wakeWorker: warn does nothing; wol and command report plainly; nothing throws', async () => {
  const p = (wake) => ({ name: 'local', wake });
  assert.deepEqual(await wakeWorker(p(normalizeWake(null, 'local'))), { attempted: false, ok: false, detail: '' });
  const wol = p(normalizeWake({ method: 'wol', mac: '01:23:45:67:89:ab' }, 'local'));
  assert.deepEqual(await wakeWorker(wol, { send: async () => {} }), { attempted: true, ok: true, detail: 'sent a Wake-on-LAN signal' });
  const failed = await wakeWorker(wol, { send: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
  assert.deepEqual(failed, { attempted: true, ok: false, detail: 'could not send the Wake-on-LAN signal (EACCES)' });
  const cmd = p(cmdWake('/bin/true'));
  assert.deepEqual(await wakeWorker(cmd, { runCmd: async () => ({ ok: true, detail: '' }) }), { attempted: true, ok: true, detail: 'ran its start command' });
  assert.deepEqual(await wakeWorker(cmd, { runCmd: async () => ({ ok: false, detail: 'its start command failed: exit code 1' }) }), { attempted: true, ok: false, detail: 'its start command failed: exit code 1' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/wake.test.js`
Expected: FAIL. `magicPacket`, `sendMagicPacket`, `runWakeCommand` and `wakeWorker` are not exported.

- [ ] **Step 3: Implement the four functions and `WAKE_METHOD_TEXT` in `src/wake.js`**

Add these imports at the top of `src/wake.js`, under the header comment:

```js
import dgram from 'node:dgram';
import { runCommand } from './exec.js';
import { strictChildEnv, redact, secretValues } from './secrets.js';
import { summarizeFailure } from './health.js';
```

Append to `src/wake.js`:

```js
export const WAKE_METHOD_TEXT = Object.freeze({ warn: 'none set up', wol: 'Wake-on-LAN', command: 'its start command' });

// Six 0xff bytes, then the six MAC bytes sixteen times: 102 bytes.
export function magicPacket(mac) {
  const bytes = Buffer.from(String(mac).replace(/[:-]/g, ''), 'hex');
  if (bytes.length !== 6) throw new Error('a network card address has six bytes');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

export function sendMagicPacket({ mac, broadcast = WAKE_DEFAULTS.broadcast, port = WAKE_DEFAULTS.port }, { createSocket = dgram.createSocket } = {}) {
  const packet = magicPacket(mac);
  return new Promise((resolve, reject) => {
    let socket = null;
    let settled = false;
    // Settles exactly once and closes the socket on every path.
    const done = (err) => {
      if (settled) return;
      settled = true;
      try { socket?.close(); } catch {}
      if (err) reject(err);
      else resolve();
    };
    try {
      socket = createSocket('udp4');
      socket.once('error', done);
      socket.once('listening', () => {
        try {
          socket.setBroadcast(true);
          socket.send(packet, port, broadcast, (err) => done(err ?? null));
        } catch (e) {
          done(e);
        }
      });
      socket.bind();
    } catch (e) {
      done(e);
    }
  });
}

// The operator's own start program: no secret-looking variables except the ones the block names,
// output summarized and redacted (Review Focus 4), killed after timeoutMs.
export async function runWakeCommand(wake, { run = runCommand, env = process.env } = {}) {
  const picked = {};
  for (const name of wake.env ?? []) if (typeof env[name] === 'string') picked[name] = env[name];
  const childEnv = { ...strictChildEnv({ env }), ...picked };
  // Named values are secrets even when their names do not look secret (very short ones would garble the text).
  const named = Object.values(picked).filter((v) => v.length >= 4);
  const secrets = [...new Set([...secretValues(env), ...named])].sort((a, b) => b.length - a.length);
  const timeoutMs = wake.timeoutMs ?? WAKE_DEFAULTS.timeoutMs;
  const r = await run({ cmd: wake.cmd, args: [...(wake.args ?? [])], env: childEnv, timeoutMs });
  const ok = r.code === 0 && !r.timedOut;
  let detail = '';
  if (r.timedOut) detail = `its start command did not finish within ${Math.round(timeoutMs / 1000)} seconds`;
  else if (!ok) detail = `its start command failed: ${summarizeFailure(r.stderr || r.stdout) || `exit code ${r.code}`}`;
  return { ok, detail: redact(detail, secrets) };
}

// Sends the wake and reports what happened; never waits for the worker (readiness does) and never throws.
export async function wakeWorker(participant, { send = sendMagicPacket, runCmd = runWakeCommand } = {}) {
  const wake = participant.wake ?? normalizeWake(null, participant.name);
  if (wake.method === 'wol') {
    try {
      await send(wake);
      return { attempted: true, ok: true, detail: 'sent a Wake-on-LAN signal' };
    } catch (e) {
      return { attempted: true, ok: false, detail: `could not send the Wake-on-LAN signal (${e?.code ?? e?.message ?? e})` };
    }
  }
  if (wake.method === 'command') {
    try {
      const r = await runCmd(wake);
      return r?.ok === true
        ? { attempted: true, ok: true, detail: 'ran its start command' }
        : { attempted: true, ok: false, detail: r?.detail || 'its start command failed' };
    } catch (e) {
      return { attempted: true, ok: false, detail: redact(`its start command failed: ${e?.message ?? e}`) };
    }
  }
  return { attempted: false, ok: false, detail: '' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/wake.js test/wake.test.js
git commit -m "feat: wake mechanisms — Wake-on-LAN magic packet and an operator start command"
```
