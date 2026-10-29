import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getMachineProvider, MachineError } from '../src/factory/machines/index.js';
import { factoryConfig } from '../src/factory/config.js';
import { runCommand } from '../src/exec.js';
import { stubDockerPath } from './helpers/stubDocker.js';

const tmp = (p) => mkdtempSync(path.join(tmpdir(), p));
// An "ssh" that runs the script locally: each host's workRoot is a temp dir, docker is a stub.
function localSsh({ down = new Set() } = {}) {
  const { binDir } = stubDockerPath(tmp('bin-'));
  const calls = [];
  return { calls, exec: async (m, script) => {
    calls.push({ host: m.host, script });
    if (down.has(m.host)) return { code: 255, stdout: '', stderr: `ssh: connect to host ${m.host} port 22: No route to host` };
    return runCommand({ cmd: 'bash', args: ['-s'], input: script, env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
  } };
}
function provider({ hosts = 2, ssh = localSsh(), now = () => new Date('2026-10-27T14:30:05Z') } = {}) {
  const list = Array.from({ length: hosts }, (_, i) => ({ id: `h${i + 1}`, name: i === 0 ? 'hf-build' : `h${i + 1}`, host: `192.168.1.${111 + i}`, workRoot: tmp('root-') }));
  const factory = factoryConfig({ factory: { machines: { static: { hosts: list } } } }, { env: {} });
  return { p: getMachineProvider(factory, { ssh, now }), hosts: factory.machines.static.hosts, ssh };
}
const want = (run, slug = 'acme-ltd', purpose = 'preview') => ({ purpose, projectSlug: slug, runId: run });

test('acquire locks the first free host and describes the machine', async () => {
  const { p, hosts } = provider();
  const m = await p.acquire(want('20261027-143005-a1b2'));
  assert.equal(m.id, 'h1');
  assert.equal(m.host, '192.168.1.111');
  assert.deepEqual(m.ssh, { user: 'root', keyPath: m.ssh.keyPath, knownHostsFile: null, hostKeyPolicy: 'yes' });
  assert.deepEqual(m.labels, { factory: 'hf', project: 'acme-ltd', run: '20261027-143005-a1b2', purpose: 'preview', createdAt: '2026-10-27T14:30:05.000Z' });
  assert.equal(m.composeProject, 'hf-acme-ltd-20261027-143005-a1b2');
  assert.equal(m.runDir, `${hosts[0].workRoot}/runs/hf-acme-ltd-20261027-143005-a1b2`);
  assert.equal(m.previewPort, 8080);
  assert.equal(m.provider, 'static');
});

test('busy: the second use goes to the next host; when all are busy the operator is told who holds them', async () => {
  const { p } = provider();
  await p.acquire(want('20261027-143005-a1b2'));
  assert.equal((await p.acquire(want('20261027-143006-bbbb', 'bobs-bikes', 'council'))).id, 'h2');
  await assert.rejects(p.acquire(want('20261027-143007-cccc', 'zed')), (e) => e instanceof MachineError && e.code === 'busy'
    && /hf-build is running a preview for acme-ltd \(since \d\d:\d\d 27 Oct\)/.test(e.message)
    && /conductor preview acme-ltd --stop/.test(e.message));
});

test('release tears the run down and frees the host; only the holder can free it', async () => {
  const { p, hosts } = provider({ hosts: 1 });
  const m = await p.acquire(want('20261027-143005-a1b2'));
  mkdirSync(m.runDir, { recursive: true });
  await m.release();
  assert.equal(existsSync(m.runDir), false);
  const again = await p.acquire(want('20261027-150000-dddd'));
  await m.release();   // the old run's machine: must not free the new holder's lock
  assert.equal(existsSync(path.join(hosts[0].workRoot, 'lock')), true);
  await again.release();
  assert.equal(existsSync(path.join(hosts[0].workRoot, 'lock')), false);
});

test('an unreachable host is skipped; when none can be reached the message says how to check', async () => {
  const ssh = localSsh({ down: new Set(['192.168.1.111']) });
  const { p } = provider({ ssh });
  assert.equal((await p.acquire(want('20261027-143005-a1b2'))).id, 'h2');
  const { p: p1 } = provider({ hosts: 1, ssh: localSsh({ down: new Set(['192.168.1.111']) }) });
  await assert.rejects(p1.acquire(want('20261027-143005-a1b2')), (e) => e.code === 'unreachable'
    && /Conductor could not reach hf-build \(192\.168\.1\.111\) over SSH: No route to host/.test(e.message)
    && /ssh root@192\.168\.1\.111 true/.test(e.message));
});

test('list shows held machines; sweep releases old ones except kept runs', async () => {
  let clock = new Date('2026-10-27T02:00:00Z');
  const { p } = provider({ now: () => clock });
  await p.acquire(want('20261027-020000-aaaa'));
  await p.acquire(want('20261027-020001-bbbb', 'bobs-bikes', 'council'));
  assert.deepEqual((await p.list()).map((m) => [m.id, m.labels.project, m.labels.purpose]), [['h1', 'acme-ltd', 'preview'], ['h2', 'bobs-bikes', 'council']]);
  clock = new Date('2026-10-27T14:00:00Z');
  const n = await p.sweep({ olderThanMs: 6 * 3600_000, keep: ['20261027-020000-aaaa'] });
  assert.equal(n, 1);
  assert.deepEqual((await p.list()).map((m) => m.labels.run), ['20261027-020000-aaaa']);
});

test('no hosts configured is a plain configuration error', () => {
  assert.throws(() => getMachineProvider(factoryConfig({ factory: {} }, { env: {} })), (e) => e.code === 'config' && /No factory machines are set up/.test(e.message));
});

test('an ownerless lock is reported plainly, treated as busy, and swept when old', async () => {
  const { p, hosts } = provider({ hosts: 1 });
  mkdirSync(path.join(hosts[0].workRoot, 'lock'), { recursive: true });   // crash between mkdir and owner.json
  await assert.rejects(p.acquire(want('20261027-143005-a1b2')), (e) => e.code === 'busy'
    && /lock has no owner \(a run crashed while taking it\)/.test(e.message) && e.message.includes(`${hosts[0].workRoot}/lock`));
  assert.deepEqual(await p.list(), []);
  assert.match(p.notes.join(' '), /no owner/);
  assert.equal(await p.sweep({ olderThanMs: 3600_000 }), 0);   // too new
  assert.equal(existsSync(path.join(hosts[0].workRoot, 'lock')), true);
  const old = new Date(Date.now() - 7200_000);
  utimesSync(path.join(hosts[0].workRoot, 'lock'), old, old);
  assert.equal(await p.sweep({ olderThanMs: 3600_000 }), 1);
  assert.equal(existsSync(path.join(hosts[0].workRoot, 'lock')), false);
});

test('a host that is unsafe to use is refused before anything runs', async () => {
  const ssh = localSsh();
  const factory = factoryConfig({ factory: { machines: { static: { hosts: [{ id: 'h1', host: '-oProxyCommand', workRoot: tmp('root-') }] } } } }, { env: {} });
  const p = getMachineProvider(factory, { ssh });
  await assert.rejects(p.acquire(want('20261027-143005-a1b2')), (e) => e instanceof MachineError && e.code === 'config');
  assert.equal(ssh.calls.length, 0);
});

test('a failed teardown leaves the machine locked and says so', async () => {
  const factory = factoryConfig({ factory: { machines: { static: { hosts: [{ id: 'h1', name: 'hf-build', host: '192.168.1.111', workRoot: tmp('root-') }] } } } }, { env: {} });
  let n = 0;
  const ssh = { exec: async () => ({ code: 0, stdout: n++ === 0 ? 'HF-LOCKED\n' : 'HF-LEFTOVERS 2\n', stderr: '' }) };
  const mach = await getMachineProvider(factory, { ssh }).acquire(want('20261027-143005-a1b2'));
  await assert.rejects(mach.release(), (e) => e.code === 'failed' && /2 containers left/.test(e.message) && /stays locked/.test(e.message));
  assert.equal(n, 2);   // no unlock was attempted
});
