import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testShell } from '../../src/service/platform.js';
import { runCommand } from '../../src/exec.js';

test('configured quoted test commands preserve a nonzero exit instead of reporting green', async () => {
  const result = await runCommand(testShell('node -e "process.exit(2)"'));
  assert.equal(result.code, 2, JSON.stringify(result));
});

test('configured test shell preserves quoted executable paths and literal arguments', async () => {
  const command = `"${process.execPath}" -e "process.stdout.write(process.argv[1])" "two words"`;
  const result = await runCommand(testShell(command));
  assert.equal(result.code, 0, JSON.stringify(result));
  assert.equal(result.stdout, 'two words');
});

test('a quoted failure short-circuits the configured compound test command', async () => {
  const result = await runCommand(testShell('node -e "process.exit(2)" && node -e "process.stdout.write(\'must-not-run\')"'));
  assert.equal(result.code, 2, JSON.stringify(result));
  assert.equal(result.stdout, '');
});
test('native Windows tests use cmd with AutoRun disabled and preserve the operator command as one argument', () => {
  const command = 'node --test "a b.test.js" && echo done';
  assert.deepEqual(testShell(command, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } }), {
    cmd: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatimArguments: true,
  });
});
test('Linux keeps the established test shell', () => {
  assert.deepEqual(testShell('npm test', { platform: 'linux' }), { cmd: 'sh', args: ['-c', 'npm test'] });
});
