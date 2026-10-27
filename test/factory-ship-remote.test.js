import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, readlinkSync } from 'node:fs';
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

// ---- Final-wave fixes (item 12): the kill and timeout paths of remotePipe and sendFile ----

// A stand-in ssh that records its pid, then exits with exits[host] after half a second (so the other side has started),
// or hangs without reading stdin.
async function hangingSsh(d, exits = {}) {
  const { writeStubCli } = await import('./helpers/stubCli.js');
  const pids = path.join(d, 'pids.txt');
  const binDir = path.join(d, 'hang-bin');
  writeStubCli(binDir, 'ssh', `
const fs = require('node:fs');
const host = args[args.indexOf('--') + 1];
fs.appendFileSync(${JSON.stringify(pids)}, process.pid + '\\n');
const exits = ${JSON.stringify(exits)};
if (host in exits) setTimeout(() => process.exit(exits[host]), 500);
setInterval(() => {}, 1000);
`);
  return {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    pids: () => (existsSync(pids) ? readFileSync(pids, 'utf8').split('\n').filter(Boolean).map(Number) : []),
  };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function allGone(pids) {
  for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 20));
  return !pids.some(alive);
}
const openFds = (file) => readdirSync('/proc/self/fd').filter((fd) => { try { return readlinkSync(`/proc/self/fd/${fd}`) === file; } catch { return false; } });

test('remotePipe kills the sending side when the receiving side fails', async () => {
  const d = tmp();
  const s = await hangingSsh(d, { 'acme-box': 4 });
  const r = await remotePipe({ target: BUILD, command: 'cat /a' }, { target: BOX, command: 'cat > /x' }, { timeoutMs: 10000, env: s.env });
  assert.deepEqual(r, { ok: false, why: 'the copy to acme-office stopped (code 4)' });
  assert.equal(s.pids().length, 2);
  assert.ok(await allGone(s.pids()), 'no ssh is left running');
});

test('remotePipe and sendFile give up after the time limit and kill both sides', async () => {
  const d = tmp();
  const s = await hangingSsh(d);
  const r = await remotePipe({ target: BUILD, command: 'cat /a' }, { target: BOX, command: 'cat > /x' }, { timeoutMs: 300, env: s.env });
  assert.equal(r.ok, false);
  assert.match(r.why, /^the copy took longer than/);
  assert.ok(await allGone(s.pids()), 'no ssh is left running');
  // A file bigger than a pipe's buffer: the receiver never reads it, so the copy stalls with the file still open.
  const src = path.join(d, 'images.tar'); writeFileSync(src, Buffer.alloc(4 * 1024 * 1024));
  const r2 = await sendFile(src, { target: BOX, command: 'cat > /x' }, { timeoutMs: 300, env: s.env });
  assert.equal(r2.ok, false);
  assert.match(r2.why, /took longer than/);
  assert.ok(await allGone(s.pids()), 'no ssh is left running');
  for (let i = 0; i < 50 && openFds(src).length; i++) await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(openFds(src), [], 'the local file is closed');
});

test('sshProblem strips terminal control sequences from what ssh printed (one shared box-text helper)', async () => {
  const msg = sshProblem(BOX, { timedOut: false, code: 255, stderr: '\x1b]0;evil\x07\x1b[31mPermission denied (publickey).\x1b[0m\n' });
  assert.equal(msg, 'Could not reach acme-office over SSH: Permission denied (publickey). Check the box is on, the SSH key is authorised and its host key is in ~/.ssh/known_hosts (see README, "Shipping client apps").');
  const { clean, firstLine, lastLine } = await import('../src/factory/ship/boxText.js');
  assert.equal(clean('a\x1b[2Jb\x07c'), 'abc');
  assert.equal(clean('abcdef', 3), 'abc');
  assert.equal(firstLine('\n  \x1b[0m\n  first line.  \nsecond'), 'first line');
  assert.equal(lastLine('one\ntwo...\n\n'), 'two');
  assert.equal(firstLine('x'.repeat(300)).length, 160);
});
