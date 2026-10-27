# Task 10: `conductor ship`, `updateDeployment`, and the factory config sections

This task joins the pieces into `conductor ship <project> --to <deployment>` (Contract 5): one lock per deployment, every refusal before anything is touched, all questions before the long build, then find or cut the release, build, deliver, and either the first-time setup or a safe update. It writes a plain-text ship log per run with every line redacted.

It also builds the two seams other plans use (Contract 7):
- **`updateDeployment({ projectDir, name, version, foundation, runId })`** (§7.6): the safe update of an existing deployment to an existing release. It shares the build → deliver → `runLaterShip` path with `shipProject` (one internal function, no copy). Plan 11 calls only this.
- **The `alerts` and `ship` sections of `factoryConfig`** (§7.2), in Plan 7's `src/factory/config.js`. The foundation repo comes from `factory.foundation.repo` (Plan 8's section); Plan 10 has no `foundationDir` and no settings reader of its own.

The command is wired through Plan 7's dispatch (§7.3): a parser case in `src/cli/args.js` and handlers in the `FACTORY_COMMANDS` table of `src/cli/factory.js`. `main.js` is not edited; Plan 7 already runs factory commands before the git-repo check, and `loadConfig` already keeps `factory`.

**Files:**
- Create: `src/factory/ship/index.js`, `src/cli/factoryShip.js`
- Modify: `src/factory/config.js` (add `alerts`, `ship`), `src/cli/args.js` (parser cases), `src/cli/factory.js` (two `FACTORY_COMMANDS` entries), `test/helpers/shipProject.js` (add `shipRules`, `releaseNext`)
- Test: `test/factory-ship.test.js`, `test/factory-config.test.js` (append), `test/cli.test.js` (append), `test/cli-e2e.test.js` (append)

**Interfaces:**
- Consumes: Tasks 1–9 and 13; Plan 7: `readProject`, `validateSlug` (`src/factory/projects.js`), `loadBrief` (`src/factory/brief.js`), `factoryConfig` (`src/factory/config.js`), `FACTORY_COMMANDS` (`src/cli/factory.js`); Plan 8: `getMachineProvider(factory)` (`src/factory/machines/index.js`), `newRunId`, `RUN_ID_RE` (`src/factory/ids.js`); `killAllChildren` (`src/exec.js`); `findConfig` (`src/cli/config.js`), `loadConfig` (`src/config.js`).
- Produces: `shipProject`, `updateDeployment`, `interruptShip`, `UPDATE_OUTCOMES`, `NO_TTY_FIRST`, the `parseCli` shapes and the `FACTORY_COMMANDS` entries (index, Task 10), and the config sections:

```js
// src/factory/config.js — factoryConfig(config, { env, home }) gains (Contract 7 §7.2):
alerts: { matrix: null | { homeserver, roomId } }                     // default { matrix: null }
ship: { updateTimeoutMs: 2700000, pollMs: 5000, startTimeoutMs: 300000, buildTimeoutMs: 3600000 }
//   plain-English throws: 'factory.alerts.matrix.homeserver must be a web address such as https://matrix.example.org.'
//   'factory.alerts.matrix.roomId must be a Matrix room id such as !alerts:example.org.'
//   'factory.ship.<key> must be a whole number of milliseconds above 0.'   'factory.ship has an unknown setting "<key>".'

// src/factory/ship/index.js
shipProject({ factory, slug, name, ask, env, runId, sleep, state, deps = {} }) -> Promise<{ exit, text }>
//   deps = { provider = getMachineProvider(factory), loadBrief, approvedRelease } (tests inject; defaults are the real ones)
updateDeployment({ projectDir, name, version, foundation, runId },
                 { factory = <loaded from the config>, provider, env = process.env, say = () => {}, sleep, state = {} } = {})
  -> Promise<{ outcome: UpdateOutcome, message: string }>
UPDATE_OUTCOMES = ['updated', 'rolled-back', 'cancelled', 'already-on', 'busy', 'settings-error', 'urgent', 'lost-contact', 'refused']
//   Contract 4's update outcomes plus 'refused' (stopped before the box was changed; nothing recorded in history)
interruptShip(state) -> string     // for Ctrl-C handlers (shipCommand here, Plan 11's change command): records pendingCheck if updating
NO_TTY_FIRST = 'Setting up a box asks you questions (its address, passwords, and a backup password to save), and there is no terminal, so nothing was done. Run the ship in a terminal.'

// src/cli/factoryShip.js — handlers registered in FACTORY_COMMANDS (src/cli/factory.js)
shipCommand(cli, ctx) -> Promise<number>; deploymentsCommand(cli, ctx) -> Promise<number>   // Task 11 fills deploymentsCommand
//   ctx: runFactoryCommand's context { factory, env, stdin, stdout, isTTY, onSignal, exit, deps } (see index, "Still open" 1)

// test/helpers/shipProject.js additions
shipRules(dir, { version = '0.1.3', password = 'Zq3-backup-password-from-ops-init_xyz' } = {}) -> Rule[]   // build machine + box, for a whole first ship
releaseNext(p, version) -> sha        // "More work" commit (approved) + "release: v<version>" commit tagged v<version>
```

**`shipProject` order** (each refusal returns `{ exit: SHIP_EXIT.notDone, text }` with nothing changed, unless marked):

1. `validateSlug(slug)` problem → it; `name` `/^[a-z0-9][a-z0-9-]{0,39}$/` else `"<name>" is not a deployment name: use lower-case letters, digits and dashes.`; `readProject(factory.projectsRoot, slug)` throwing → its message.
2. `lockDeployment` → `null` → `Another ship to acme-office is already running.`
3. `missingTools(['ssh', 'git'])` → `Conductor needs <tool> on this machine, and it is not installed.`
4. `dep = loadDeployment(...)` (a `DeploymentError` → its message).
5. `dep?.pendingCheck` → `The last update to acme-office (0.1.4) ended without Conductor seeing the result. Run conductor deployments status first; it checks the box and clears this.`
6. `brief = await loadBrief(projectDir)`; a throw → its message.
7. First-time setup (`!dep || dep.setup.step !== 'done'`) and `!ask.isTTY` → `NO_TTY_FIRST`. **No SSH call, no machine acquired, no release cut** (Review Focus 2).
8. `rel = await approvedRelease(projectDir, { runId, env })` (Task 13: finds the release on or after `project.json.approved.sha`, or cuts the app's first one) → problem → its text. `rel.cut` → `say('Made the app\'s first release, v1.0.0.')`. With `dep.setup.step === 'done'`: version equal to `currentVersion` → `acme-office is already on 1.0.0. There is nothing new to ship.`; lower → `0.1.2 is older than what acme-office runs (0.1.3). Conductor does not ship older versions.`
9. `foundation = project.foundation.tag` must match `/^v\d+\.\d+\.\d+$/` (Contract 7 §7.5), else `The project does not record which foundation release it is built on, so it cannot be shipped. Build it first (conductor build acme).`
10. `!dep` → `askDeploymentBasics` (null → `Nothing was changed.`), `dep = newDeployment({ ...fields, name, project: slug, alerts: { matrix: null, webhook: false, heartbeat: false } })`, saved at step `new`.
11. `policyProblems(brief.policy, dep)` → each problem, joined.
12. `preflight(targetOf(dep), { bundleDir })` problems → `acme-office is not ready for a ship:\n- …`.
13. Step before `configured` → `settings = await askSettings(ask, { dep, policy: brief.policy, defaults: { matrix: factory.alerts.matrix } })` (null → `Nothing was changed on the box.`).
14. **First-time** → `built = buildOnMachine(...)` (purpose `'ship'`, `buildTimeoutMs: factory.ship.buildTimeoutMs`), arch check, `try { deliverToBox } finally { cleanupBuild(built) }`, then `runFirstSetup({ …, foundation })` (`installed` → 0, `stopped` → 1, `partway` → 2). **Later** → the shared `deliverAndUpdate` below → `exitFor(outcome)`.
15. Every path saves through `saveDeployment` and releases the lock in `finally`.

**`deliverAndUpdate({ factory, provider, projectDir, slug, dep, rel, foundation, facts, runId, say, env, sleep, state })`** (internal, used by `shipProject`'s later path and by `updateDeployment`): `buildOnMachine` problem → `{ outcome: 'refused', text }`; `built.arch !== facts.arch` → `cleanupBuild`, then `{ outcome: 'refused', text: 'The box is <arch> but the app was built for <arch>. Conductor cannot ship to this box.' }`; `try { deliverToBox } finally { cleanupBuild(built) }` (problem → `refused`); then `state.phase = 'updating'` and `runLaterShip({ dep, target, version: rel.version, foundation, imagesFile, runId, say, save, env, opts: { updateTimeoutMs, pollMs, sleep } })`.

**`updateDeployment`** — the only way Plan 11 touches a box (Contract 7 §7.6). Every refusal is `{ outcome: 'refused', message }` with nothing changed and nothing added to `history`:
0. Context defaults: `factory` = `factoryConfig(cfg, { env })` where `cfg` is `loadConfig(findConfig({ env }))`, or `{}` when no config file is found (Plan 11 normally passes its own `factory`); `provider = getMachineProvider(factory)`.
1. `name` pattern, `runId` matches `RUN_ID_RE`, `version` is plain `x.y.z`, `foundation` matches `/^v\d+\.\d+\.\d+$/` — else `refused` with a plain sentence naming the bad value.
2. `lockDeployment` → `null` → `{ outcome: 'busy', message: 'Another ship to acme-office is already running.' }`.
3. `loadDeployment`: missing → `There is no deployment called acme-office for this project.`; `setup.step !== 'done'` → `First-time setup of acme-office is not finished, so it cannot be updated. Run: conductor ship acme --to acme-office`; `pendingCheck` → the same text as `shipProject` step 5.
4. `version === dep.currentVersion` → `{ outcome: 'already-on', message: 'acme-office is already on 1.1.0. Nothing was done.' }` (no box contact; no history entry). Older → `refused` as in step 8.
5. The release: `refs/tags/v<version>` must exist in `<projectDir>/app` and be on `main` (`merge-base --is-ancestor`), and `package.json` at it must say `<version>` → else `There is no release v1.1.0 on the app's main branch, so acme-office was not updated.`
6. `missingTools(['ssh', 'git'])`, `preflight` → `refused` with the same texts as `shipProject`.
7. `deliverAndUpdate(...)` → `{ outcome, message: text }`. `say` lines go to the caller's `say` (redacted) and to the ship log, exactly as in `shipProject`.

**What the operator sees and what is logged.** `shipProject` and `updateDeployment` wrap their output: `say(t)` writes `redact(t)` to the terminal (or the caller's `say`) **and** appends it to `<projectDir>/deployments/logs/<name>-<runId>.txt` (directory made with `mkdirSync(…, { recursive: true })`, appended with `appendFileSync`); `sayOnce(t)` writes `t` to the terminal only. Start and end lines: `Shipping 1.0.0 of acme to acme-office (run 20261027-100000-a1b2).` / the outcome text.

**`state`** (passed in by the caller): `{ phase: 'checking'|'building'|'delivering'|'setting-up'|'updating'|'done', projectDir, dep, lock, version, foundation }`, kept current. **`interruptShip(state)`**: if `state.phase === 'updating'`, save `pendingCheck { since: now, version, foundation, why: 'interrupted' }` synchronously (`state` carries the `version` and `foundation` being shipped) and return `Stopped watching. The update carries on by itself on the box. Run conductor deployments status to see how it ended.`; else return `Stopped. Steps already finished on the box are recorded; run the same command to carry on.`; in both cases release the lock.

**CLI (`src/cli/args.js`, `src/cli/factory.js`, `src/cli/factoryShip.js`):**
- `args.js`: add option `to: { type: 'string' }`; `SUBCOMMANDS` gains `ship`, `deployments`. `ship` needs exactly one positional slug and `--to` → `{ command: 'ship', slug, to, flags }`, else error `ship needs a project and a deployment: conductor ship <project> --to <deployment>`. `deployments` takes `[status] [<project>]` → `{ command: 'deployments', status, slug, flags }`. USAGE gains, after the factory lines Plans 7 and 8 add:

  ```
    conductor ship <project> --to <deployment>   ship the approved release to a box (the first time, it sets the box up)
    conductor deployments [status] [<project>]   list deployments; with status, check every box over SSH
  ```
- `src/cli/factory.js`: `FACTORY_COMMANDS` gains `ship: shipCommand` and `deployments: deploymentsCommand` (this task adds a `deploymentsCommand` stub that prints `Not available yet.` and returns 64; Task 11 replaces it). Nothing else in that file or in `main.js` changes.
- `shipCommand(cli, ctx)`: `ctx.factory` is the `FactoryConfig` (Plan 7 reads the config once in `runFactoryCommand`); it creates `createAsk({ input: ctx.stdin, output: ctx.stdout, isTTY: ctx.isTTY })`, a `state`, `runId = newRunId()`, and an `onSignal` handler: `killAllChildren()`, `say(interruptShip(state))`, `exit(130)`. Then `shipProject(...)`, prints `text`, returns `exit`.

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-ship.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fakeSsh } from './helpers/fakeSsh.js';
import { scriptedAsk } from './helpers/scriptedAsk.js';
import { makeShipProject, fakeProvider, shipRules, releaseNext, TEST_BRIEF, RUN_ID } from './helpers/shipProject.js';
import { shipProject, updateDeployment, NO_TTY_FIRST } from '../src/factory/ship/index.js';
import { factoryConfig } from '../src/factory/config.js';
import { loadDeployment, saveDeployment } from '../src/factory/deployments/store.js';
import { forgetRememberedSecrets } from '../src/secrets.js';

const PW = 'Zq3-backup-password-from-ops-init_xyz';
const SECRETS = [PW, 'mailpass-9!', 'syt_matrix_token_1', 'kuma-push-token-77', 'cf-tunnel-token-value-88', 'tok_one_time_123'];
const FIRST_ANSWERS = [
  'acme-box', '', '', '', 't', 'https://staff.acme.co.uk', 'f',                                      // basics
  'smtp://u:mailpass-9!@smtp.acme.co.uk:587', 'hr@acme.co.uk', 'sftp:bk@backup.acme.co.uk:/srv/hf', true, // mail, backup
  'm', '', '', 'syt_matrix_token_1', '', 'https://kuma.example.org/api/push/kuma-push-token-77', 'cf-tunnel-token-value-88',
  'saved', true, 'jo@acme.co.uk', 'Jo Bloggs',
];
const factoryFor = (p) => {
  const f = factoryConfig({ factory: { projectsRoot: p.projectsRoot, alerts: { matrix: { homeserver: 'https://m.example.org', roomId: '!a:example.org' } } } }, { env: {}, home: p.projectsRoot });
  return { ...f, ship: { ...f.ship, pollMs: 1, startTimeoutMs: 1000, updateTimeoutMs: 5000 } };
};

function ship(p, f, answers, extra = {}) {
  const ask = extra.ask ?? scriptedAsk(answers);
  let out = '';
  ask.say = ask.sayOnce = (t) => { out += `${t}\n`; };
  const provider = extra.provider ?? fakeProvider();
  return shipProject({ factory: factoryFor(p), slug: 'acme', name: 'acme-office', ask, env: f.env(), runId: extra.runId ?? RUN_ID,
    sleep: async () => {}, state: {}, deps: { provider, loadBrief: async () => TEST_BRIEF } })
    .then((r) => ({ ...r, out, provider }));
}

test('a first ship sets the box up end to end and no secret reaches any file or command line', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  const r = await ship(p, f, FIRST_ANSWERS);
  assert.equal(r.exit, 0, r.text);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  assert.equal(dep.setup.step, 'done');
  assert.equal(dep.currentVersion, '0.1.3');
  assert.equal(dep.foundation, 'v0.1.0'); // from project.json.foundation.tag
  assert.equal(r.provider.released(), 1);
  assert.equal(r.provider.acquired()[0].purpose, 'ship');
  const files = [path.join(p.projectDir, 'deployments', 'acme-office.json'),
    ...readdirSync(path.join(p.projectDir, 'deployments', 'logs')).map((n) => path.join(p.projectDir, 'deployments', 'logs', n))];
  assert.ok(files.some((file) => file.endsWith(`acme-office-${RUN_ID}.txt`)));
  for (const file of files) for (const s of SECRETS) assert.ok(!readFileSync(file, 'utf8').includes(s), `${s} in ${file}`);
  for (const c of f.calls()) for (const s of SECRETS) assert.ok(!c.argv.join('\u0000').includes(s), `${s} in argv`);
  assert.equal(r.out.split(PW).length - 1, 1);
  assert.equal(r.out.split('tok_one_time_123').length - 1, 1);
  for (const s of SECRETS.slice(1, 5)) assert.ok(!r.out.includes(s), `${s} on screen`);
});

test('without a terminal a first ship refuses before any SSH call, machine or release', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d, { released: false });
  const f = fakeSsh(d, shipRules(d));
  const ask = scriptedAsk([]); ask.isTTY = false;
  const r = await ship(p, f, [], { ask });
  assert.deepEqual([r.exit, r.text], [1, NO_TTY_FIRST]);
  assert.equal(f.calls().length, 0);
  assert.equal(r.provider.acquired().length, 0);
  assert.equal(execFileSync('git', ['-C', p.appDir, 'tag', '--list', 'v1.0.0'], { encoding: 'utf8' }), '');
});

test('a later ship goes through the safe update', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }),
    { match: 'exit=running', stdout: 'exit=0\n[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.\n' },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'same=compose.yaml\nsame=Caddyfile\n' }]);
  const r = await ship(p, f, [], { runId: '20261027-110000-b2c3' });
  assert.equal(r.exit, 0, r.text);
  assert.match(r.text, /acme-office is now on 0\.1\.4/);
  assert.ok(f.calls().some((c) => c.command.includes('updater update --to')));
  assert.equal(loadDeployment(p.projectDir, 'acme-office').currentVersion, '0.1.4');
});

test('updateDeployment: the safe update for Plan 11, and its refusals', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  const ctx = { factory: factoryFor(p), provider: fakeProvider(), env: f.env(), sleep: async () => {} };
  const args = { projectDir: p.projectDir, name: 'acme-office', foundation: 'v0.1.1', runId: '20261027-120000-c3d4' };
  assert.deepEqual(await updateDeployment({ ...args, version: '0.1.3' }, ctx), { outcome: 'already-on', message: 'acme-office is already on 0.1.3. Nothing was done.' });
  assert.match((await updateDeployment({ ...args, version: '0.1.9' }, ctx)).message, /There is no release v0\.1\.9 on the app's main branch/);
  assert.equal((await updateDeployment({ ...args, version: '0.1.4', runId: 'change-1' }, ctx)).outcome, 'refused');
  releaseNext(p, '0.1.4');
  f.setRules([...shipRules(d, { version: '0.1.4' }),
    { match: 'exit=running', stdout: 'exit=0\n[Acme Ltd] Updated from 0.1.3 to 0.1.4. A backup (1a2b3c4d) was taken first.\n' },
    { match: 'for f in compose.yaml Caddyfile', stdout: 'same=compose.yaml\nsame=Caddyfile\n' }]);
  const r = await updateDeployment({ ...args, version: '0.1.4' }, ctx);
  assert.equal(r.outcome, 'updated', r.message);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  assert.deepEqual([dep.currentVersion, dep.foundation, dep.history.at(-1).outcome], ['0.1.4', 'v0.1.1', 'updated']);
});

test('refusals that touch nothing: already on, pending check', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  assert.equal((await ship(p, f, FIRST_ANSWERS)).exit, 0);
  const n = f.calls().length;
  const again = await ship(p, f, []);
  assert.deepEqual([again.exit, again.text], [1, 'acme-office is already on 0.1.3. There is nothing new to ship.']);
  const dep = loadDeployment(p.projectDir, 'acme-office');
  saveDeployment(p.projectDir, { ...dep, pendingCheck: { since: 't', version: '0.1.4', foundation: 'v0.1.0', why: 'lost-contact' } });
  releaseNext(p, '0.1.4');
  assert.match((await ship(p, f, [])).text, /^The last update to acme-office \(0\.1\.4\) ended without Conductor seeing the result\. Run conductor deployments status first/);
  assert.equal(f.calls().length, n);
});

test('a box of a different architecture is refused after the build, and the build machine is cleaned up', async (t) => {
  t.after(forgetRememberedSecrets);
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, [{ host: 'acme-box', match: 'uname -m', stdout: 'arch=aarch64\ndocker=yes\ncompose=yes\ndir=no\nfreekb=99999999\n' }, ...shipRules(d)]);
  const r = await ship(p, f, FIRST_ANSWERS);
  assert.equal(r.exit, 1);
  assert.equal(r.text, 'The box is aarch64 but the app was built for x86_64. Conductor cannot ship to this box.');
  assert.equal(r.provider.released(), 1);
  assert.ok(f.calls().some((c) => c.host === 'hf-build' && c.command.startsWith("docker rmi 'highland/app:0.1.3' 'highland/ops:0.1.3'")));
});
```

Append to `test/factory-config.test.js` (Plan 8 creates it):

```js
test('alerts and ship sections: defaults, overrides and plain refusals', () => {
  const f = factoryConfig({}, { env: {}, home: '/home/op' });
  assert.deepEqual(f.alerts, { matrix: null });
  assert.deepEqual(f.ship, { updateTimeoutMs: 2700000, pollMs: 5000, startTimeoutMs: 300000, buildTimeoutMs: 3600000 });
  assert.equal(factoryConfig({ factory: { alerts: { matrix: { homeserver: 'https://m.example.org', roomId: '!a:example.org' } } } }, { env: {}, home: '/h' }).alerts.matrix.roomId, '!a:example.org');
  assert.throws(() => factoryConfig({ factory: { alerts: { matrix: { homeserver: 'm.example.org', roomId: '!a:b' } } } }, { env: {}, home: '/h' }), /homeserver must be a web address/);
  assert.throws(() => factoryConfig({ factory: { ship: { pollMs: 0 } } }, { env: {}, home: '/h' }), /factory\.ship\.pollMs must be a whole number of milliseconds above 0/);
  assert.throws(() => factoryConfig({ factory: { ship: { pollMS: 5 } } }, { env: {}, home: '/h' }), /factory\.ship has an unknown setting "pollMS"/);
});
```

Append to `test/cli.test.js`:

```js
test('parseCli: ship and deployments', () => {
  assert.deepEqual(pick(parseCli(['ship', 'acme', '--to', 'acme-office'])), { command: 'ship', slug: 'acme', to: 'acme-office' });
  assert.match(parseCli(['ship', 'acme']).error, /ship needs a project and a deployment/);
  assert.deepEqual(pick(parseCli(['deployments'])), { command: 'deployments', status: false, slug: null });
  assert.deepEqual(pick(parseCli(['deployments', 'status', 'acme'])), { command: 'deployments', status: true, slug: 'acme' });
});
function pick(c) { const { flags, ...rest } = c; return rest; }
```

Append to `test/cli-e2e.test.js`:

```js
test('ship runs outside a git repository and explains a missing project', async () => {
  const dir = tmp();
  const cfg = path.join(dir, 'conductor.json');
  writeFileSync(cfg, JSON.stringify({ participants: [], factory: { projectsRoot: path.join(dir, 'projects') } }));
  const r = await spawnBin(['ship', 'acme', '--to', 'acme-office', '--config', cfg], { cwd: dir, env: process.env });
  assert.match(r.out, /acme/);              // Plan 7's readProject message names the missing project
  assert.doesNotMatch(r.out, /git repo/i);  // dispatched before the git-repo check
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-ship.test.js test/factory-config.test.js test/cli.test.js test/cli-e2e.test.js`
Expected: FAIL, modules and exports missing; `ship` is not a known command; `factoryConfig` has no `alerts`/`ship`.

- [ ] **Step 3: Add `shipRules` and `releaseNext` to `test/helpers/shipProject.js`.** `shipRules` returns, in this order: build-machine rules like Task 6's `BUILD_RULES` for `version` (with the run folder of whichever run id the provider was given, matched by a regex), except that `sha256sum` prints `'a'.repeat(64)` for **both** files; box preflight `arch=x86_64\ndocker=yes\ncompose=yes\ndir=no\nfreekb=99999999\n`; box `sha256sum …\.part$` printing the built sum (`'a'.repeat(64)`) for both files; box `ls ` listing the four bundle files; then Task 8's `BOX_RULES` (move `BOX_RULES` into this helper and import it in Task 8's test). `releaseNext(p, version)` adds a "More work" commit, sets `approved.sha` to it (`approve`), then a `release: v<version>` commit (package.json version, changelog section) tagged `v<version>`; returns the release commit's sha.

- [ ] **Step 4: Implement** the `factoryConfig` sections in `src/factory/config.js` (each section validated in its own small function next to Plan 7's and Plan 8's, unknown keys refused like theirs), then `src/factory/ship/index.js`, `src/cli/factoryShip.js`, the `args.js` cases and the two `FACTORY_COMMANDS` entries, to the rules above.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/factory-ship.test.js test/factory-config.test.js test/cli.test.js test/cli-e2e.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/config.js src/factory/ship/index.js src/cli/factoryShip.js src/cli/args.js src/cli/factory.js test/helpers/shipProject.js test/factory-ship.test.js test/factory-config.test.js test/cli.test.js test/cli-e2e.test.js test/factory-first-ship.test.js
git commit -m "feat(ship): conductor ship and updateDeployment — refusals first, questions before the build, first setup or safe update

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
