// test/exec.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../src/exec.js';

const node = process.execPath;

test('captures stdout and zero exit', async () => {
  const r = await runCommand({ cmd: node, args: ['-e', 'process.stdout.write("hello")'] });
  assert.equal(r.stdout, 'hello');
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
});

test('captures stderr and non-zero exit', async () => {
  const r = await runCommand({ cmd: node, args: ['-e', 'process.stderr.write("bad");process.exit(3)'] });
  assert.match(r.stderr, /bad/);
  assert.equal(r.code, 3);
});

test('feeds stdin', async () => {
  const r = await runCommand({
    cmd: node,
    args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d))'],
    input: 'piped',
  });
  assert.equal(r.stdout, 'piped');
});

test('kills a hanging process and reports timedOut', async () => {
  const r = await runCommand({
    cmd: node,
    args: ['-e', 'setInterval(()=>{},1000)'],
    timeoutMs: 150,
  });
  assert.equal(r.timedOut, true);
});

test('does not reject on a missing binary', async () => {
  const r = await runCommand({ cmd: '/nonexistent/binary/xyz', args: [] });
  assert.equal(r.code, -1);
  assert.match(r.stderr, /ENOENT|spawn/i);
});
