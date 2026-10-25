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
