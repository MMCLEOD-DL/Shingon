import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BACKEND_ENV_KEYS } from '../src/config.js';
import type { DurableFs } from '../src/durable.js';
import { generateEnv } from '../src/init.js';
import { fileLock } from '../src/lock.js';
import { applySettings, BUSY, GENERATED_ENV_KEYS, parseSettings, setEnvCli, setEnvFile, SETTABLE_ENV_KEYS, type SetEnvCliIo } from '../src/setEnv.js';

let dir = '';
let state = '';
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'hf-set-env-')); state = await mkdtemp(path.join(tmpdir(), 'hf-set-env-state-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); await rm(state, { recursive: true, force: true }); });

const ENV = [
  '# Highland deployment settings for Acme.',
  '',
  '# Mail',
  '# Where the app sends mail.',
  'SMTP_URL=old',
  'EMAIL_FROM=app@acme.test',
  '',
  '# Alerts',
  '# Matrix room that gets the alerts: the server address,',
  '# MATRIX_HOMESERVER=',
  'DB_PASSWORD=secret-not-to-be-touched',
  '',
].join('\n');

/** The calls durableWrite makes, in order (as compose.test.ts does for writeTag). Nothing reaches the disk. */
function recordingFs(): DurableFs & { ops: string[] } {
  const ops: string[] = [];
  const name = (p: string): string => (path.basename(p).startsWith('.env.tmp') ? '.env.tmp' : path.basename(p));
  return {
    ops,
    open: async (p, flags, mode) => {
      ops.push(`open ${name(p)} ${flags}${mode !== undefined ? ` ${mode.toString(8)}` : ''}`);
      return { writeFile: async () => { ops.push('write'); }, sync: async () => { ops.push(`sync ${name(p)}`); }, close: async () => { ops.push(`close ${name(p)}`); } };
    },
    chmod: async (_p, mode) => { ops.push(`chmod ${mode.toString(8)}`); },
    chown: async (_p, uid, gid) => { ops.push(`chown ${String(uid)}:${String(gid)}`); },
    rename: async (_a, b) => { ops.push(`rename -> ${path.basename(b)}`); },
    rm: async (p) => { ops.push(`rm ${name(p)}`); },
  };
}

describe('the settable keys', () => {
  test('every key ops init writes is either settable or generated', () => {
    for (const tunnel of [false, true]) {
      const { env } = generateEnv({ client: 'Acme', origin: 'https://app.acme.test', siteAddress: ':80', bundleDir: '/opt/hf', mode: 'production', tunnel });
      const keys = [...env.matchAll(/^(?:# )?([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]!);
      expect(keys.length).toBeGreaterThan(30);
      for (const k of keys) expect([...SETTABLE_ENV_KEYS, ...GENERATED_ENV_KEYS], k).toContain(k);
    }
  });

  test('the keys Conductor sets are all accepted', () => {
    const conductor = ['APP_TAG', 'APP_IMAGE', 'OPS_IMAGE', 'IMAGE_PULL_POLICY', 'COMPOSE_PROFILES', 'SMTP_URL', 'EMAIL_FROM', 'BACKUP_REPOSITORY', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_DEFAULT_REGION', 'B2_ACCOUNT_ID', 'B2_ACCOUNT_KEY', 'RESTIC_REST_USERNAME', 'RESTIC_REST_PASSWORD', 'MATRIX_HOMESERVER', 'MATRIX_ACCESS_TOKEN', 'MATRIX_ROOM_ID', 'ALERT_WEBHOOK_URL', 'HEARTBEAT_URL', 'TUNNEL_TOKEN', 'TUNNEL_ENABLED'];
    for (const k of conductor) expect(SETTABLE_ENV_KEYS).toContain(k);
    for (const k of BACKEND_ENV_KEYS) expect(SETTABLE_ENV_KEYS).toContain(k);
  });

  test('the OCR settings are settable, so a box can switch OCR engine without editing .env by hand', () => {
    for (const k of ['OCR_ENGINE', 'OCR_CONCURRENCY', 'OCR_TIMEOUT_MS', 'OCR_AZURE_ENDPOINT', 'OCR_AZURE_KEY', 'OCR_AZURE_REGION']) expect(SETTABLE_ENV_KEYS, k).toContain(k);
  });

  test('the list is sorted, has no repeats and no generated key', () => {
    expect([...SETTABLE_ENV_KEYS]).toEqual([...new Set(SETTABLE_ENV_KEYS)].sort());
    expect(GENERATED_ENV_KEYS).toEqual(['DB_PASSWORD', 'HEALTH_TOKEN', 'BACKUP_PASSWORD', 'HF_BUNDLE_DIR', 'COMPOSE_PROJECT_NAME']);
    for (const k of GENERATED_ENV_KEYS) expect(SETTABLE_ENV_KEYS).not.toContain(k);
  });
});

describe('parseSettings', () => {
  test('parseSettings refuses unknown, generated, repeated and malformed lines, naming each', () => {
    const r = parseSettings('MATRIX_ROOM_ID=!a:b\nFOO=1\nDB_PASSWORD=x\nMATRIX_ROOM_ID=!c:d\nnot a setting\n');
    expect(r.problems).toEqual([
      'Line 2: FOO is not a setting ops knows.',
      'Line 3: DB_PASSWORD is made by ops init and cannot be changed this way.',
      'Line 4: MATRIX_ROOM_ID is given twice.',
      'Line 5 is not KEY=value.',
    ]);
    expect(r.problems.join('\n')).not.toContain('!c:d');
  });

  test('blank lines and # comments are skipped; values are kept exactly, = and spaces included', () => {
    expect(parseSettings('\n# the alert room\n   \nMATRIX_ROOM_ID=!a:b\nEMAIL_FROM=Acme Ltd <app@acme.test>\nSMTP_URL=smtp://u:p=w@h:587\nTUNNEL_TOKEN=')).toEqual({
      settings: [
        { key: 'MATRIX_ROOM_ID', value: '!a:b' },
        { key: 'EMAIL_FROM', value: 'Acme Ltd <app@acme.test>' },
        { key: 'SMTP_URL', value: 'smtp://u:p=w@h:587' },
        { key: 'TUNNEL_TOKEN', value: '' },
      ],
      problems: [],
    });
  });

  test('a value with a carriage return or NUL is refused, without repeating the value', () => {
    const r = parseSettings('MATRIX_ACCESS_TOKEN=syt_secret\r\nSMTP_URL=a\0b\n');
    expect(r.problems).toEqual([
      'Line 1: MATRIX_ACCESS_TOKEN has a carriage return or NUL character in its value. Values must be plain text on one line (save the file with Unix line endings).',
      'Line 2: SMTP_URL has a carriage return or NUL character in its value. Values must be plain text on one line (save the file with Unix line endings).',
    ]);
    expect(r.problems.join('')).not.toContain('syt_secret');
  });

  test('a generated key is refused even in its commented form, and lowercase or spaced keys are not KEY=value', () => {
    expect(parseSettings('HF_BUNDLE_DIR=/x\nmatrix_room_id=!a\nAPP_TAG =1\n').problems).toEqual([
      'Line 1: HF_BUNDLE_DIR is made by ops init and cannot be changed this way.',
      'Line 2 is not KEY=value.',
      'Line 3 is not KEY=value.',
    ]);
  });
});

describe('applySettings', () => {
  test('applySettings replaces the line or its commented form, else appends, keeping everything else', () => {
    const out = applySettings(ENV, [
      { key: 'MATRIX_HOMESERVER', value: 'https://matrix.example.org' },
      { key: 'SMTP_URL', value: 'smtp://mail.example.org:587' },
      { key: 'HEARTBEAT_URL', value: 'https://status.example.org/api/push/abc' },
    ]);
    const before = ENV.split('\n');
    const after = out.split('\n');
    expect(after[4]).toBe('SMTP_URL=smtp://mail.example.org:587');
    expect(after[9]).toBe('MATRIX_HOMESERVER=https://matrix.example.org');
    expect(after.slice(0, -1)).toHaveLength(before.length);   // one line appended, the rest stay put
    for (const [i, l] of before.entries()) if (i !== 4 && i !== 9 && i !== before.length - 1) expect(after[i]).toBe(l);
    expect(out.endsWith('\nHEARTBEAT_URL=https://status.example.org/api/push/abc\n')).toBe(true);
  });

  test('values are written as ops init writes them: a space, # or $ is quoted and $ is doubled', () => {
    const out = applySettings('EMAIL_FROM=x\n', [{ key: 'EMAIL_FROM', value: 'Acme Ltd <app@acme.test>' }, { key: 'SMTP_URL', value: 'smtp://u:pa$s@h' }]);
    expect(out).toBe('EMAIL_FROM="Acme Ltd <app@acme.test>"\nSMTP_URL="smtp://u:pa$$s@h"\n');
  });

  test('a file with no final newline gets one before the appended line; every live copy of a key is replaced', () => {
    expect(applySettings('A=1', [{ key: 'APP_TAG', value: '0.2.0' }])).toBe('A=1\nAPP_TAG=0.2.0\n');
    expect(applySettings('APP_TAG=0.1.0\n# APP_TAG=old\nAPP_TAG=0.1.1\n', [{ key: 'APP_TAG', value: '0.2.0' }])).toBe('APP_TAG=0.2.0\n# APP_TAG=old\nAPP_TAG=0.2.0\n');
  });
});

describe('setEnvFile', () => {
  test('setEnvFile writes atomically with the old mode and owner, and writes nothing on a problem', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, ENV, { mode: 0o600 });
    await chmod(file, 0o600);
    const st = await stat(file);
    const fs = recordingFs();
    expect(await setEnvFile(file, 'SMTP_URL=smtp://new\nMATRIX_HOMESERVER=https://m.example.org\n', fs)).toEqual({ ok: true, keys: ['MATRIX_HOMESERVER', 'SMTP_URL'] });
    expect(fs.ops).toEqual([
      'open .env.tmp wx 600', 'write', 'sync .env.tmp', 'close .env.tmp', 'chmod 600', `chown ${String(st.uid)}:${String(st.gid)}`, 'rename -> .env',
      `open ${path.basename(dir)} r`, `sync ${path.basename(dir)}`, `close ${path.basename(dir)}`,
    ]);

    const refused = recordingFs();
    const r = await setEnvFile(file, 'SMTP_URL=smtp://new\nDB_PASSWORD=x\n', refused);
    expect(r).toEqual({ ok: false, problems: ['Line 2: DB_PASSWORD is made by ops init and cannot be changed this way.'] });
    expect(refused.ops).toEqual([]);
    expect(await readFile(file, 'utf8')).toBe(ENV);
  });

  test('on the real disk: the new text is in place, the mode is kept and no temp file is left', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, ENV);
    await chmod(file, 0o640);
    expect(await setEnvFile(file, 'SMTP_URL=smtp://new\n')).toEqual({ ok: true, keys: ['SMTP_URL'] });
    expect(await readFile(file, 'utf8')).toBe(ENV.replace('SMTP_URL=old', 'SMTP_URL=smtp://new'));
    expect((await stat(file)).mode & 0o777).toBe(0o640);
    expect(await readdir(dir)).toEqual(['.env']);
  });

  test('no settings, or no .env, is refused plainly', async () => {
    const file = path.join(dir, '.env');
    expect(await setEnvFile(file, '# nothing\n\n')).toEqual({ ok: false, problems: ['No settings were given: standard input had no KEY=value lines.'] });
    expect(await setEnvFile(file, 'SMTP_URL=x\n')).toEqual({ ok: false, problems: [`There is no .env in ${dir}. Run ops init first.`] });
    expect(await readdir(dir)).toEqual([]);
  });

  test('a disk that fails part-way leaves the old file and says so plainly, without a value', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, ENV, { mode: 0o600 });
    const fs = recordingFs();
    fs.rename = async () => { throw Object.assign(new Error('rename'), { code: 'ENOSPC' }); };
    const r = await setEnvFile(file, 'SMTP_URL=smtp://secret-host\n', fs);
    expect(r).toEqual({ ok: false, problems: ['The settings could not be written into .env: the disk is full.'] });
    expect(await readFile(file, 'utf8')).toBe(ENV);
  });
});

describe('ops set-env', () => {
  function io(input: string, env: Record<string, string | undefined> = { HF_BUNDLE_DIR: dir, OPS_WORK_DIR: path.join(state, 'work') }, stdinIsTTY = false) {
    const out: string[] = [];
    const err: string[] = [];
    const o: SetEnvCliIo = { out: (l) => { out.push(...l.split('\n')); }, err: (l) => { err.push(...l.split('\n')); }, env, stdinIsTTY, readStdin: async () => input };
    return { o, out, err };
  }

  test('sets the settings, names the keys and never prints a value', async () => {
    await writeFile(path.join(dir, '.env'), ENV, { mode: 0o600 });
    const t = io('SMTP_URL=smtp://u:hunter22@mail\nMATRIX_ROOM_ID=!room:example.org\nMATRIX_HOMESERVER=https://m.example.org\n');
    expect(await setEnvCli([], t.o)).toBe(0);
    expect(t.out).toEqual(['Set 3 settings in .env: MATRIX_HOMESERVER, MATRIX_ROOM_ID, SMTP_URL. Restart the services that use them: docker compose up -d']);
    expect(t.err).toEqual([]);
    expect([...t.out, ...t.err].join('\n')).not.toMatch(/hunter22|!room|m\.example/);
  });

  test('a refused input lists every problem, says nothing was changed, exits 2 and leaves .env byte for byte', async () => {
    await writeFile(path.join(dir, '.env'), ENV, { mode: 0o600 });
    const t = io('MATRIX_ROOM_ID=!a:b\nFOO=1\nDB_PASSWORD=x\nMATRIX_ROOM_ID=!c:d\nnot a setting\n');
    expect(await setEnvCli([], t.o)).toBe(2);
    expect(t.out).toEqual([]);
    expect(t.err).toEqual([
      'Line 2: FOO is not a setting ops knows.',
      'Line 3: DB_PASSWORD is made by ops init and cannot be changed this way.',
      'Line 4: MATRIX_ROOM_ID is given twice.',
      'Line 5 is not KEY=value.',
      'Nothing was changed.',
    ]);
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe(ENV);
    expect(await readdir(dir)).toEqual(['.env']);
  });

  test('refuses options, a terminal on standard input and a missing HF_BUNDLE_DIR', async () => {
    const a = io('SMTP_URL=x\n');
    expect(await setEnvCli(['--force'], a.o)).toBe(2);
    expect(a.err[0]).toBe('set-env takes no options.');
    const b = io('', { HF_BUNDLE_DIR: dir, OPS_WORK_DIR: path.join(state, 'work') }, true);
    expect(await setEnvCli([], b.o)).toBe(2);
    expect(b.err).toEqual(['set-env reads KEY=value lines from standard input, for example: docker compose run --rm -T updater set-env < settings.txt']);
    const c = io('SMTP_URL=x\n', {});
    expect(await setEnvCli([], c.o)).toBe(2);
    expect(c.err).toEqual(['set-env runs in the updater service, which knows where the bundle is (HF_BUNDLE_DIR): docker compose run --rm -T updater set-env < settings.txt']);
  });
});

test('a failure after the new file is in place (flushing the folder) is never reported as "nothing was changed"', async () => {
  const { realFs } = await import('../src/durable.js');
  const file = path.join(dir, '.env');
  await writeFile(file, ENV, { mode: 0o600 });
  const fs: DurableFs = { ...realFs, open: (p, flags, mode) => (flags === 'r' ? Promise.reject(Object.assign(new Error('x'), { code: 'EIO' })) : realFs.open(p, flags, mode)) };
  expect(await setEnvFile(file, 'SMTP_URL=smtp://new\n', fs)).toEqual({
    ok: false, maybeChanged: true,
    problems: ['The settings could not be written into .env: the disk reported a read or write error. The new settings may already be in .env; check it before restarting anything.'],
  });
  const err: string[] = [];
  const code = await setEnvCli([], { out: () => undefined, err: (l) => err.push(l), env: { HF_BUNDLE_DIR: dir, OPS_WORK_DIR: path.join(state, 'work') }, stdinIsTTY: false, readStdin: async () => 'SMTP_URL=smtp://newer\n', fs });
  expect(code).toBe(1);
  expect(err.join('\n')).not.toContain('Nothing was changed.');
});

describe('the update lock', () => {
  test('while an update (or another set-env) holds the lock: refused with exit 2, nothing read or written', async () => {
    await writeFile(path.join(dir, '.env'), ENV, { mode: 0o600 });
    const held = fileLock(path.join(state, 'update.lock'));
    expect(await held.acquire()).toBe(true);
    try {
      const err: string[] = [];
      const fs = recordingFs();
      const code = await setEnvCli([], { out: () => undefined, err: (l) => err.push(l), env: { HF_BUNDLE_DIR: dir, OPS_WORK_DIR: path.join(state, 'work') }, stdinIsTTY: false, readStdin: async () => 'SMTP_URL=smtp://new\n', fs });
      expect(code).toBe(2);
      expect(err).toEqual([BUSY]);
      expect(BUSY).toBe('An update or another set-env is running, so nothing was changed. Try again when it has finished.');
      expect(fs.ops).toEqual([]);
      expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe(ENV);
    } finally {
      await held.release();
    }
    expect(await readdir(state)).toEqual([]);   // set-env never took (or removed) the update's lock
  });

  test('concurrent set-env runs no longer lose settings: every run that says it set a key really did', async () => {
    const file = path.join(dir, '.env');
    await writeFile(file, ENV, { mode: 0o600 });
    const keys = ['SMTP_URL', 'EMAIL_FROM', 'MATRIX_ROOM_ID', 'HEARTBEAT_URL', 'TUNNEL_TOKEN'];
    const results = await Promise.all(keys.map((k) => setEnvFile(file, `${k}=v-${k}\n`, undefined, { lock: fileLock(path.join(state, 'update.lock')) })));
    const text = await readFile(file, 'utf8');
    expect(results.some((r) => r.ok)).toBe(true);
    results.forEach((r, i) => {
      if (r.ok) expect(text).toContain(`\n${keys[i]!}=v-${keys[i]!}\n`);
      else expect(r).toEqual({ ok: false, problems: [BUSY], busy: true });
    });
    expect(await readdir(state)).toEqual([]);   // the lock is always released
    expect(await readdir(dir)).toEqual(['.env']);
  });

  test('without the lock folder the run is refused plainly and nothing is written', async () => {
    await writeFile(path.join(dir, '.env'), ENV, { mode: 0o600 });
    const err: string[] = [];
    const code = await setEnvCli([], { out: () => undefined, err: (l) => err.push(l), env: { HF_BUNDLE_DIR: dir, OPS_WORK_DIR: path.join(state, 'missing', 'work') }, stdinIsTTY: false, readStdin: async () => 'SMTP_URL=x\n' });
    expect(code).toBe(2);
    expect(err[0]).toMatch(/^The update lock \(.*update\.lock\) could not be taken: the file or folder does not exist\.$/);
    expect(err[1]).toBe('Nothing was changed.');
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe(ENV);
  });
});

describe('awkward files and input', () => {
  test('APP_TAG cannot be emptied; other settings can', () => {
    expect(parseSettings('APP_TAG=\nSMTP_URL=\n')).toEqual({ settings: [{ key: 'SMTP_URL', value: '' }], problems: ['Line 1: APP_TAG cannot be empty; the updater needs it.'] });
  });

  test('a .env that is a link is refused, and the file it points to is untouched', async () => {
    const { symlink } = await import('node:fs/promises');
    const real = path.join(state, 'real.env');
    await writeFile(real, ENV);
    await symlink(real, path.join(dir, '.env'));
    expect(await setEnvFile(path.join(dir, '.env'), 'SMTP_URL=x\n')).toEqual({ ok: false, problems: [`The .env in ${dir} is a link to another file, so set-env will not rewrite it (that would replace the link with a plain file).`] });
    expect(await readFile(real, 'utf8')).toBe(ENV);
  });

  test('a .env with Windows line endings keeps them; a byte-order mark on the input or the file is no problem', async () => {
    const crlf = ENV.replace(/\n/g, '\r\n');
    expect(applySettings(crlf, [{ key: 'SMTP_URL', value: 'new' }, { key: 'APP_TAG', value: '0.2.0' }])).toBe(crlf.replace('SMTP_URL=old', 'SMTP_URL=new') + 'APP_TAG=0.2.0\r\n');
    expect(parseSettings('\uFEFFSMTP_URL=x\n')).toEqual({ settings: [{ key: 'SMTP_URL', value: 'x' }], problems: [] });
    expect(applySettings('\uFEFFSMTP_URL=old\n', [{ key: 'SMTP_URL', value: 'new' }])).toBe('\uFEFFSMTP_URL=new\n');
  });
});
