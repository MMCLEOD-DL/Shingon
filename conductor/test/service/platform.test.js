import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testShell } from '../../src/service/platform.js';
test('native Windows tests use cmd with AutoRun disabled and preserve the operator command as one argument', () => {
  const command = 'node --test "a b.test.js" && echo done';
  assert.deepEqual(testShell(command, { platform: 'win32', env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } }), {
    cmd: 'C:\\Windows\\System32\\cmd.exe', args: ['/d', '/s', '/c', command],
  });
});
test('Linux keeps the established test shell', () => {
  assert.deepEqual(testShell('npm test', { platform: 'linux' }), { cmd: 'sh', args: ['-c', 'npm test'] });
});
