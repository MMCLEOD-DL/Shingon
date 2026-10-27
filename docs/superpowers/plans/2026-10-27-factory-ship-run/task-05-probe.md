# Task 5: Preflight and box probe

Two read-only looks at a box over SSH:

- **`preflight`**, before a ship touches anything: is Docker there and usable by this user, is the Compose plugin there, are `setsid`, `sha256sum`, `tar` and `awk` there, what architecture is it, is the bundle folder there and writable, does it already hold a `.env` or `compose.yaml`, and is there room.
- **`probeBox`**, for `deployments status` and for verifying a ship: what the app reports through `/api/version` and `/readyz` (asked **on the box**, with the box's own health token, Ruling 5), what `ops check` says, and when the last backup and restore test ran and whether they worked.

**Files:**
- Create: `src/factory/ship/probe.js`
- Test: `test/factory-probe.test.js`

**Interfaces:**
- Consumes: `remoteRun`, `sshProblem` (Task 2); `shQuote` (Plan 8's `src/factory/remote.js`); `redact`.
- Produces: `composeCmd`, `preflight`, `probeBox`, `BoxStatus`, `VERSION_PROBE`, `RUNS_SQL` (index, Task 5), and `probeVersion(t, dep, { env }) -> Promise<{ unreachable, version: { app, foundation, commit } | null, problem: string|null }>` (just the version probe; `probeBox` uses it, Task 8 polls it).

**`composeCmd(dep, args)`** = `cd <shQuote(bundleDir)> && docker compose <args>`, with `DOCKER_CONFIG="$PWD/.docker" ` before `docker` when `dep.imageDelivery === 'registry'` (runbook: host-side commands that may fetch registry images need it). The tunnel profile comes from `COMPOSE_PROFILES=tunnel` in `.env` (Task 7), so no `--profile` flag is needed anywhere.

**Preflight script** (one `remoteRun`; it prints `key=value` lines; Conductor parses them, unknown lines ignored):

```sh
d=<shQuote(bundleDir)>
echo "arch=$(uname -m)"
if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then echo docker=yes; else echo docker=no; fi
if docker compose version >/dev/null 2>&1; then echo compose=yes; else echo compose=no; fi
for t in setsid sha256sum tar awk mktemp; do command -v "$t" >/dev/null 2>&1 || echo "missing=$t"; done
if [ -d "$d" ]; then echo dir=yes; if [ -w "$d" ]; then echo writable=yes; else echo writable=no; fi; else echo dir=no; fi
[ -f "$d/.env" ] && echo env=yes
[ -f "$d/compose.yaml" ] && echo composefile=yes
p="$d"; while [ ! -d "$p" ]; do p=$(dirname "$p"); done
echo "freekb=$(df -Pk "$p" | awk 'NR==2{print $4}')"
```

Problems (plain English, `label` = deployment name): `docker=no` → `Docker is not working on acme-office for the user highland. Install Docker Engine, and add highland to the docker group.`; `compose=no` → `The Docker Compose plugin is missing on acme-office.`; each `missing=` → `<tool> is missing on acme-office.`; `dir=yes` with `writable=no` → `The bundle folder /opt/highland/acme on acme-office is not writable by highland.`; `freekb` below 4194304 → `acme-office has only 2.1 GB free where the bundle folder lives; a ship needs at least 4 GB.`; SSH failure → `[sshProblem(...)]` and nothing else. `facts = { arch, freeKb, hasDir, hasEnv, hasCompose }`. Architecture is compared with the build machine's later (Task 10), not here.

**Version probe** (sent on stdin to `composeCmd(dep, 'run --rm --no-deps -T --entrypoint node ops --input-type=module -')`):

```js
export const VERSION_PROBE = `
const base = process.env.APP_INTERNAL_URL || 'http://app:3000';
const headers = { 'x-health-token': process.env.HEALTH_TOKEN || '' };
const get = async (p) => { try { const r = await fetch(base + p, { headers, signal: AbortSignal.timeout(5000) }); return await r.json(); } catch { return null; } };
console.log(JSON.stringify({ version: await get('/api/version'), ready: await get('/readyz') }));
`;
```

The token is read inside the ops container from its own environment, so it is never in any command line, never on Conductor's side, never printed: the script prints only the two responses (`/api/version` returns `{ app, foundation, commit }` to a token holder; `/readyz` returns `{ status, checks }`).

**Backup and restore-test runs** (`composeCmd(dep, 'exec -T db psql -U app -d app -At -c ' + shQuote(RUNS_SQL))`):

```js
export const RUNS_SQL = `select json_build_object(
 'backup', (select json_build_object('at', at, 'ok', ok, 'detail', detail) from ops_runs where kind = 'backup' and not busy order by at desc, id desc limit 1),
 'backupOk', (select at from ops_runs where kind = 'backup' and ok order by at desc, id desc limit 1),
 'restore', (select json_build_object('at', at, 'ok', ok, 'detail', detail) from ops_runs where kind = 'restore-test' and not busy order by at desc, id desc limit 1),
 'restoreOk', (select at from ops_runs where kind = 'restore-test' and ok order by at desc, id desc limit 1))`;
```

(`ops_runs(kind, ok, busy, at, detail)` is the foundation's ops log, the same table its `/readyz` reads. Read-only. Foundation v0.2.0 adds `ops status --json` (Contract 7 §7.9, Plan 12 milestone 1); this query stays, pinned by these fixtures, until apps are on v0.2.0.)

**`probeBox` order:** version probe, then `composeCmd(dep, 'run --rm -T ops check')`, then the runs query. If the first call is `unreachable`, stop and return `{ reachable: false, problem: sshProblem(...) }`. Each later part fails on its own into a `notes` line and leaves its field `null`:
- version probe non-zero or no JSON line → `The app's version could not be read on the box (the ops container did not run: <first stderr line, redacted>).`
- `version` present but no `foundation` field → keep `app`, set `foundation: null`, note `The box did not give its full version details, so HEALTH_TOKEN may be missing for ops (see RUNBOOK.md, "The app reports a problem, but ops cannot see which").`

**The box's `foundation` field is shown, never trusted for security fixes.** With foundation v0.1.0, an app's own `npm run release` rewrites `foundation.json`'s version to the app's version (the bug Contract 7 §7.9 item 1 fixes in v0.2.0), so `/api/version` can claim a foundation the app is not built on. Which foundation a deployment runs is recorded by Conductor at each install or update (`dep.foundation`, from the release's `project.json.foundation.tag`, Tasks 8–10), and Task 11 reads that.
- `ops check` exit 0/1 → `{ ok: code === 0, failing: lines starting '✗ ' with the mark removed }`; any other code → note `The box's own checks could not run (code N).`
- runs query fails → note `The backup records could not be read (the database may be down).`

Every string kept from the box goes through `redact`.

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-probe.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { composeCmd, preflight, probeBox, VERSION_PROBE } from '../src/factory/ship/probe.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'probe-'));
const T = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
const DEP = { bundleDir: '/opt/highland/acme', imageDelivery: 'tar' };
const VERSION_OK = JSON.stringify({ version: { app: '0.1.3', foundation: '0.1.0', commit: 'abc1234' }, ready: { status: 'ok', checks: [] } });
const RUNS_OK = JSON.stringify({ backup: { at: '2026-10-27T02:31:00+00:00', ok: true, detail: 'Backup 1a2b3c4d saved' }, backupOk: '2026-10-27T02:31:00+00:00',
  restore: { at: '2026-10-26T04:32:00+00:00', ok: false, detail: 'The newest backup is 40 hours old' }, restoreOk: '2026-10-19T04:31:00+00:00' });

test('composeCmd adds the registry sign-in folder only for registry boxes', () => {
  assert.equal(composeCmd(DEP, 'ps'), "cd '/opt/highland/acme' && docker compose ps");
  assert.equal(composeCmd({ ...DEP, imageDelivery: 'registry' }, 'ps'), `cd '/opt/highland/acme' && DOCKER_CONFIG="$PWD/.docker" docker compose ps`);
});

test('preflight explains what is missing on the box', async () => {
  const f = fakeSsh(tmp(), [{ match: 'uname -m', stdout: 'arch=x86_64\ndocker=no\ncompose=no\nmissing=setsid\ndir=yes\nwritable=no\nenv=yes\nfreekb=2202009\n' }]);
  const r = await preflight(T, { bundleDir: '/opt/highland/acme', env: f.env() });
  assert.equal(r.ok, false);
  assert.deepEqual(r.problems, [
    'Docker is not working on acme-office for the user highland. Install Docker Engine, and add highland to the docker group.',
    'The Docker Compose plugin is missing on acme-office.',
    'setsid is missing on acme-office.',
    'The bundle folder /opt/highland/acme on acme-office is not writable by highland.',
    'acme-office has only 2.1 GB free where the bundle folder lives; a ship needs at least 4 GB.',
  ]);
  assert.deepEqual(r.facts, { arch: 'x86_64', freeKb: 2202009, hasDir: true, hasEnv: true, hasCompose: false });
});

test('probeBox reads version, checks and backup runs; the health token never appears in any command', async () => {
  const f = fakeSsh(tmp(), [
    { match: 'entrypoint node ops', stdout: `Creating container\n${VERSION_OK}\n` },
    { match: 'run --rm -T ops check', code: 1, stdout: '✓ app\n✗ app:restore-test: The last restore test failed: The newest backup is 40 hours old\n' },
    { match: 'psql', stdout: `${RUNS_OK}\n` },
  ]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.equal(s.reachable, true);
  assert.deepEqual(s.version, { app: '0.1.3', foundation: '0.1.0', commit: 'abc1234' });
  assert.deepEqual(s.checks, { ok: false, failing: ['app:restore-test: The last restore test failed: The newest backup is 40 hours old'] });
  assert.equal(s.runs.backup.last.ok, true);
  assert.equal(s.runs.restoreTest.lastOk.at, '2026-10-19T04:31:00+00:00');
  assert.deepEqual(s.notes, []);
  const calls = f.calls();
  assert.equal(calls[0].stdin, VERSION_PROBE);
  for (const c of calls) assert.doesNotMatch(c.command, /HEALTH_TOKEN|x-health-token/);
});

test('a broken box is reported part by part, never thrown', async () => {
  const f = fakeSsh(tmp(), [
    { match: 'entrypoint node ops', code: 1, stderr: 'Error response from daemon: No such image: highland/ops:0.1.3\n' },
    { match: 'ops check', code: 1, stderr: 'No such image' , stdout: '' },
    { match: 'psql', code: 1, stderr: 'service "db" is not running' },
  ]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.equal(s.reachable, true);
  assert.equal(s.version, null);
  assert.equal(s.runs, null);
  assert.match(s.notes[0], /^The app's version could not be read on the box \(the ops container did not run: Error response from daemon: No such image/);
  assert.ok(s.notes.some((n) => /backup records could not be read/.test(n)));
});

test('no foundation version (health token missing) is a note', async () => {
  const f = fakeSsh(tmp(), [{ match: 'entrypoint node ops', stdout: JSON.stringify({ version: { app: '0.1.3' }, ready: { status: 'degraded' } }) }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS_OK }]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.deepEqual(s.version, { app: '0.1.3', foundation: null, commit: null });
  assert.ok(s.notes.some((n) => /did not give its full version details/.test(n)));
});

test('an unreachable box stops after the first call', async () => {
  const f = fakeSsh(tmp(), [{ match: '.', code: 255, stderr: 'ssh: Could not resolve hostname acme-box\n' }]);
  const s = await probeBox(T, DEP, { env: f.env() });
  assert.equal(s.reachable, false);
  assert.match(s.problem, /^Could not reach acme-office over SSH/);
  assert.equal(f.calls().length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-probe.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/factory/ship/probe.js`** to the rules above. GB figures: `freeKb / 1048576`, one decimal place. The JSON line is the last stdout line that starts with `{`; `JSON.parse` failures count as "no JSON line".

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/factory-probe.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/ship/probe.js test/factory-probe.test.js
git commit -m "feat(ship): box preflight and a status probe that keeps the health token on the box

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
