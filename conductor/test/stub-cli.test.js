import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/exec.js';
import { writeStubCli } from './helpers/stubCli.js';

test('CLI fixture preserves literal arguments, cwd, environment, stdin, both streams and exit status', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor stub 雪-'));
  try {
    const bin = writeStubCli(root, 'literal-cli', `
      let input='';process.stdin.setEncoding('utf8');
      process.stdin.on('data', d=>input+=d);
      process.stdin.on('end',()=>{
        console.log(JSON.stringify({args,cwd:process.cwd(),env:process.env.SYNTHETIC_STUB_VALUE,input}));
        console.error('stderr-marker');process.exitCode=7;
      });`);
    const args = ['', 'plain', 'two words', '雪', 'quote"inside', 'ends in slash\\', '& echo NOT_A_SHELL', 'line\nbreak'];
    const env = { ...process.env, SYNTHETIC_STUB_VALUE: 'fixture-value' };
    const result = await runCommand({ cmd: bin, args, cwd: root, env, input: 'stdin-marker\n', timeoutMs: 5000 });
    assert.equal(result.code, 7, result.stderr);
    assert.equal(result.timedOut, false);
    assert.deepEqual(JSON.parse(result.stdout), { args, cwd: root, env: 'fixture-value', input: 'stdin-marker\n' });
    assert.match(result.stderr, /stderr-marker/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('native Windows fixture timeout ends the launcher and its Node child', { skip: process.platform !== 'win32' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'conductor-stub-timeout-'));
  try {
    const bin = writeStubCli(root, 'hanging-cli', `
      require('node:fs').writeFileSync('child.pid',String(process.pid));
      process.stdout.write('started-marker');setTimeout(()=>{},10000);`);
    const result = await runCommand({ cmd: bin, cwd: root, timeoutMs: 2000 });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /started-marker/);
    const pid = Number(readFileSync(path.join(root, 'child.pid'), 'utf8'));
    assert.throws(() => process.kill(pid, 0), /ESRCH|no such process|not found/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
