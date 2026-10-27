import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { sshArgs, targetOf, targetOfMachine, targetProblem, remoteRun, remotePipe, sendFile, sshProblem, missingTools } from '../src/factory/ship/remote.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'remote-'));
const BOX = { host: 'acme-box', user: 'highland', port: null, keyPath: null, knownHostsFile: null, hostKeyPolicy: 'yes', label: 'acme-office' };
const BUILD = { host: 'hf-build', user: 'hf', port: 2222, keyPath: '/root/.ssh/hf', knownHostsFile: null, hostKeyPolicy: 'yes', label: 'the build machine' };

test('sshArgs never prompts, never trusts a new host key, and ends options before the host', () => {
  assert.deepEqual(sshArgs(BUILD, 'echo hi'), ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', '-p', '2222', '-i', '/root/.ssh/hf', '-o', 'IdentitiesOnly=yes',
    '-l', 'hf', '--', 'hf-build', 'echo hi']);
});

test('a box always checks host keys strictly; a factory machine keeps its provider\'s policy', () => {
  const dep = { name: 'acme-office', host: 'acme-box', ssh: { user: 'highland', port: 2200, keyPath: null } };
  assert.deepEqual(targetOf(dep), { host: 'acme-box', user: 'highland', port: 2200, keyPath: null, knownHostsFile: null, hostKeyPolicy: 'yes', label: 'acme-office' });
  const m = targetOfMachine({ id: 'm1', host: '10.0.0.9', ssh: { user: 'hf', keyPath: '/k', knownHostsFile: '/runs/kh', hostKeyPolicy: 'accept-new' } });
  assert.deepEqual(sshArgs(m, 'true').slice(0, 4), ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new']);
  assert.ok(sshArgs(m, 'true').includes('UserKnownHostsFile=/runs/kh'));
  assert.equal(m.label, 'the build machine (10.0.0.9)');
});

test('a host that looks like an option is refused without running ssh', async () => {
  assert.match(targetProblem({ ...BOX, host: '-oProxyCommand=evil' }), /does not look like a host name/);
  const f = fakeSsh(tmp());
  const r = await remoteRun({ ...BOX, host: '-oProxyCommand=evil' }, 'true', { env: f.env() });
  assert.equal(r.unreachable, true);
  assert.equal(f.calls().length, 0);
});

test('targetProblem refuses a bad user, port, key path and host-key policy', () => {
  assert.match(targetProblem({ ...BOX, user: '-oFoo' }), /user name/);
  assert.match(targetProblem({ ...BOX, port: 70000 }), /port/);
  assert.match(targetProblem({ ...BOX, keyPath: 'relative key' }), /key file/);
  assert.ok(targetProblem({ ...BOX, hostKeyPolicy: 'no' }));
  assert.equal(targetProblem({ host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'x' }), null);
});

test('remoteRun sends stdin, records the command, and reports ssh failures plainly', async () => {
  const f = fakeSsh(tmp(), [{ match: '^cat > /x$', code: 0 }, { match: '^boom$', code: 255, stderr: 'ssh: connect to host acme-box port 22: No route to host\n' }]);
  const ok = await remoteRun(BOX, 'cat > /x', { input: 'SMTP_URL=smtp://u:p@h\n', env: f.env() });
  assert.equal(ok.code, 0);
  assert.deepEqual(f.calls()[0].argv.slice(-3), ['--', 'acme-box', 'cat > /x']);
  assert.equal(f.calls()[0].stdin, 'SMTP_URL=smtp://u:p@h\n');
  assert.ok(!f.calls()[0].argv.join(' ').includes('smtp://'));
  const bad = await remoteRun(BOX, 'boom', { env: f.env() });
  assert.equal(bad.unreachable, true);
  assert.match(sshProblem(BOX, bad), /^Could not reach acme-office over SSH: ssh: connect to host acme-box port 22: No route to host\. Check the box is on/);
});

test('sshProblem covers timeouts and ordinary failures', () => {
  assert.equal(sshProblem(BOX, { timedOut: true, code: -1, stderr: '' }), 'acme-office did not answer over SSH in time.');
  assert.equal(sshProblem(BOX, { timedOut: false, code: 3, stderr: '\nno space\nmore' }), 'A command on acme-office failed (code 3): no space.');
});

test('remotePipe streams bytes from one machine to another', async () => {
  const d = tmp();
  const src = path.join(d, 'images.tar'); writeFileSync(src, Buffer.from([0, 1, 2, 255, 10, 13]));
  const dst = path.join(d, 'out.tar');
  const f = fakeSsh(d, [{ host: 'hf-build', match: '^cat ', stdoutFile: src }, { host: 'acme-box', match: '^cat > ', saveStdinTo: dst }]);
  const r = await remotePipe({ target: BUILD, command: "cat '/w/images.tar'" }, { target: BOX, command: "cat > '/opt/x.part'" }, { timeoutMs: 10000, env: f.env() });
  assert.deepEqual(r, { ok: true, why: null });
  assert.deepEqual(readFileSync(dst), readFileSync(src));
});

test('remotePipe fails when either side fails', async () => {
  const d = tmp();
  const f = fakeSsh(d, [{ host: 'hf-build', match: '^cat ', code: 1, stderr: 'No such file' }]);
  const r = await remotePipe({ target: BUILD, command: 'cat /nope' }, { target: BOX, command: 'cat > /x' }, { timeoutMs: 10000, env: f.env() });
  assert.equal(r.ok, false);
  assert.match(r.why, /the copy from the build machine stopped \(code 1\)/);
  f.setRules([{ host: 'acme-box', match: '^cat > ', code: 4 }]);
  const r2 = await remotePipe({ target: BUILD, command: 'cat /a' }, { target: BOX, command: 'cat > /x' }, { timeoutMs: 10000, env: f.env() });
  assert.match(r2.why, /the copy to acme-office stopped \(code 4\)/);
});

test('sendFile streams a local file', async () => {
  const d = tmp();
  const src = path.join(d, 'app.bundle'); writeFileSync(src, 'git bundle bytes');
  const dst = path.join(d, 'got');
  const f = fakeSsh(d, [{ match: '^cat > ', saveStdinTo: dst }]);
  assert.equal((await sendFile(src, { target: BUILD, command: 'cat > /w/app.bundle' }, { timeoutMs: 10000, env: f.env() })).ok, true);
  assert.equal(readFileSync(dst, 'utf8'), 'git bundle bytes');
});

test('missingTools names tools that are not on PATH', () => {
  assert.deepEqual(missingTools(['ssh', 'definitely-not-a-tool-xyz'], { env: fakeSsh(tmp()).env() }), ['definitely-not-a-tool-xyz']);
});
