import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWake, WAKE_DEFAULTS, DEFAULT_WAKE_HINT } from '../src/wake.js';

test('no wake block: warn only, with the default hint', () => {
  assert.deepEqual(normalizeWake(undefined, 'local'), { method: 'warn', hint: DEFAULT_WAKE_HINT, waitMs: 180000, pollMs: 5000 });
  assert.equal(Object.isFrozen(normalizeWake(null, 'local')), true);
  assert.equal(WAKE_DEFAULTS.method, 'warn');
});

test('wol: MAC normalized, defaults filled, foreign keys dropped', () => {
  const w = normalizeWake({ method: 'wol', mac: 'AA-BB-CC-DD-EE-0F', hint: 'Turn on the desktop.', cmd: 'ssh' }, 'local');
  assert.deepEqual(w, { method: 'wol', hint: 'Turn on the desktop.', waitMs: 180000, pollMs: 5000, mac: 'aa:bb:cc:dd:ee:0f', broadcast: '255.255.255.255', port: 9 });
});

test('command: cmd, args, env names and timeout', () => {
  const w = normalizeWake({ method: 'command', cmd: 'ssh', args: ['-i', '/k', 'wake@192.168.1.109', 'start-worker'], env: ['WAKE_TOKEN'], waitMs: 240000 }, 'local');
  assert.deepEqual(w, { method: 'command', hint: DEFAULT_WAKE_HINT, waitMs: 240000, pollMs: 5000, cmd: 'ssh', args: ['-i', '/k', 'wake@192.168.1.109', 'start-worker'], env: ['WAKE_TOKEN'], timeoutMs: 60000 });
});

test('bad wake config is a plain error naming the participant', () => {
  const bad = [
    [[], /Participant local: wake must be an object/],
    [{ method: 'magic' }, /wake\.method must be "warn", "wol" or "command"/],
    [{ method: 'wol' }, /wake\.mac/],
    [{ method: 'wol', mac: 'aa:bb:cc:dd:ee' }, /wake\.mac/],
    [{ method: 'wol', mac: 'aa:bb:cc:dd:ee:ff', port: 70000 }, /wake\.port/],
    [{ method: 'command' }, /wake\.cmd/],
    [{ method: 'command', cmd: 'x', args: 'start' }, /wake\.args/],
    [{ method: 'command', cmd: 'x', env: ['NOT OK'] }, /wake\.env/],
    [{ method: 'command', cmd: 'x', timeoutMs: 10 }, /wake\.timeoutMs/],
    [{ waitMs: -1 }, /wake\.waitMs must be a whole number of milliseconds from 0 to 900000/],
    [{ pollMs: 1.5 }, /wake\.pollMs/],
  ];
  for (const [raw, re] of bad) assert.throws(() => normalizeWake(raw, 'local'), (e) => re.test(e.message) && e.message.startsWith('Participant local: wake'), JSON.stringify(raw));
});

test('an env NAME is validated, its value is never read or echoed', () => {
  process.env.WAKE_SECRET_TEST = 'sekrit-wake-value-123';
  try {
    const w = normalizeWake({ method: 'command', cmd: 'x', env: ['WAKE_SECRET_TEST'] }, 'local');
    assert.doesNotMatch(JSON.stringify(w), /sekrit/);
  } finally { delete process.env.WAKE_SECRET_TEST; }
});

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

test('runWakeCommand: a secret straddling the 300-character cut never leaks, even partly (final review 2)', async () => {
  const secret = 'QZJ7wv93Pk2LmN8rT4yH';
  const prefix = 'ERROR: ' + 'x'.repeat(300 - 7 - 10); // the cut falls ten characters into the secret
  const bin = stub(`console.error(${JSON.stringify(prefix)} + process.env.WAKE_PASS_FR2 + ' tail'); process.exit(1);`);
  const env = { ...process.env, WAKE_PASS_FR2: secret };
  const r = await runWakeCommand(cmdWake(bin, { env: ['WAKE_PASS_FR2'] }), { env });
  assert.equal(r.ok, false);
  for (let n = 4; n <= secret.length; n++) assert.ok(!r.detail.includes(secret.slice(0, n)), `leaked ${n} characters: ${r.detail.slice(-40)}`);
});

test('normalizeWake trims wake.cmd (final review 5)', () => {
  assert.equal(cmdWake('  /usr/local/bin/wake-desktop \n').cmd, '/usr/local/bin/wake-desktop');
});
