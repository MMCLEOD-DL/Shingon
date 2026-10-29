// test/factory-env-file.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dotenvLine, setEnvCommand, SETTABLE } from '../src/factory/ship/envFile.js';

test('dotenvLine quotes exactly like the foundation and refuses line breaks', () => {
  assert.equal(dotenvLine('EMAIL_FROM', 'hr@acme.co.uk'), 'EMAIL_FROM=hr@acme.co.uk');
  assert.equal(dotenvLine('SMTP_URL', `smtp://u:p@ss w#rd$"\\'x@h:587`), String.raw`SMTP_URL="smtp://u:p@ss w#rd$$\"\\'x@h:587"`);
  assert.throws(() => dotenvLine('SMTP_URL', 'abc\ndef'), (e) => /line break/.test(e.message) && !e.message.includes('abc'));
  assert.throws(() => dotenvLine('DB_PASSWORD', 'x'), /may not set DB_PASSWORD/);
  assert.ok(!SETTABLE.includes('BACKUP_PASSWORD') && !SETTABLE.includes('HEALTH_TOKEN'));
});

test('the setter replaces commented and empty lines, appends the rest, keeps mode 600 (run with the local sh)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-'));
  const env = path.join(dir, '.env');
  writeFileSync(env, ['# The release to run.', '# APP_TAG=', 'APP_NAME="Acme Ltd"', '# Fill this in.', 'SMTP_URL=',
    '# Matrix room that gets the alerts: the server address,', '# MATRIX_HOMESERVER=', 'BACKUP_PASSWORD=abc', ''].join('\n'), { mode: 0o600 });
  const input = [dotenvLine('APP_TAG', '0.1.3'), dotenvLine('SMTP_URL', 'smtp://u:p#w@h'), dotenvLine('MATRIX_HOMESERVER', 'https://m.example.org'), dotenvLine('COMPOSE_PROFILES', 'tunnel')].join('\n') + '\n';
  const r = spawnSync('sh', ['-c', setEnvCommand(dir)], { input });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(readFileSync(env, 'utf8'), ['# The release to run.', 'APP_TAG=0.1.3', 'APP_NAME="Acme Ltd"', '# Fill this in.', 'SMTP_URL="smtp://u:p#w@h"',
    '# Matrix room that gets the alerts: the server address,', 'MATRIX_HOMESERVER=https://m.example.org', 'BACKUP_PASSWORD=abc', 'COMPOSE_PROFILES=tunnel', ''].join('\n'));
  assert.equal(statSync(env).mode & 0o777, 0o600);
});

test('setEnv sends nothing for an empty list; readBackupPassword unquotes and remembers before returning', async (t) => {
  const { fakeSsh } = await import('./helpers/fakeSsh.js');
  const { setEnv, readBackupPassword } = await import('../src/factory/ship/envFile.js');
  const { redact, forgetRememberedSecrets } = await import('../src/secrets.js');
  t.after(forgetRememberedSecrets);
  const T = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'envf-')), [
    { match: 'mktemp', code: 3, stderr: 'There is no .env in this folder.\n' },
    { match: 'BACKUP_PASSWORD', stdout: '"pa$$ss\\"word-123"\n' },
  ]);
  assert.deepEqual(await setEnv(T, '/opt/highland/acme', [], { env: f.env() }), { ok: true });
  assert.equal(f.calls().length, 0);
  const bad = await setEnv(T, '/opt/highland/acme', [{ key: 'EMAIL_FROM', value: 'hr@acme.co.uk' }], { env: f.env() });
  assert.deepEqual(bad, { ok: false, problem: 'The settings could not be written into .env on acme-office (There is no .env in this folder).' });
  const pw = await readBackupPassword(T, '/opt/highland/acme', { env: f.env() });
  assert.equal(pw, 'pa$ss"word-123');
  assert.equal(redact(`x ${pw} y`), 'x [redacted] y');
  assert.match(f.calls().at(-1).command, /^sed -n 's\/\^BACKUP_PASSWORD=\/\/p' '\/opt\/highland\/acme\/\.env'$/);
});
