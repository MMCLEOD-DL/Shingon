# Task 9: Later ships through the safe update

Once a deployment's first-time setup is `done`, every ship is the foundation's safe update: `docker compose run --rm updater update --to <v>` (with `--image-file images-<v>.tar` for tar delivery). The updater stops the app and ops, takes a pre-update backup, switches the version, migrates, waits for health and undoes everything by itself if the new version fails. Conductor's part:

- start it **detached** on the box (Ruling 6), so a dropped SSH connection or Ctrl-C cannot interrupt an update half-way;
- poll it, passing its progress lines on, until it writes its exit code;
- map the outcome to plain English (Task 3) and record it;
- after a successful update only, bring in the new bundle's `compose.yaml` and `Caddyfile` the way the runbook says ("Keeping a deployment patched", step 4): only when the box's copy is still the previous bundle's, never over a hand edit; then pull the third-party images and `up -d`;
- tidy old `images-<v>.tar` files, keeping the new and previous versions.

**Files:**
- Create: `src/factory/ship/update.js`
- Modify: `src/factory/ship/probe.js` (add `cmp` to the preflight tool list) and its test expectation if it lists tools
- Test: `test/factory-later-ship.test.js`

**Interfaces:**
- Consumes: `remoteRun`, `shq`, `sshProblem` (Task 2); `interpretUpdate` (Task 3); `composeCmd`, `probeVersion` (Task 5); `addHistory` (Task 1); `redact`.
- Produces: `startDetachedUpdate`, `pollUpdate`, `refreshBundleFiles`, `pruneImageFiles` (index, Task 9) and

```js
runLaterShip({ dep, target, version, imagesFile, runId, say, save, env, now = () => new Date().toISOString(),
               opts: { updateTimeoutMs, pollMs, sleep, clock = Date.now } }) -> Promise<{ outcome, text, dep }>
```

`runId` must match `/^[a-z0-9-]{1,40}$/` (it names files on the box). `log = .conductor/update-<runId>.log`, `exit = .conductor/update-<runId>.exit`, both relative to the bundle folder.

**Remote commands:**
- start: `cd <dir> && mkdir -p .conductor && rm -f <exit> && setsid nohup sh -c <shq(inner)> >/dev/null 2>&1 </dev/null & sleep 1; [ -f <log> ]` where `inner` = `[DOCKER_CONFIG="$PWD/.docker" ]docker compose run --rm -T updater update --to <shq(v)>[ --image-file <shq(imagesFile)>] > <log> 2>&1; echo $? > <exit>`. Non-zero → `{ ok: false, problem: 'The update could not be started on acme-office (<first stderr line, redacted>).' }`.
- poll: `cd <dir> && if [ -f <exit> ]; then echo "exit=$(cat <exit>)"; else echo exit=running; fi; cat <log> 2>/dev/null`. Each poll says (through `say`, redacted, prefixed `  box: `) only the log lines not said before. `exit=<n>` ends polling with `{ code: n, output: <log>, lostContact: false }`. SSH failures do not end polling; they are retried until `clock() - start >= updateTimeoutMs`, which ends with `{ code: null, output: <log so far>, lostContact: true }`.
- refresh (after `updated` only; `prev = dep.bundleVersion`):

  ```sh
  cd <dir>
  cp .conductor/bundle-<v>/RUNBOOK.md RUNBOOK.md; cp .conductor/bundle-<v>/.env.example .env.example
  for f in compose.yaml Caddyfile; do
    new=.conductor/bundle-<v>/$f; old=.conductor/bundle-<prev>/$f
    if cmp -s "$f" "$new"; then echo "same=$f"
    elif [ -f "$old" ] && cmp -s "$f" "$old"; then cp "$new" "$f.conductor-tmp" && mv "$f.conductor-tmp" "$f" && echo "replaced=$f"
    else echo "hand=$f"; fi
  done
  ```

  Any `replaced=` → `composeCmd(dep, 'pull db proxy' + (access === 'cloudflare-tunnel' ? ' tunnel' : ''))` then `composeCmd(dep, 'up -d')`; a failure of either is a warning `The new <files> are in place, but the box could not restart with them (<line>). On the box run: docker compose up -d`. Each `hand=` is a warning `<f> on the box was changed by hand, so Conductor left it alone. The new one is at <dir>/.conductor/bundle-<v>/<f>: merge it by hand (RUNBOOK.md, "Keeping a deployment patched").` `dep.bundleVersion = v` afterwards.
- prune (after `updated` only): `cd <dir> && for f in images-*.tar; do case "$f" in images-<shq'd new>.tar|images-<shq'd from>.tar) ;; *) rm -f -- "$f" ;; esac; done`.

**Recording** (`from = dep.currentVersion`; every outcome adds one `history` entry `{ at, version: v, from, outcome, detail: <first line of text> }` and saves):

| Outcome | Record changes |
|---|---|
| `updated` | `currentVersion = v`; `foundation` from `probeVersion` (`'v' + foundation`, unchanged when unreadable); refresh + prune; their warnings appended to the text as `Note: …` lines |
| `already-on` | `currentVersion = v` (the record was behind the box) |
| `rolled-back`, `cancelled`, `busy`, `settings-error` | none |
| `urgent` | `pendingCheck = { since: now(), version: v, why: 'urgent' }` |
| `lost-contact` | `pendingCheck = { since: now(), version: v, why: 'lost-contact' }`; text from Task 3 plus `The update carries on by itself on the box; Conductor will not ship to acme-office again until conductor deployments status has seen how it ended.` |
| start failed | outcome `cancelled`, text `<problem> Nothing was changed.` |

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-later-ship.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { runLaterShip } from '../src/factory/ship/update.js';
import { newDeployment, withStep } from '../src/factory/deployments/store.js';

const T = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
const UPDATED = '[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.';
const ROLLED = '[Acme Ltd] Update to 0.1.4 failed (the database update failed), so it was undone automatically. The app is back on 0.1.3 with its data exactly as it was before the update.';
const live = () => ({ ...withStep(newDeployment({ name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
  bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
  origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: true, heartbeat: true } }), 'done', 't'),
  currentVersion: '0.1.3', foundation: 'v0.1.0', bundleVersion: '0.1.3' });

function go(rules, { clockStep = 0, timeout = 60000 } = {}) {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'ls-')), rules);
  let t0 = 0; const said = []; const saved = [];
  return runLaterShip({ dep: live(), target: T, version: '0.1.4', imagesFile: 'images-0.1.4.tar', runId: 'ship-20261027-1000',
    say: (s) => said.push(s), save: (d) => { saved.push(d); return d; }, env: f.env(), now: () => '2026-10-27T10:00:00.000Z',
    opts: { updateTimeoutMs: timeout, pollMs: 1, sleep: async () => {}, clock: () => (t0 += clockStep) } })
    .then((r) => ({ ...r, f, said: said.join('\n'), saved }));
}

test('a good update runs detached, passes progress on, refreshes the bundle files and records the new version', async () => {
  const r = await go([
    { match: 'setsid nohup sh -c' },
    { match: 'exit=running', once: true, stdout: 'exit=running\nStopping the app and the monitor.\n' },
    { match: 'exit=running', stdout: `exit=0\nStopping the app and the monitor.\n${UPDATED}\n` },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'replaced=compose.yaml\nsame=Caddyfile\n' },
    { match: 'entrypoint node ops', stdout: JSON.stringify({ version: { app: '0.1.4', foundation: '0.1.1', commit: 'x' }, ready: {} }) },
  ]);
  assert.equal(r.outcome, 'updated', r.text);
  const cmds = r.f.calls().map((c) => c.command);
  const start = cmds.find((c) => c.includes('setsid nohup sh -c'));
  assert.ok(start.includes('updater update --to') && start.includes('images-0.1.4.tar') && start.includes('.conductor/update-ship-20261027-1000.exit'));
  assert.equal(r.said.split('box: Stopping the app and the monitor.').length - 1, 1); // each line said once
  assert.ok(cmds.some((c) => c.endsWith("docker compose pull db proxy tunnel")));
  assert.ok(cmds.some((c) => c.includes('for f in images-*.tar')));
  assert.equal(r.dep.currentVersion, '0.1.4');
  assert.equal(r.dep.foundation, 'v0.1.1');
  assert.equal(r.dep.bundleVersion, '0.1.4');
  assert.deepEqual(r.dep.history.at(-1), { at: '2026-10-27T10:00:00.000Z', version: '0.1.4', from: '0.1.3', outcome: 'updated',
    detail: 'acme-office is now on 0.1.4 (it was on 0.1.3). The box took a backup (1a2b3c4d) first.' });
});

test('a rolled-back update keeps the old version and touches no files', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: `exit=1\n${ROLLED}\n` }]);
  assert.equal(r.outcome, 'rolled-back');
  assert.equal(r.dep.currentVersion, '0.1.3');
  assert.ok(!r.f.calls().some((c) => /compose\.yaml Caddyfile|images-\*\.tar|pull db/.test(c.command)));
});

test('losing contact leaves the update running and blocks further ships until status has looked', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', code: 255, stderr: 'Connection reset\n' }], { clockStep: 20000, timeout: 60000 });
  assert.equal(r.outcome, 'lost-contact');
  assert.deepEqual(r.dep.pendingCheck, { since: '2026-10-27T10:00:00.000Z', version: '0.1.4', why: 'lost-contact' });
  assert.match(r.text, /carries on by itself on the box; Conductor will not ship to acme-office again until conductor deployments status/);
  assert.equal(r.dep.currentVersion, '0.1.3');
});

test('a hand-edited compose.yaml is left alone, with a note', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: `exit=0\n${UPDATED}\n` },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'hand=compose.yaml\nsame=Caddyfile\n' }]);
  assert.equal(r.outcome, 'updated');
  assert.match(r.text, /Note: compose\.yaml on the box was changed by hand, so Conductor left it alone\. The new one is at \/opt\/highland\/acme\/\.conductor\/bundle-0\.1\.4\/compose\.yaml/);
  assert.ok(!r.f.calls().some((c) => c.command.includes('pull db proxy')));
});

test('an update that could not start changes nothing', async () => {
  const r = await go([{ match: 'setsid', code: 1, stderr: 'setsid: command not found\n' }]);
  assert.equal(r.outcome, 'cancelled');
  assert.match(r.text, /^The update could not be started on acme-office \(setsid: command not found\)\. Nothing was changed\./);
});

test('urgent sets a pending check', async () => {
  const r = await go([{ match: 'setsid' }, { match: 'exit=running', stdout: 'exit=3\n[Acme Ltd] URGENT: update to 0.1.4 failed (x) and the automatic undo also failed (y).\n' }]);
  assert.equal(r.outcome, 'urgent');
  assert.equal(r.dep.pendingCheck.why, 'urgent');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-later-ship.test.js`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/factory/ship/update.js`** to the rules above, and add `cmp` to the preflight tool loop in `probe.js`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/factory-later-ship.test.js test/factory-probe.test.js && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/ship/update.js src/factory/ship/probe.js test/factory-later-ship.test.js
git commit -m "feat(ship): later ships run the foundation's safe update detached, with plain outcomes and bundle refresh"
```
