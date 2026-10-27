# Task 2: Remote runner and the fake SSH

Everything Plan 10 does on a box or a build machine goes through one small module: build a safe `ssh` command line, run a remote command (optionally feeding it standard input), stream a file from one machine to another, and turn SSH failures into plain English. The tests get a scripted fake `ssh` so no test ever opens a real connection.

Contract 7 §7.1: `src/factory/ship/remote.js` stays Plan 10's (client boxes need standard input, streaming and box-specific messages that Plan 8's `createSsh` does not offer), but it **imports `shQuote` and `assertSafe` from Plan 8's `src/factory/remote.js`** and has no quoting or validation function of its own.

**Files:**
- Create: `src/factory/ship/remote.js`, `test/helpers/fakeSsh.js`
- Modify: `src/exec.js` (add `spawnTracked`)
- Test: `test/factory-remote.test.js`, `test/exec.test.js` (append)

**Interfaces:**
- Consumes: `runCommand`, the `LIVE` set in `src/exec.js`; `strictChildEnv`, `redact`, `rememberSecret` (Task 1) from `src/secrets.js`; `findBin` from `src/council/tools.js`; `shQuote`, `assertSafe` from Plan 8's `src/factory/remote.js`; the `Machine` shape of Contract 7 §7.8 (for `targetOfMachine`).
- Produces: the Task 2 block of the index's Shared Interfaces, and the test helper:

```js
// test/helpers/fakeSsh.js
fakeSsh(dir, rules = []) -> {
  binDir,                         // holds an executable "ssh" (Node stub)
  env(base = process.env) -> env  // PATH = binDir + ':' + base.PATH
  setRules(rules) -> void
  calls() -> [{ argv: string[], user, host, command, stdin: string }]   // one per invocation, in order
}
Rule = { match: string /* RegExp source, tested against the remote command */, host?: string,
         stdout?: string, stdoutFile?: string, stderr?: string, code?: number /* default 0 */,
         saveStdinTo?: string, once?: boolean /* used up after the first match */ }
// No matching rule: exit 0 with empty output. stdin is always read to the end; it is recorded as utf8
// (first 1 MiB), and written byte-for-byte to saveStdinTo when given.
```

**Rules for `sshArgs(t, command)`** (exact order, so tests can pin it):

```js
['-o', 'BatchMode=yes', '-o', `StrictHostKeyChecking=${t.hostKeyPolicy ?? 'yes'}`, '-o', 'ConnectTimeout=15',
 '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4',
 ...(t.knownHostsFile ? ['-o', `UserKnownHostsFile=${t.knownHostsFile}`] : []),
 ...(t.port ? ['-p', String(t.port)] : []),
 ...(t.keyPath ? ['-i', t.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
 '-l', t.user, '--', t.host, command]
```

- `targetOf(dep)` = `{ host, user: ssh.user, port: ssh.port, keyPath: ssh.keyPath, knownHostsFile: null, hostKeyPolicy: 'yes', label: dep.name }`: a client box **always** uses `StrictHostKeyChecking=yes` and the operator's own `known_hosts`.
- `targetOfMachine(machine)` = `{ host: machine.host, user: machine.ssh.user, port: null, keyPath: machine.ssh.keyPath, knownHostsFile: machine.ssh.knownHostsFile, hostKeyPolicy: machine.ssh.hostKeyPolicy, label: 'the build machine (<host>)' }`: a factory machine keeps the host-key policy Plan 8's provider gave it (`'yes'` for static hosts, `'accept-new'` with a per-run known-hosts file for fresh Proxmox containers).
- `targetProblem(t)` runs `assertSafe('host', t.host)`, `assertSafe('user', t.user)`, `assertSafe('port', t.port)` when set and `assertSafe('path', …)` for `keyPath`/`knownHostsFile` when set, and also refuses a host starting with `-`, and a `hostKeyPolicy` other than `'yes'`/`'accept-new'` (missing counts as `'yes'`, so a plain `{ host, user, port, keyPath, label }` target is a strict one) (a machine from Contract 3 is not a validated record). It catches `assertSafe`'s throw and returns the plain message `Conductor will not connect to "<host>": it does not look like a host name.` (or `… user name`, `… port`, `… key file`).
- `remoteRun` refuses (without spawning) when `targetProblem` is non-null, returning `{ code: -1, unreachable: true, stderr: <problem>, … }`. It spawns `findBin('ssh')` with `strictChildEnv({ env })` plus `SSH_AUTH_SOCK` copied back if present (the agent socket is not secret, and strict env would keep it anyway because its name is not secret-looking; copy explicitly so a future change to the strict filter cannot break agent auth). `unreachable` is `code === 255 || timedOut` (OpenSSH uses 255 for its own failures).
- `remotePipe(from, to)` spawns both with `spawnTracked`, pipes `from.stdout` into `to.stdin`, ends `to.stdin` when `from` ends, and resolves `{ ok: true }` only when both exit 0. Any other result kills the other side and gives `why`: `the copy from <from.label> stopped (code N)` / `the copy to <to.label> stopped (code N)` / `the copy took longer than <minutes> minutes`.
- `sendFile(localPath, to)` is the same with `createReadStream(localPath)` as the source.
- `sshProblem(t, r)`: timed out → `<label> did not answer over SSH in time.`; 255 → `Could not reach <label> over SSH: <first stderr line, redacted, at most 160 characters>. Check the box is on, the SSH key is authorised and its host key is in ~/.ssh/known_hosts (see README, "Shipping client apps").`; otherwise `A command on <label> failed (code N): <first stderr line, redacted>.`
- Quoting: every value put into a remote command anywhere in Plan 10 goes through Plan 8's `shQuote` (single quotes, `'` → `'\''`). Plan 10 has no `shq`.

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-remote.test.js
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

test('remoteRun sends stdin, records the command, and reports ssh failures plainly', async () => {
  const f = fakeSsh(tmp(), [{ match: '^cat > /x$', code: 0 }, { match: '^boom$', code: 255, stderr: 'ssh: connect to host acme-box port 22: No route to host\n' }]);
  const ok = await remoteRun(BOX, 'cat > /x', { input: 'SMTP_URL=smtp://u:p@h\n', env: f.env() });
  assert.equal(ok.code, 0);
  assert.deepEqual(f.calls()[0].argv.slice(-3), ['--', 'acme-box', 'cat > /x']);
  assert.equal(f.calls()[0].stdin, 'SMTP_URL=smtp://u:p@h\n');
  const bad = await remoteRun(BOX, 'boom', { env: f.env() });
  assert.equal(bad.unreachable, true);
  assert.match(sshProblem(BOX, bad), /^Could not reach acme-office over SSH: ssh: connect to host acme-box port 22: No route to host\. Check the box is on/);
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
```

Append to `test/exec.test.js`:

```js
import { spawnTracked, killAllChildren } from '../src/exec.js';

test('spawnTracked children are killed by killAllChildren', async () => {
  const child = spawnTracked(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {});
  const closed = new Promise((r) => child.on('close', (code, signal) => r(signal)));
  killAllChildren();
  assert.equal(await closed, 'SIGKILL');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-remote.test.js test/exec.test.js`
Expected: FAIL, missing modules / exports.

- [ ] **Step 3: Implement `test/helpers/fakeSsh.js`**

Use `writeStubCli(binDir, 'ssh', body)` from `test/helpers/stubCli.js`. The body: find `--` in `args`; `host = args[i+1]`, `command = args[i+2]`, `user = args[args.indexOf('-l') + 1]`; read `rules.json` and `used.json` from the helper's directory (absolute paths baked into the stub); read stdin fully as a Buffer; append `{ argv: args, user, host, command, stdin: buf.subarray(0, 1048576).toString('utf8') }` as one line to `calls.jsonl`; pick the first rule (not used, if `once`) whose `host` matches (when given) and `new RegExp(match).test(command)`; write `saveStdinTo`; write `stdout` or pipe `stdoutFile`; write `stderr`; exit `code ?? 0`.

- [ ] **Step 4: Implement `spawnTracked` in `src/exec.js` and `src/factory/ship/remote.js`**

`spawnTracked(cmd, args, opts)` is `spawn(cmd, args, { ...opts, detached: true })`, added to `LIVE`, removed on `'close'` and `'error'`. Implement `remote.js` to the rules above. `missingTools` uses `findBin(name, { env })`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/factory-remote.test.js test/exec.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/exec.js src/factory/ship/remote.js test/helpers/fakeSsh.js test/factory-remote.test.js test/exec.test.js
git commit -m "feat(ship): SSH runner with safe arguments, streaming copies and a scripted fake ssh

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
