# Task 11: The static machine provider

The `static` provider (Contract 3, the default) hands out machines the operator already runs, CT 111 `hf-build` first. `acquire` takes the host lock (an atomic `mkdir` on the host, Task 10), so only one use runs on a host at a time. `release` runs `docker compose down -v` for the run's own Compose project (`hf-<slug>-<runId>`), removes the run's images and folder, and only then gives the lock back. `sweep` cleans up after crashes. `getMachineProvider` picks the provider from the settings.

**Files:**
- Create: `src/factory/machines/index.js`, `src/factory/machines/static.js`
- Test: `test/factory-static.test.js`

**Interfaces:**
- Consumes: Task 10 (`lockScript`, `unlockScript`, `readLockScript`, `teardownScript`, `sweepScript`, `parseMarker`, `ownerJson`, `assertSafe`, `createSsh`, `unreachable`), `composeProjectOf` (Task 1), `factoryConfig` (Task 1), `stubDockerPath` (Task 10), `runCommand`.
- Produces:
  - `getMachineProvider(factory, { ssh = createSsh({ sshBin, scpBin }), pve = null, now = () => new Date(), env = process.env } = {}) -> Provider` (Shared Interfaces)
  - `MachineError` (`extends Error`, with `code`: `busy` | `unreachable` | `cap` | `config` | `failed`; the message is the plain sentence shown to the operator)
  - `runImages(slug, runId) -> ['hf-preview/<slug>-app:<runId>', 'hf-preview/<slug>-ops:<runId>']` (Task 14 builds these tags; `release` removes them)
  - `whenText(iso) -> '14:30 27 Oct'` (UK time, `Europe/London`)
  - `provider.notes: string[]`: plain notes from the last `list()` or `sweep()` (for example an unreachable host)

- [ ] **Step 1: Write the failing tests**

Create `test/factory-static.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, mkdirSync } from 'node:fs';
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
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-static.test.js`
Expected: FAIL (`Cannot find module '../src/factory/machines/index.js'`).

- [ ] **Step 3: Implement `src/factory/machines/index.js`**

- `MachineError`, `runImages`, `whenText` (via `toLocaleString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })` reshaped to `HH:MM d Mon`).
- `getMachineProvider`: `static` → `new StaticProvider({ hosts, ssh, now })`, throwing `MachineError('config', 'No factory machines are set up. Add one under factory.machines.static.hosts in the config (for example CT 111, hf-build at 192.168.1.111).')` when the list is empty. `proxmox` → `new ProxmoxProvider(…)` (Task 13; until then throw `MachineError('config', 'The proxmox machine provider is not available yet.')`).

- [ ] **Step 4: Implement `StaticProvider` in `src/factory/machines/static.js`**

- `acquire({ purpose, projectSlug, runId })`: validate the three with `assertSafe`; `labels` as in the test (`createdAt = now().toISOString()`). For each host in order, `ssh.exec(machineFor(host, labels), lockScript({ root: host.workRoot, owner: ownerJson(labels) }))`:
  - `unreachable(r)` → remember `<name> (<host>): <last part of stderr after the final ": ">`, try the next;
  - marker `HF-LOCKED` → return the machine;
  - marker `HF-BUSY` → remember the holder (parsed `owner.json`), try the next;
  - anything else → remember `<name> gave an unexpected answer`, try the next.
  - No host: all unreachable → `MachineError('unreachable', 'Conductor could not reach <name> (<host>) over SSH: <reason>. Check the machine is on and that "ssh <user>@<host> true" works from this computer without a password.')` (one sentence per host); otherwise `MachineError('busy', 'Every factory machine is in use: <name> is running a <purpose> for <project> (since <whenText>). <stop hint>')`, where the stop hint for a preview is `Stop it with: conductor preview <project> --stop`, and for anything else `It is cleaned up when that run ends; "conductor machines sweep" clears one left over from a crash.`
- `machineFor(host, labels)`: the Machine shape in Shared Interfaces, with `ssh: { user, keyPath, knownHostsFile: null, hostKeyPolicy: 'yes' }`, `runDir: <workRoot>/runs/<composeProject>`, `previewPort: host.previewPort`, and `release`:
  1. `teardownScript({ root, project: composeProject, images: runImages(project, run) })`. Unreachable → `MachineError('unreachable', …)`. `HF-LEFTOVERS <n>` → `MachineError('failed', 'Conductor could not fully clean up <composeProject> on <name> (<n> containers left). The machine stays locked so nothing else uses it; run "conductor machines sweep", or remove them by hand.')`.
  2. `unlockScript({ root, runId: run })`. `HF-UNLOCKED`, `HF-NO-LOCK` and `HF-NOT-OURS` all end quietly (a newer holder's lock is never removed).
- `list()`: `readLockScript` per host; `HF-HELD` → a machine built from the stored labels; unreachable hosts add a note to `this.notes`.
- `sweep({ olderThanMs, keep = [] })`: per reachable host, a held lock whose `run` is not in `keep` and whose `createdAt` is at least `olderThanMs` old is released (count 1). Then `sweepScript({ root, olderThanSec: Math.floor(olderThanMs / 1000), keepRuns: [...keep, <run of a lock still held>] })` and count its `HF-SWEPT` lines. Returns the total.

- [ ] **Step 5: Run the tests**

Run: `node --test test/factory-static.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/machines/index.js src/factory/machines/static.js test/factory-static.test.js
git commit -m "feat(factory): static machine provider with host locks, teardown and sweep"
```
