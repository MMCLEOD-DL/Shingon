# Task 11: `conductor deployments [status]`

Two views of every deployment under `projectsRoot`:

- **`conductor deployments [<project>]`** reads the records only (no network): what each runs, how it is reached, and what happened last.
- **`conductor deployments status [<project>]`** looks at each box over SSH (Task 5's probe): the version and foundation it reports, its health checks, its last backup and restore test, and the foundation security fixes it is missing (Task 4). It also **resolves a pending check** left by a lost or interrupted update (Ruling 6), and keeps each record's `lastStatus` current.

Boxes are checked one after another; a box that cannot be reached, or answers with nonsense, is reported and the next one is checked (Review Focus 5).

**Files:**
- Create: `src/factory/ship/status.js`
- Modify: `src/cli/factoryShip.js` (replace the `deploymentsCli` stub from Task 10)
- Test: `test/factory-status.test.js`

**Interfaces:**
- Consumes: `listDeployments`, `saveDeployment`, `addHistory`, `lockDeployment` (Task 1); `missingTools`, `targetOf` (Task 2); `latestFoundation`, `securityFixesSince` (Task 4); `probeBox` (Task 5); `shipSettings` (Task 10); `redact`.
- Produces: `deploymentStatus`, `statusText`, `listText` (index, Task 11), `deploymentsCli`, and `ukTime(iso) -> string` (`Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })`, e.g. `27 Oct 2026, 02:31`).

**`listText(entries)`** — one line per entry, sorted by slug then name:
- `acme/acme-office  0.1.3 on foundation v0.1.0  client box, Cloudflare tunnel  last: updated, 27 Oct 2026, 10:00`
- not finished: `acme/acme-office  first-time setup not finished (stopped after: configured)`
- pending: append `  result of the last update unknown: run conductor deployments status`
- unreadable: `bobs/shop  <problem>`
- none: `No deployments yet. Ship one with: conductor ship <project> --to <deployment>`

**`deploymentStatus(entry, { foundation, env, now })`** returns `{ slug, name, ok, lines, dep }` (`lines` are indented by `statusText`). Rules, in order:

1. `entry.problem` → `ok: false`, `[problem]`.
2. `setup.step !== 'done'` → `ok: false`, `First-time setup is not finished (stopped after: <step>). Run: conductor ship <slug> --to <name>`. **No SSH call.**
3. `probeBox(targetOf(dep), dep)`; unreachable → `ok: false`, `[problem]`, `lastStatus` saved with that problem.
4. **Version.** `Running 0.1.3 on foundation 0.1.0.`; if `version.app` ≠ `currentVersion` (and no pending check): `The box runs 0.1.4, but Conductor's record said 0.1.3. The record has been corrected.` and `currentVersion` updated. `foundation` updated to `'v' + version.foundation` when known. Each probe note is a line.
5. **Pending check.** With `pendingCheck` set: if `version` is known **and** `checks.ok` → clear it, `currentVersion = version.app`, `addHistory({ version: version.app, from: <old currentVersion>, outcome: 'confirmed', detail: 'After an update whose end Conductor did not see, the box was found running <v> and healthy.' })`, line `The last update's result is now known: the box runs 0.1.4 and is healthy. Shipping to it is allowed again.` Otherwise keep it, `ok: false`, line `The last update's result is still not clear: the box's checks do not all pass. Follow RUNBOOK.md on the box ("Recovering from a failed update"), then run this again.`
6. **Health.** `checks.ok` → `Health: every check passes.`; else `ok: false` and `Health: problems found:` followed by `  - <each failing line>`; `checks` null → `ok: false` (the probe note already explains).
7. **Backups.** `Last backup: <ukTime>, worked.` / `Last backup: <ukTime>, failed: <detail>` / `Last backup: none yet.`; the same for `Last restore test`. A failed or missing one sets `ok: false`. `runs` null → `ok: false`.
8. **Security fixes.** `foundation.ok` false → `Security fixes: could not tell (<problem>)`, `ok: false`. `version.foundation` null → `Security fixes: could not tell (the box did not give its foundation version).`, `ok: false`. `securityFixesSince` throwing → `Security fixes: could not tell (<message>)`, `ok: false`. Fixes found → `ok: false`, `Behind on foundation security fixes (the newest foundation is <latest>):`, `  - <version>: <line>` for each, then `  Bring them in with: conductor foundation-upgrade <slug> --to v<latest>, then ship.`. None → `Security fixes: up to date with foundation <latest>.`
9. `alerts.heartbeat === false` → line `Warning: there is no outside watcher (Uptime Kuma) for this box, so nobody notices if it goes off.` (does not change `ok`: the operator chose it at first ship).
10. **Save.** `lastStatus = { at: now(), app, foundation, ok, problems: <failing checks + notes, redacted> }`, through `lockDeployment` + `saveDeployment`; when the lock is held by a running ship, do not save and add `A ship to this box is running, so its record was not updated.`

**`statusText(reports)`**: for each report a header `✓ acme/acme-office` or `✗ acme/acme-office`, its lines indented two spaces, a blank line between reports; at the end `All deployments are healthy and up to date.` or `<n> of <m> deployments need attention.`

**`deploymentsCli(cli, deps)`**: settings via `shipSettings`; entries `listDeployments(projectsRoot)` filtered by `cli.slug`. Without `status`: print `listText`, exit `1` when any entry has a problem, else `0`. With `status`: `missingTools(['ssh'])` → `Conductor needs ssh on this machine, and it is not installed.` exit 1; `foundation = await latestFoundation(settings.foundationDir)` once; each entry in turn; print `statusText`; exit `0` when every report is `ok`, else `1`.

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-status.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { deploymentStatus, statusText, listText } from '../src/factory/ship/status.js';
import { newDeployment, withStep, saveDeployment, loadDeployment, listDeployments } from '../src/factory/deployments/store.js';

const CL = '## [0.1.1] - 2026-11-02\n- **[security]** Reset links could be reused. Fixed.\n\n## [0.1.0] - 2026-10-26\n- First.\n';
const FOUNDATION = { ok: true, version: '0.1.1', changelog: CL };
const RUNS = JSON.stringify({ backup: { at: '2026-10-27T02:31:00Z', ok: true, detail: 'ok' }, backupOk: '2026-10-27T02:31:00Z',
  restore: { at: '2026-10-26T04:31:00Z', ok: true, detail: 'ok' }, restoreOk: '2026-10-26T04:31:00Z' });
const version = (app, foundation) => JSON.stringify({ version: { app, foundation, commit: 'c' }, ready: { status: 'ok', checks: [] } });

function setup(rules, depPatch = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'st-'));
  const projectDir = path.join(root, 'acme'); mkdirSync(projectDir);
  const dep = { ...withStep(newDeployment({ name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
    bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
    origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: true, heartbeat: true } }), 'done', 't'),
    currentVersion: '0.1.3', foundation: 'v0.1.0', ...depPatch };
  saveDeployment(projectDir, dep);
  const f = fakeSsh(root, rules);
  return { root, projectDir, f, entry: listDeployments(root)[0] };
}
const opts = (f) => ({ foundation: FOUNDATION, env: f.env(), now: () => '2026-10-27T12:00:00.000Z' });

test('a healthy box on the newest foundation is all ticks', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3', '0.1.1') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }]);
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, true, r.lines.join('\n'));
  assert.deepEqual(r.lines, ['Running 0.1.3 on foundation 0.1.1.', 'Health: every check passes.', 'Last backup: 27 Oct 2026, 02:31, worked.',
    'Last restore test: 26 Oct 2026, 04:31, worked.', 'Security fixes: up to date with foundation 0.1.1.']);
  assert.equal(loadDeployment(s.projectDir, 'acme-office').lastStatus.ok, true);
});

test('a box behind on foundation security fixes is listed with the fixes', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3', '0.1.0') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }]);
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.ok(r.lines.includes('Behind on foundation security fixes (the newest foundation is 0.1.1):'));
  assert.ok(r.lines.includes('  - 0.1.1: Reset links could be reused. Fixed.'));
  assert.ok(r.lines.includes('  Bring them in with: conductor foundation-upgrade acme --to v0.1.1, then ship.'));
});

test('a pending check is cleared once the box is seen healthy', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.4', '0.1.1') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }],
    { pendingCheck: { since: 't', version: '0.1.4', why: 'lost-contact' } });
  const r = await deploymentStatus(s.entry, opts(s.f));
  const dep = loadDeployment(s.projectDir, 'acme-office');
  assert.equal(dep.pendingCheck, null);
  assert.equal(dep.currentVersion, '0.1.4');
  assert.equal(dep.history.at(-1).outcome, 'confirmed');
  assert.ok(r.lines.some((l) => /Shipping to it is allowed again/.test(l)));
});

test('a pending check stays while the box is unhealthy', async () => {
  const s = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3', '0.1.1') }, { match: 'ops check', code: 1, stdout: '✗ update-record: The update to 0.1.4 stopped part-way\n' }, { match: 'psql', stdout: RUNS }],
    { pendingCheck: { since: 't', version: '0.1.4', why: 'urgent' } });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.ok(loadDeployment(s.projectDir, 'acme-office').pendingCheck);
});

test('an unfinished setup is reported without contacting the box', async () => {
  const s = setup([], { setup: { step: 'configured', at: 't' } });
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.deepEqual(r.lines, ['First-time setup is not finished (stopped after: configured). Run: conductor ship acme --to acme-office']);
  assert.equal(s.f.calls().length, 0);
});

test('unreachable boxes, unreadable records and an unknown foundation all fail closed', async () => {
  const s = setup([{ match: '.', code: 255, stderr: 'ssh: connect to host acme-box port 22: Connection timed out\n' }]);
  const r = await deploymentStatus(s.entry, opts(s.f));
  assert.equal(r.ok, false);
  assert.match(r.lines[0], /^Could not reach acme-office over SSH/);
  const bad = await deploymentStatus({ slug: 'bobs', name: 'shop', deployment: null, problem: 'The deployment record x could not be read (y). Fix or remove it.' }, opts(s.f));
  assert.equal(bad.ok, false);
  const s2 = setup([{ match: 'entrypoint node ops', stdout: version('0.1.3', '0.1.0') }, { match: 'ops check', stdout: '✓ app\n' }, { match: 'psql', stdout: RUNS }]);
  const r2 = await deploymentStatus(s2.entry, { ...opts(s2.f), foundation: { ok: false, problem: 'The foundation checkout at /x could not be read' } });
  assert.equal(r2.ok, false);
  assert.ok(r2.lines.some((l) => l.startsWith('Security fixes: could not tell (The foundation checkout at /x could not be read')));
  assert.match(statusText([r, bad, r2]), /3 of 3 deployments need attention\.$/);
});

test('listText reads records only', () => {
  const s = setup([]);
  const text = listText(listDeployments(s.root));
  assert.match(text, /^acme\/acme-office +0\.1\.3 on foundation v0\.1\.0 +client box, Cloudflare tunnel/);
  assert.equal(listText([]), 'No deployments yet. Ship one with: conductor ship <project> --to <deployment>');
  assert.equal(s.f.calls().length, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-status.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/factory/ship/status.js` and replace the `deploymentsCli` stub** to the rules above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/factory-status.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/ship/status.js src/cli/factoryShip.js test/factory-status.test.js
git commit -m "feat(ship): conductor deployments [status] — versions, health, backups and missing security fixes"
```
