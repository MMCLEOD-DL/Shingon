import { test, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dockerCompose, imageFileInBundle, isDockerHub, isQualified, loadImageFile, readEnvValue } from '../src/compose.js';
import { fileLock, holderFromInspect, type LockHolder } from '../src/lock.js';
import { durableWrite, plainFsError, type DurableFs } from '../src/durable.js';
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

test('fileLock: first acquire true, second false; after release true again; a lock older than 4 hours is replaced', async () => {
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
    expect(await a.acquire()).toBe(false);   // 2 hours: a long backup may still be running
    const fiveHoursAgo = new Date(Date.now() - 5 * 3600e3);
    await utimes(p, fiveHoursAgo, fiveHoursAgo);
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
    expect(await fileLock(p, () => new Date(Date.now() + 3 * 3600e3)).acquire()).toBe(false);
    expect(await fileLock(p, () => new Date(Date.now() + 4.1 * 3600e3)).acquire()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('fileLock takes over a fresh lock only when its holder is shown to be gone', async () => {
  const dir = await tmp();
  try {
    const p = path.join(dir, 'update.lock');
    await writeFile(p, JSON.stringify({ pid: 4242, host: 'deadbeef1234', at: new Date().toISOString() }));
    const asked: LockHolder[] = [];
    expect(await fileLock(p, undefined, { isAlive: async (h) => { asked.push(h); return true; } }).acquire()).toBe(false);
    expect(asked).toEqual([{ pid: 4242, host: 'deadbeef1234', at: expect.any(String) as string }]);
    expect(await fileLock(p, undefined, { isAlive: async () => { throw new Error('docker unreachable'); } }).acquire()).toBe(false);   // unsure: keep it
    const l = fileLock(p, undefined, { isAlive: async () => false });
    expect(await l.acquire()).toBe(true);
    expect(JSON.parse(await readFile(p, 'utf8'))).toMatchObject({ pid: process.pid });
    await l.release();
    await writeFile(p, 'not json');   // a holder that cannot be read is never assumed gone (until 4 hours)
    expect(await fileLock(p, undefined, { isAlive: async () => false }).acquire()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('isQualified: only names that say which registry they live on', () => {
  for (const q of ['registry.example.com/highland/app', 'localhost:5000/highland/app', '127.0.0.1:5000/highland/ops', 'localhost/highland/app', 'ghcr.io/acme/app']) expect(isQualified(q), q).toBe(true);
  for (const u of ['highland/app', 'highland/ops', 'app', 'acme/highland/app']) expect(isQualified(u), u).toBe(false);
  // N4: Docker Hub spelt out is still Docker Hub.
  for (const h of ['docker.io/highland/app', 'DOCKER.IO/highland/app', 'index.docker.io/highland/app', 'Registry-1.Docker.io/highland/app', 'docker.io:443/highland/app']) {
    expect(isQualified(h), h).toBe(false);
    expect(isDockerHub(h), h).toBe(true);
  }
  expect(isDockerHub('registry.example.com/highland/app')).toBe(false);
  expect(isDockerHub('highland/app')).toBe(false);
});

test('unqualified images are never pulled (Docker Hub\'s "highland" belongs to someone else); qualified ones are', async () => {
  const rec = fakeRunner(() => ({ code: 1, stdout: '', stderr: '' }));
  const c = dockerCompose({ run: rec, bundleDir: '/opt/hf', project: 'acme' });
  expect(await c.imageAvailable('highland/app:1.1.0')).toBe(false);
  expect(rec.calls.map(line)).toEqual(['docker image inspect --format {{.Id}} highland/app:1.1.0']);
  rec.calls.length = 0;
  await c.imageAvailable('localhost:5000/highland/app:1.1.0');
  expect(rec.calls.map(line)).toEqual(['docker image inspect --format {{.Id}} localhost:5000/highland/app:1.1.0', 'docker pull localhost:5000/highland/app:1.1.0']);
  rec.calls.length = 0;
  expect(await c.hasLocalImage!('registry.example.com/highland/app:1.0.0')).toBe(false);
  expect(rec.calls.map(line)).toEqual(['docker image inspect --format {{.Id}} registry.example.com/highland/app:1.0.0']);   // never pulls
});

test('imageFileInBundle: the file must really be inside the bundle folder', async () => {
  const dir = await tmp();
  const outside = await tmp();
  try {
    await writeFile(path.join(dir, 'images-1.1.0.tar'), 'x');
    await writeFile(path.join(outside, 'evil.tar'), 'x');
    expect(await imageFileInBundle(dir, 'images-1.1.0.tar')).toBe(path.join(await realpathOf(dir), 'images-1.1.0.tar'));
    await expect(imageFileInBundle(dir, path.join(outside, 'evil.tar'))).rejects.toThrow(`The image file must be inside the bundle folder (${dir}).`);
    await expect(imageFileInBundle(dir, '../' + path.basename(outside) + '/evil.tar')).rejects.toThrow('must be inside the bundle folder');
    await expect(imageFileInBundle(dir, 'missing.tar')).rejects.toThrow('The image file missing.tar could not be found in the bundle folder (the file or folder does not exist).');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}

function recordingFs(fail?: { op: string; code: string }): DurableFs & { ops: string[] } {
  const ops: string[] = [];
  const maybe = (op: string): void => { if (fail?.op === op) throw Object.assign(new Error(op), { code: fail.code }); };
  return {
    ops,
    open: async (p, flags) => {
      ops.push(`open ${path.basename(p)} ${flags}`);
      return {
        writeFile: async () => { ops.push('write'); maybe('write'); },
        sync: async () => { ops.push(`sync ${path.basename(p)}`); },
        close: async () => { ops.push(`close ${path.basename(p)}`); },
      };
    },
    chmod: async () => { ops.push('chmod'); },
    chown: async () => { ops.push('chown'); },
    rename: async (_a, b) => { ops.push(`rename -> ${path.basename(b)}`); maybe('rename'); },
    rm: async (p) => { ops.push(`rm ${path.basename(p).startsWith('.env.tmp') ? 'tmp' : p}`); },
  };
}

test('durableWrite: write, flush the file, rename, then flush the folder', async () => {
  const fs = recordingFs();
  await durableWrite('/opt/hf/.env', 'APP_TAG=1.1.0\n', { mode: 0o600, owner: { uid: 0, gid: 0 } }, fs);
  expect(fs.ops.map((o) => o.replace(/\.env\.tmp-[0-9a-f]+/, '.env.tmp'))).toEqual([
    'open .env.tmp wx', 'write', 'sync .env.tmp', 'close .env.tmp', 'chmod', 'chown', 'rename -> .env', 'open hf r', 'sync hf', 'close hf',
  ]);
});

test('writeTag goes through durableWrite, and a disk problem is said in plain English (no bare error code)', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, '.env'), 'APP_TAG=1.0.0\n', { mode: 0o600 });
    const fs = recordingFs({ op: 'write', code: 'ENOSPC' });
    const c = dockerCompose({ run: fakeRunner(), bundleDir: dir, project: 'acme', fs });
    await expect(c.writeTag('1.1.0')).rejects.toThrow('The new version could not be written into the deployment settings (.env): the disk is full.');
    expect(fs.ops).toContain('rm tmp');
    expect(fs.ops.some((o) => o.startsWith('rename'))).toBe(false);
    const ok = recordingFs();
    await dockerCompose({ run: fakeRunner(), bundleDir: dir, project: 'acme', fs: ok }).writeTag('1.1.0');
    expect(ok.ops.filter((o) => o.startsWith('sync'))).toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('plainFsError maps codes to words', () => {
  expect(plainFsError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('permission was refused');
  expect(plainFsError(Object.assign(new Error('x'), { code: 'EROFS' }))).toBe('the disk is read-only');
  expect(plainFsError(Object.assign(new Error('x'), { code: 'EWHATEVER' }))).toBe('an unexpected file-system problem');
  expect(plainFsError(new Error('x'))).toBe('an unexpected file-system problem');
});

test('N3: a readable holder that is alive keeps its lock however old; the age limit is only for an unreadable holder', async () => {
  const dir = await tmp();
  try {
    const p = path.join(dir, 'update.lock');
    await writeFile(p, JSON.stringify({ pid: 1, host: 'abc123', at: '2026-10-26T00:00:00Z' }));
    const tenHoursAgo = new Date(Date.now() - 10 * 3600e3);
    await utimes(p, tenHoursAgo, tenHoursAgo);
    expect(await fileLock(p, undefined, { isAlive: async () => true }).acquire()).toBe(false);   // a long update still running
    expect(await fileLock(p, undefined, { isAlive: async () => false }).acquire()).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('N3: docker inspect: only "no such container/object" (or a stopped container) means gone; any other error or a time-out means alive', () => {
  expect(holderFromInspect({ code: 1, stdout: '', stderr: 'Error: No such object: abc123' })).toBe(false);
  expect(holderFromInspect({ code: 1, stdout: '', stderr: 'Error response from daemon: No such container: abc123' })).toBe(false);
  expect(holderFromInspect({ code: 0, stdout: 'false\n', stderr: '' })).toBe(false);
  expect(holderFromInspect({ code: 0, stdout: 'true\n', stderr: '' })).toBe(true);
  expect(holderFromInspect({ code: 1, stdout: '', stderr: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' })).toBe(true);
  expect(holderFromInspect({ code: 127, stdout: '', stderr: 'docker could not be started.' })).toBe(true);
  expect(holderFromInspect({ code: 143, stdout: '', stderr: '', timedOut: true })).toBe(true);
});
