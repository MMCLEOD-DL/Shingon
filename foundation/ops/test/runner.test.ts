import { test, expect } from 'vitest';
import { execRunner, redact } from '../src/runner.js';

test('the runner passes only the given environment and collects output', async () => {
  process.env['HF_SHOULD_NOT_LEAK'] = 'leak';
  const r = await execRunner.run('sh', ['-c', 'echo "a=$A leak=$HF_SHOULD_NOT_LEAK"; echo oops >&2; exit 3'], { env: { A: '1' } });
  delete process.env['HF_SHOULD_NOT_LEAK'];
  expect(r).toEqual({ code: 3, stdout: 'a=1 leak=\n', stderr: 'oops\n' });
});

test('a command that runs too long is stopped and reported as timed out', async () => {
  const started = Date.now();
  const r = await execRunner.run('sleep', ['30'], { timeoutMs: 300 });
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(r.timedOut).toBe(true);
  expect(r.code).not.toBe(0);
});

test('secrets from the environment never come back in the output', async () => {
  const r = await execRunner.run('sh', ['-c', 'echo "pw=$RESTIC_PASSWORD url=rest:https://bob:hunter22@nas/x" >&2'], { env: { RESTIC_PASSWORD: 'sup3r-secret-value' } });
  expect(r.stderr).toBe('pw=[hidden] url=rest:https://bob:***@nas/x\n');
  expect(redact('db postgres://app:pw1234@db/app', {})).toBe('db postgres://app:***@db/app');
});

test('a missing program is reported, not thrown', async () => {
  const r = await execRunner.run('hf-no-such-program', [], {});
  expect(r.code).not.toBe(0);
  expect(r.stderr).toMatch(/could not be started/);
});
