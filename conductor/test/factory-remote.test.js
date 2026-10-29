import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { shQuote, assertSafe, lockScript, unlockScript, readLockScript, teardownScript, sweepScript, parseMarker, ownerJson } from '../src/factory/remote.js';
import { createSsh } from '../src/factory/ssh.js';
import { runCommand } from '../src/exec.js';
import { stubDockerPath } from './helpers/stubDocker.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
const P1 = 'hf-acme-ltd-20261027-143005-a1b2';
const P2 = 'hf-acme-ltd-20261020-090000-ffff';
const owner = (run = '20261027-143005-a1b2') => ownerJson({ factory: 'hf', project: 'acme-ltd', run, purpose: 'preview', createdAt: '2026-10-27T14:30:05Z' });
async function sh(script, env = {}) {
  const r = await runCommand({ cmd: 'bash', args: ['-s'], input: script, env: { ...process.env, ...env } });
  return { ...r, ...parseMarker(r.stdout) };
}

test('quoting and the safety patterns', () => {
  assert.equal(shQuote("Acme'; rm -rf /"), "'Acme'\\''; rm -rf /'");
  assert.equal(assertSafe('slug', 'acme-ltd'), 'acme-ltd');
  for (const p of ['preview', 'council', 'smoke', 'ship']) assert.equal(assertSafe('purpose', p), p);
  for (const [k, v] of [['slug', 'acme ltd'], ['runId', '$(id)'], ['path', '/srv/../etc'], ['path', 'relative'], ['host', 'a;b'], ['user', 'Root'], ['port', 70000], ['client', 'a\nb'], ['purpose', 'mining'], ['project', 'hf-x']]) {
    assert.throws(() => assertSafe(k, v), /unsafe .* for a remote command/, `${k} ${v}`);
  }
});

test('the host lock: one holder at a time, only the holder releases it', async () => {
  const root = tmp('root-');
  assert.equal((await sh(lockScript({ root, owner: owner() }))).marker, 'HF-LOCKED');
  const busy = await sh(lockScript({ root, owner: owner('20261027-150000-cccc') }));
  assert.equal(busy.marker, 'HF-BUSY');
  assert.equal(JSON.parse(busy.rest).run, '20261027-143005-a1b2');
  assert.equal((await sh(readLockScript({ root }))).marker, 'HF-HELD');
  assert.equal((await sh(unlockScript({ root, runId: '20261027-150000-cccc' }))).marker, 'HF-NOT-OURS');
  assert.equal((await sh(unlockScript({ root, runId: '20261027-143005-a1b2' }))).marker, 'HF-UNLOCKED');
  assert.equal((await sh(readLockScript({ root }))).marker, 'HF-FREE');
  assert.equal((await sh(unlockScript({ root, runId: '20261027-143005-a1b2' }))).marker, 'HF-NO-LOCK');
});

test('teardown: compose down -v for the run\'s own project, its images removed, its folder gone', async () => {
  const root = tmp('root-');
  mkdirSync(path.join(root, 'runs', P1, 'bundle'), { recursive: true });
  writeFileSync(path.join(root, 'runs', P1, 'bundle', 'compose.yaml'), 'services: {}\n');
  const { binDir, logFile } = stubDockerPath(tmp('bin-'));
  const r = await sh(teardownScript({ root, project: P1, images: ['hf-preview/acme-ltd-app:20261027-143005-a1b2'] }), { PATH: `${binDir}:${process.env.PATH}` });
  assert.equal(r.marker, 'HF-TORN-DOWN');
  const calls = readFileSync(logFile, 'utf8');
  assert.match(calls, new RegExp(`compose -p ${P1} --profile tools --profile tunnel down -v --remove-orphans`));
  assert.match(calls, /rmi hf-preview\/acme-ltd-app:20261027-143005-a1b2/);
  assert.equal(existsSync(path.join(root, 'runs', P1)), false);
});

test('teardown reports containers it could not remove', async () => {
  const { binDir } = stubDockerPath(tmp('bin-'), { ps: 'abc123\n' });
  const r = await sh(teardownScript({ root: tmp('root-'), project: P1 }), { PATH: `${binDir}:${process.env.PATH}` });
  assert.equal(r.marker, 'HF-LEFTOVERS');
  assert.equal(r.rest.trim(), '1');
});

test('sweep removes old hf-* runs only, sparing kept and young ones and anything not ours', async () => {
  const root = tmp('root-');
  for (const p of [P1, P2, 'hf-other-thing', 'someone-elses']) mkdirSync(path.join(root, 'runs', p), { recursive: true });
  const old = Date.now() / 1000 - 10 * 3600;
  for (const p of [P2, 'hf-other-thing', 'someone-elses']) utimesSync(path.join(root, 'runs', p), old, old);
  const { binDir } = stubDockerPath(tmp('bin-'));
  const r = await sh(sweepScript({ root, olderThanSec: 6 * 3600, keepRuns: [] }), { PATH: `${binDir}:${process.env.PATH}` });
  assert.deepEqual(r.stdout.split('\n').filter((l) => l.startsWith('HF-SWEPT')), [`HF-SWEPT ${P2}`]);
  assert.equal(existsSync(path.join(root, 'runs', P1)), true, 'young run kept');
  assert.equal(existsSync(path.join(root, 'runs', 'someone-elses')), true, 'not ours: never touched');
  const kept = await sh(sweepScript({ root, olderThanSec: 0, keepRuns: ['20261027-143005-a1b2'] }), { PATH: `${binDir}:${process.env.PATH}` });
  assert.equal(kept.stdout.includes(`HF-SWEPT ${P1}`), false);
});

test('ssh: batch mode, the machine\'s key, strict host keys for static, accept-new into its own file for a new container', async () => {
  const calls = [];
  const run = async (o) => { calls.push(o); return { code: 0, stdout: 'HF-LOCKED\n', stderr: '' }; };
  const ssh = createSsh({ run });
  const m = { host: '192.168.1.111', ssh: { user: 'root', keyPath: '/home/op/.ssh/id_ed25519', knownHostsFile: null, hostKeyPolicy: 'yes' } };
  await ssh.exec(m, 'echo hi');
  assert.deepEqual(calls[0].args, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30', '-o', 'IdentitiesOnly=yes',
    '-i', '/home/op/.ssh/id_ed25519', '-o', 'StrictHostKeyChecking=yes', 'root@192.168.1.111', 'bash -s']);
  assert.equal(calls[0].input, 'echo hi');
  const c = { host: '192.168.1.120', ssh: { user: 'root', keyPath: '/k', knownHostsFile: '/home/op/.conductor/machines/known_hosts-9100', hostKeyPolicy: 'accept-new' } };
  await ssh.upload(c, '/tmp/source.tar.gz', '/srv/hf-factory/runs/x/source.tar.gz');
  assert.equal(calls[1].cmd, 'scp');
  assert.ok(calls[1].args.includes('StrictHostKeyChecking=accept-new'));
  assert.ok(calls[1].args.includes('UserKnownHostsFile=/home/op/.conductor/machines/known_hosts-9100'));
  assert.deepEqual(calls[1].args.slice(-2), ['/tmp/source.tar.gz', 'root@192.168.1.120:/srv/hf-factory/runs/x/source.tar.gz']);
  await assert.rejects(ssh.exec({ ...m, host: 'a;b' }, 'x'), /unsafe host/);
  assert.equal(calls.length, 2, 'nothing ran for the unsafe host');
});

test('hostile values never reach bash unquoted (Q21, Review Focus 4)', async () => {
  assert.throws(() => assertSafe('host', '-oProxyCommand=x'), /unsafe host/);
  assert.throws(() => assertSafe('path', '/srv/a/../b'), /unsafe path/);
  const ssh = createSsh({ run: async () => { throw new Error('must not run'); } });
  const m = { host: '-oProxyCommand=x', ssh: { user: 'root', keyPath: '/k', hostKeyPolicy: 'yes' } };
  await assert.rejects(ssh.exec(m, 'x'), /unsafe host/);
  await assert.rejects(ssh.upload({ ...m, host: 'h' }, '/a', '/srv/../x'), /unsafe path/);
  // a hostile root and owner are quoted, not executed
  const base = tmp('root-');
  const evil = path.join(base, "a'; touch PWNED; '");
  assert.throws(() => lockScript({ root: evil, owner: '{}' }), /unsafe path/);
  const root = path.join(base, 'ok');
  const hostileOwner = `{"run":"x'; touch ${base}/PWNED; '"}`;
  assert.equal((await sh(lockScript({ root, owner: hostileOwner }))).marker, 'HF-LOCKED');
  assert.equal(existsSync(path.join(base, 'PWNED')), false);
  assert.throws(() => unlockScript({ root, runId: '$(id)' }), /unsafe runId/);
  assert.throws(() => teardownScript({ root, project: P1, images: ["x:y'; id"] }), /unsafe image/);
});
