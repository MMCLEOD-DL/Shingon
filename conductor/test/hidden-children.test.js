import { test } from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runCommand, spawnTracked } from '../src/exec.js';

// Exercise the launch API contract without opening visible desktop windows.
// Native I/O, timeout and cancellation are exercised separately in exec.test.js.
async function captureLaunch(fn) {
  const original = childProcess.spawn;
  let captured;
  childProcess.spawn = (cmd, args, options) => {
    captured = { cmd, args, options };
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
  syncBuiltinESMExports();
  try { await fn(); return captured; }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
}

test('runCommand hides native child consoles while preserving arguments, env and platform process tracking', async () => {
  const env = { SYNTHETIC_LAUNCH: 'fixture' };
  const seen = await captureLaunch(() => runCommand({ cmd: 'synthetic.exe', args: ['argument with spaces'], cwd: 'fixture', env }));
  assert.equal(seen.options.windowsHide, true);
  assert.equal(seen.options.detached, process.platform !== 'win32');
  assert.equal(seen.options.env, env);
  assert.equal(seen.options.cwd, 'fixture');
  assert.equal(seen.cmd, 'synthetic.exe');
  assert.deepEqual(seen.args, ['argument with spaces']);
  assert.equal(seen.options.shell, undefined);
});

test('spawnTracked hides consoles even when caller options conflict, preserving streams and cwd', async () => {
  const seen = await captureLaunch(async () => {
    const child = spawnTracked('synthetic.exe', ['stream'], { detached: false, windowsHide: false, stdio: 'pipe', cwd: 'fixture' });
    await new Promise(resolve => child.once('close', resolve));
  });
  assert.equal(seen.options.windowsHide, true);
  assert.equal(seen.options.detached, true);
  assert.equal(seen.options.stdio, 'pipe');
  assert.equal(seen.options.cwd, 'fixture');
  assert.deepEqual(seen.args, ['stream']);
});
