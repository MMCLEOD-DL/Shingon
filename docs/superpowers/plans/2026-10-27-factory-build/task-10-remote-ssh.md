# Task 10: Remote scripts and SSH

All Docker work on a factory machine is a bash script that Conductor generates and sends over `ssh <user>@<host> bash -s` (Contract 3: no Docker socket locally). This task makes that safe and testable:
- `assertSafe` checks every value against a strict pattern, and `shQuote` single-quotes it, before it goes into a script (index Ruling 11, Review Focus 4);
- small script builders for the host lock, teardown and sweep;
- `createSsh`, a thin wrapper around the `ssh` and `scp` clients.

The scripts are tested by **running them locally** under `bash`, with a stub `docker` on `PATH` and a temporary work root. Nothing real is touched.

**Files:**
- Create: `src/factory/remote.js`, `src/factory/ssh.js`, `test/helpers/stubDocker.js`
- Test: `test/factory-remote.test.js`

**Interfaces:**
- Consumes: `SLUG_RE`, `RUN_ID_RE`, `COMPOSE_PROJECT_RE` (Task 1), `runCommand` (`src/exec.js`), `childEnv`, `redact` (`src/secrets.js`), `writeStubCli` (`test/helpers/stubCli.js`).
- Produces:
  - `shQuote(s) -> string`; `assertSafe(kind, value) -> value` for kinds `slug`, `runId`, `project`, `path`, `host`, `user`, `port`, `client`, `purpose`, `image`.
  - `lockScript({ root, owner })` → prints `HF-LOCKED`, or `HF-BUSY` and the holder's `owner.json`.
  - `unlockScript({ root, runId })` → `HF-UNLOCKED` | `HF-NOT-OURS` | `HF-NO-LOCK`.
  - `readLockScript({ root })` → `HF-FREE` or `HF-HELD` and the `owner.json`.
  - `teardownScript({ root, project, images = [] })` → `HF-TORN-DOWN`, or `HF-LEFTOVERS <n>`.
  - `sweepScript({ root, olderThanSec, keepRuns = [] })` (a project is kept when its name ends with `-<runId>` of a kept run) → one `HF-SWEPT <project>` line per project removed, then `HF-SWEEP-DONE`.
  - `parseMarker(stdout) -> { marker, rest }` (the last line starting `HF-`, and the text after it).
  - `ownerJson(labels) -> string` (compact JSON, key order `factory, project, run, purpose, createdAt`).
  - `createSsh({ sshBin = 'ssh', scpBin = 'scp', run = runCommand } = {}) -> { exec(machine, script, { timeoutMs = 600000 } = {}), upload(machine, localFile, remotePath, { timeoutMs = 600000 } = {}) }`; both resolve `{ code, stdout, stderr }` (stderr redacted) and never throw except on an unsafe host, user or path.
  - `test/helpers/stubDocker.js`: `stubDockerPath(dir, { ps = '', volumes = '', networks = '' } = {}) -> { binDir, logFile }`: a fake `docker` that appends its arguments to `logFile` and prints the given text for `ps`, `volume ls` and `network ls`.

- [ ] **Step 1: Write the failing tests**

Create `test/factory-remote.test.js`:

```js
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-remote.test.js`
Expected: FAIL (`Cannot find module '../src/factory/remote.js'`).

- [ ] **Step 3: Implement `test/helpers/stubDocker.js`**

`stubDockerPath` writes `<dir>/docker` (via `writeStubCli`): it appends `args.join(' ')` and a newline to `logFile`; for `ps` it prints the `ps` option, for `volume ls` the `volumes` option, for `network ls` the `networks` option; anything else prints nothing and exits 0.

- [ ] **Step 4: Implement `src/factory/remote.js`**

- `shQuote(s)`: `'` + `String(s).replaceAll("'", "'\\''")` + `'`.
- `assertSafe` patterns: `slug` `SLUG_RE`; `runId` `RUN_ID_RE`; `project` `COMPOSE_PROJECT_RE`; `path` `^/[A-Za-z0-9/_.-]+$` with no `..` segment; `host` `^[A-Za-z0-9.-]{1,253}$`; `user` `^[a-z_][a-z0-9_-]{0,31}$`; `port` an integer 1–65535; `client` a string of 1–80 characters with no control characters; `purpose` one of `preview`, `council`, `smoke`; `image` `^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9._-]+$`. Failure: `throw new Error(\`unsafe ${kind} for a remote command: ${JSON.stringify(value)}\`)`.
- Every script starts `set -euo pipefail` and `ROOT=<shQuote(root)>`, and every interpolated value goes through `assertSafe` then `shQuote`.
  - `lockScript`: `mkdir -p "$ROOT/runs"`; `if mkdir "$ROOT/lock" 2>/dev/null; then printf %s <quoted base64 of owner> | base64 -d > "$ROOT/lock/owner.json"; echo HF-LOCKED; else echo HF-BUSY; cat "$ROOT/lock/owner.json" 2>/dev/null || true; fi`. (`mkdir` is atomic, so two Conductors racing cannot both win.)
  - `unlockScript`: removes `$ROOT/lock` only when `owner.json` contains `"run":"<runId>"` (`grep -qF`).
  - `teardownScript`: as below; every Docker call is best-effort (`|| true`), then the script counts what is left and prints the marker.
    ```bash
    DIR="$ROOT/runs/$P"
    if [ -f "$DIR/bundle/compose.yaml" ]; then (cd "$DIR/bundle" && docker compose -p "$P" --profile tools --profile tunnel down -v --remove-orphans) || true; fi
    docker ps -aq --filter "label=com.docker.compose.project=$P" | xargs -r docker rm -f >/dev/null 2>&1 || true
    docker volume ls -q --filter "label=com.docker.compose.project=$P" | xargs -r docker volume rm >/dev/null 2>&1 || true
    docker network ls -q --filter "label=com.docker.compose.project=$P" | xargs -r docker network rm >/dev/null 2>&1 || true
    for img in <images>; do docker rmi "$img" >/dev/null 2>&1 || true; done
    rm -rf "$DIR"
    left=$(docker ps -aq --filter "label=com.docker.compose.project=$P" | wc -l | tr -d ' ')
    if [ "$left" = 0 ]; then echo HF-TORN-DOWN; else echo "HF-LEFTOVERS $left"; fi
    ```
  - `sweepScript`: candidate projects are the names under `$ROOT/runs` plus `docker ps -a --format '{{.Label "com.docker.compose.project"}}' | sort -u`; only names matching `^hf-[a-z0-9-]+-[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$` and not ending in `-<runId>` for a run in `keepRuns` (each run id passes `assertSafe('runId', …)`) are considered. Age is `now - stat -c %Y "$ROOT/runs/<p>"`; a project with containers but no folder counts as old. Old ones (`age >= olderThanSec`) are torn down with the same commands as `teardownScript` (a shell function in the script) and printed as `HF-SWEPT <p>`. Ends with `HF-SWEEP-DONE`.
- `parseMarker`: the last line starting `HF-` is the marker's first word; `rest` is everything after that word on that line plus the following lines, trimmed.

- [ ] **Step 5: Implement `src/factory/ssh.js`**

- Options, in this order: `-o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=30 -o IdentitiesOnly=yes -i <keyPath> -o StrictHostKeyChecking=<hostKeyPolicy>`, then `-o UserKnownHostsFile=<knownHostsFile>` when set. `hostKeyPolicy` must be `yes` or `accept-new`.
- `exec`: `run({ cmd: sshBin, args: [...opts, '<user>@<host>', 'bash -s'], input: script, timeoutMs, env: childEnv() })`.
- `upload`: `run({ cmd: scpBin, args: ['-B', '-q', ...opts, localFile, '<user>@<host>:<remotePath>'], timeoutMs, env: childEnv() })`; `remotePath` passes `assertSafe('path', …)`.
- Both validate `host` and `user` with `assertSafe` first, and return `{ code, stdout, stderr: redact(stderr) }`.
- `export const unreachable = (r) => r.code === 255;` (ssh's own failure code).

- [ ] **Step 6: Run the tests**

Run: `node --test test/factory-remote.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/factory/remote.js src/factory/ssh.js test/helpers/stubDocker.js test/factory-remote.test.js
git commit -m "feat(factory): safe remote scripts for locks, teardown and sweep, and an ssh wrapper"
```
