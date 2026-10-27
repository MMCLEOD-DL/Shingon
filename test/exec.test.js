// test/exec.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, killAllChildren, spawnTracked } from '../src/exec.js';

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

test('times out even when a descendant keeps the pipe open', async () => {
  const r = await runCommand({
    cmd: node,
    args: ['-e', 'require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:["ignore","inherit","inherit"]}); setInterval(()=>{},1000);'],
    timeoutMs: 300,
  });
  assert.equal(r.timedOut, true);
});

test('null input does not hang a child that reads stdin to EOF', async () => {
  const r = await runCommand({
    cmd: node,
    args: ['-e', 'process.stdin.resume(); process.stdin.on("end",()=>process.exit(0));'],
    timeoutMs: 5000,
  });
  assert.equal(r.code, 0);
  assert.equal(r.timedOut, false);
});

test('killAllChildren ends every live child; their runs resolve', async () => {
  const p = runCommand({ cmd: 'node', args: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 60000 });
  await new Promise((r) => setTimeout(r, 200));
  const t0 = Date.now();
  killAllChildren();
  const r = await p;
  assert.notEqual(r.code, 0);
  assert.ok(Date.now() - t0 < 5000);
});

test('spawnTracked children are killed by killAllChildren', async () => {
  const child = spawnTracked(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {});
  const closed = new Promise((r) => child.on('close', (code, signal) => r(signal)));
  killAllChildren();
  assert.equal(await closed, 'SIGKILL');
});
