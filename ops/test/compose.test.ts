import { test, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dockerCompose, loadImageFile, readEnvValue } from '../src/compose.js';
import { fileLock } from '../src/lock.js';
import { fakeRunner } from './helpers.js';

const line = (c: { cmd: string; args: string[] }): string => [c.cmd, ...c.args].join(' ');

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'hf-compose-'));
}

test('every command is docker compose --project-directory <bundleDir> -p <project> …, and never -f', async () => {
  const rec = fakeRunner();
  const c = dockerCompose({ run: rec, bundleDir: '/opt/hf', project: 'acme' });
  await c.up('app');
  await c.stop('ops');
  expect(await c.runOnce('migrate')).toEqual({ ok: true, output: '' });
  expect(rec.calls.map(line)).toEqual([
    'docker compose --project-directory /opt/hf -p acme up -d --no-deps app',
    'docker compose --project-directory /opt/hf -p acme stop ops',
    'docker compose --project-directory /opt/hf -p acme run --rm --no-deps migrate',
  ]);
  for (const call of rec.calls) {
    expect(call.args).not.toContain('-f');
    expect(call.timeoutMs).toBeGreaterThan(0);
  }
});

test('up never starts dependencies, so the one-shot edge check is never part of starting the app', async () => {
  const rec = fakeRunner();
  await dockerCompose({ run: rec, bundleDir: '/opt/hf', project: 'acme' }).up('app');
  expect(rec.calls[0]!.args).toContain('--no-deps');
  expect(rec.calls[0]!.args).not.toContain('edge-check');
});

test('docker gets only the environment it is given (registry sign-in folder), never the ops secrets', async () => {
  const rec = fakeRunner();
  await dockerCompose({ run: rec, bundleDir: '/opt/hf', project: 'acme', env: { DOCKER_CONFIG: '/opt/hf/.docker' } }).up('app');
  expect(rec.calls[0]!.env).toEqual({ DOCKER_CONFIG: '/opt/hf/.docker' });
});

test('imageAvailable: a local image is enough; otherwise it is pulled; true if either works', async () => {
  const rec = fakeRunner((c) => ({ code: c.args[0] === 'image' ? 1 : 0, stdout: '', stderr: '' }));
  const c = dockerCompose({ run: rec, bundleDir: '/opt/hf', project: 'acme' });
  expect(await c.imageAvailable('registry.example.com/highland/app:1.1.0')).toBe(true);
  expect(rec.calls.map(line)).toEqual([
    'docker image inspect --format {{.Id}} registry.example.com/highland/app:1.1.0',
    'docker pull registry.example.com/highland/app:1.1.0',
  ]);
  rec.calls.length = 0;
  rec.respond(() => ({ code: 0, stdout: 'sha256:1', stderr: '' }));
  expect(await c.imageAvailable('highland/app:1.1.0')).toBe(true);
  expect(rec.calls).toHaveLength(1);
  rec.respond(() => ({ code: 1, stdout: '', stderr: 'pull access denied' }));
  expect(await c.imageAvailable('highland/app:9.9.9')).toBe(false);
});

test('a failed stop or start throws a plain sentence naming the part, never docker output', async () => {
  const rec = fakeRunner(() => ({ code: 1, stdout: '', stderr: 'Error response from daemon: secret-ish detail' }));
  const c = dockerCompose({ run: rec, bundleDir: '/opt/hf', project: 'acme' });
  await expect(c.stop('app')).rejects.toThrow('Docker could not stop the app (docker compose stopped with code 1).');
  await expect(c.up('ops')).rejects.toThrow('Docker could not start the monitor (ops) (docker compose stopped with code 1).');
  expect(await c.runOnce('migrate')).toEqual({ ok: false, output: 'Error response from daemon: secret-ish detail' });
});

test('readTag and writeTag: only the APP_TAG line changes, through a temp file and rename, keeping the file mode', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, '.env'), 'A=1\nAPP_TAG=1.0.0\nB=2\n', { mode: 0o600 });
    const c = dockerCompose({ run: fakeRunner(), bundleDir: dir, project: 'acme' });
    expect(await c.readTag()).toBe('1.0.0');
    await c.writeTag('1.1.0');
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('A=1\nAPP_TAG=1.1.0\nB=2\n');
    expect(await readdir(dir)).toEqual(['.env']);
    expect((await stat(path.join(dir, '.env'))).mode & 0o777).toBe(0o600);
    expect(await c.readTag()).toBe('1.1.0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeTag on a file with no APP_TAG line throws, and leaves the file alone', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, '.env'), 'A=1\n# APP_TAG=1.0.0\n');
    const c = dockerCompose({ run: fakeRunner(), bundleDir: dir, project: 'acme' });
    await expect(c.writeTag('1.1.0')).rejects.toThrow('The deployment settings (.env) have no APP_TAG line.');
    await expect(c.readTag()).rejects.toThrow('The deployment settings (.env) have no APP_TAG line.');
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('A=1\n# APP_TAG=1.0.0\n');
    expect(await readdir(dir)).toEqual(['.env']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeTag refuses anything that is not a Docker tag, so nothing can be slipped into .env', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, '.env'), 'APP_TAG=1.0.0\n');
    const c = dockerCompose({ run: fakeRunner(), bundleDir: dir, project: 'acme' });
    await expect(c.writeTag('1.1.0\nBACKUP_ALLOW_LOCAL=true')).rejects.toThrow(/is not a version name/);
    expect(await readFile(path.join(dir, '.env'), 'utf8')).toBe('APP_TAG=1.0.0\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('readEnvValue reads a plain or quoted setting, or undefined', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, '.env'), 'APP_IMAGE="registry.example.com/highland/app"\nOPS_IMAGE=\n# X=1\n');
    expect(await readEnvValue(dir, 'APP_IMAGE')).toBe('registry.example.com/highland/app');
    expect(await readEnvValue(dir, 'OPS_IMAGE')).toBeUndefined();
    expect(await readEnvValue(dir, 'X')).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadImageFile runs docker load -i <file> and reports failure in plain English', async () => {
  const rec = fakeRunner();
  expect(await loadImageFile(rec, '/opt/hf/images-1.1.0.tar')).toEqual({ ok: true, message: 'Loaded the images from images-1.1.0.tar.' });
  expect(rec.calls.map(line)).toEqual(['docker load -i /opt/hf/images-1.1.0.tar']);
  rec.respond(() => ({ code: 1, stdout: '', stderr: 'open: no such file' }));
  expect(await loadImageFile(rec, '/opt/hf/missing.tar')).toEqual({ ok: false, message: 'The image file missing.tar could not be loaded (docker load stopped with code 1). Check the file is in the bundle folder and complete.' });
});

test('fileLock: first acquire true, second false; after release true again; a lock older than an hour is replaced', async () => {
  const dir = await tmp();
  try {
    const p = path.join(dir, 'state', 'update.lock');
    await mkdir(path.dirname(p));
    const a = fileLock(p);
    const b = fileLock(p);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await b.release();                       // not the holder: must not remove a's lock
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(await b.acquire()).toBe(true);
    await b.release();

    await writeFile(p, 'left by a crashed update');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600e3);
    await utimes(p, twoHoursAgo, twoHoursAgo);
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    await a.release();
    expect(await readdir(path.dirname(p))).toEqual([]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fileLock uses the injected clock for staleness', async () => {
  const dir = await tmp();
  try {
    const p = path.join(dir, 'update.lock');
    await writeFile(p, 'x');
    expect(await fileLock(p, () => new Date(Date.now() + 30 * 60e3)).acquire()).toBe(false);
    expect(await fileLock(p, () => new Date(Date.now() + 61 * 60e3)).acquire()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
