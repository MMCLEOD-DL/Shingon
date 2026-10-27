# Task 10: `conductor ship`

This task joins the pieces into `conductor ship <project> --to <deployment>` (Contract 5): one lock per deployment, every refusal before anything is touched, all questions before the long build, then build, deliver, and either the first-time setup or a safe update. It also wires the command into the CLI so it runs **outside a git repository** (factory commands work on project folders, not on the current directory), and writes a plain-text ship log per run with every line redacted.

**Files:**
- Create: `src/factory/ship/index.js`, `src/cli/factoryShip.js`
- Modify: `src/cli/args.js`, `src/cli/main.js`, `src/config.js` (only if Plan 7 has not already added `factory`), `test/helpers/shipProject.js` (add `shipRules`, `releaseNext`)
- Test: `test/factory-ship.test.js`, `test/cli.test.js` (append), `test/cli-e2e.test.js` (append)

**Interfaces:**
- Consumes: Tasks 1–9; `loadBrief(projectDir)` (Contract 2, `src/factory/brief.js`); `getMachineProvider(config)` (Contract 3, `src/factory/machines/index.js`); `killAllChildren` (`src/exec.js`); `findConfig`, `loadConfig`.
- Produces: `shipProject`, `shipCli`, the `parseCli` shapes (index, Task 10), and:

```js
// src/factory/ship/index.js
shipSettings(factory = {}) -> { projectsRoot, foundationDir, matrix: { homeserver, roomId } | null,
                                updateTimeoutMs: 2700000, pollMs: 5000, startTimeoutMs: 300000, buildTimeoutMs: 3600000 }
//   '~/' expanded with os.homedir(); numbers must be positive integers or a plain-English throw
newRunId(now = new Date()) -> 'ship-YYYYMMDD-HHMMSS'
NO_TTY_FIRST = 'Setting up a box asks you questions (its address, passwords, and a backup password to save), and there is no terminal, so nothing was done. Run the ship in a terminal.'
// test/helpers/shipProject.js additions
shipRules(dir, { version = '0.1.3', password = 'Zq3-backup-password-from-ops-init_xyz' } = {}) -> Rule[]   // build machine + box, for a whole first ship
releaseNext(p, version) -> sha        // new commit + tag v<version> in app/, project.json approved = it
```

**`shipProject` order** (each refusal returns `{ exit: SHIP_EXIT.notDone, text }` with nothing changed, unless marked):

1. `slug` `/^[a-z0-9][a-z0-9-]{0,63}$/`, `name` `/^[a-z0-9][a-z0-9-]{0,39}$/`; `<projectsRoot>/<slug>/project.json` must exist → else `There is no project called acme. See: conductor project list`.
2. `lockDeployment` → `null` → `Another ship to acme-office is already running.`
3. `missingTools(['ssh', 'git'])` → `Conductor needs <tool> on this machine, and it is not installed.`
4. `dep = loadDeployment(...)` (a `DeploymentError` → its message).
5. `dep?.pendingCheck` → `The last update to acme-office (0.1.4) ended without Conductor seeing the result. Run conductor deployments status first; it checks the box and clears this.`
6. `approvedRelease` problem → its text. With `dep.setup.step === 'done'`: version equal to `currentVersion` → `acme-office is already on 0.1.3. There is nothing new to ship.`; lower → `0.1.2 is older than what acme-office runs (0.1.3). Conductor does not ship older versions.`
7. `brief = await loadBrief(projectDir)`; a throw → its message.
8. First-time setup (`!dep || dep.setup.step !== 'done'`) and `!ask.isTTY` → `NO_TTY_FIRST`. **No SSH call, no machine acquired** (Review Focus 2).
9. `!dep` → `askDeploymentBasics` (null → `Nothing was changed.`), `dep = newDeployment({ ...fields, name, project: slug, alerts: { matrix: null, webhook: false, heartbeat: false } })`, saved at step `new`.
10. `policyProblems(brief.policy, dep)` → each problem, joined.
11. `preflight(targetOf(dep), { bundleDir })` problems → `acme-office is not ready for a ship:\n- …`.
12. Step before `configured` → `settings = await askSettings(ask, { dep, policy: brief.policy, defaults: { matrix: settings.matrix } })` (null → `Nothing was changed on the box.`).
13. `buildOnMachine` problem → its text. `built.arch !== facts.arch` → `cleanupBuild`, then `The box is <arch> but the app was built for <arch>. Conductor cannot ship to this box.`
14. `try { deliverToBox } finally { cleanupBuild(built) }`; problem → its text.
15. First-time → `runFirstSetup` (`installed` → 0, `stopped` → 1, `partway` → 2). Otherwise `state.phase = 'updating'` and `runLaterShip` → `exitFor(outcome)`.
16. Every path saves through `saveDeployment` and releases the lock in `finally`.

**What the operator sees and what is logged.** `shipProject` wraps the `ask` it is given: `say(t)` writes `redact(t)` to the terminal **and** appends it to `<projectDir>/deployments/logs/<name>-<runId>.txt` (created with the atomic-write helper's directory, appended with `appendFileSync`); `sayOnce(t)` writes `t` to the terminal only. Start and end lines: `Shipping 0.1.3 of acme to acme-office (run ship-20261027-100000).` / the outcome text.

**`state`** (passed in by the CLI): `{ phase: 'checking'|'building'|'delivering'|'setting-up'|'updating'|'done', projectDir, dep, lock }`, kept current, so the Ctrl-C handler can act.

**CLI (`src/cli/args.js`, `src/cli/main.js`, `src/cli/factoryShip.js`):**
- `args.js`: add option `to: { type: 'string' }`; `SUBCOMMANDS` gains `ship`, `deployments`. `ship` needs exactly one positional slug and `--to` → `{ command: 'ship', slug, to, flags }`, else error `ship needs a project and a deployment: conductor ship <project> --to <deployment>`. `deployments` takes `[status] [<project>]` → `{ command: 'deployments', status, slug, flags }`. USAGE gains, after `doctor`:

  ```
    conductor ship <project> --to <deployment>   ship the approved release to a box (the first time, it sets the box up)
    conductor deployments [status] [<project>]   list deployments; with status, check every box over SSH
  ```
- `main.js`: right after `help`/`version` and **before** the git-repo check: `if (cli.command === 'ship') return shipCli(cli, { cwd, env, stdin, stdout, isTTY, onSignal, exit });` and the same for `deployments` → `deploymentsCli` (Task 11 fills it in; this task adds a stub that prints `Not available yet.` and returns 64, replaced in Task 11).
- `shipCli`: config via `findConfig` + `loadConfig` (a missing config → `shipSettings({})`; an unreadable one → its message, exit 64); `loadBrief` and `getMachineProvider` by **dynamic import**, so a Conductor without Plans 7/8 still starts and says `conductor ship needs the brief and machine parts of the factory (Plans 7 and 8), which are not installed yet.` (exit 64). It creates `createAsk({ input: stdin, output: stdout, isTTY })`, a `state`, and an `onSignal` handler: `killAllChildren()`; if `state.phase === 'updating'`, save `pendingCheck { why: 'interrupted' }` synchronously and say `Stopped watching. The update carries on by itself on the box. Run conductor deployments status to see how it ended.`; else say `Stopped. Steps already finished on the box are recorded; run the same command to carry on.`; release the lock; `exit(130)`.
- `src/config.js`: `loadConfig` returns `factory: parsed.factory ?? {}` (skip if Plan 7 already did; keep one).

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-ship.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { scriptedAsk } from './helpers/scriptedAsk.js';
import { makeShipProject, fakeProvider, shipRules, releaseNext, TEST_BRIEF } from './helpers/shipProject.js';
import { shipProject, shipSettings, NO_TTY_FIRST } from '../src/factory/ship/index.js';
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

function ship(p, f, answers, extra = {}) {
  const ask = scriptedAsk(answers);
  let out = '';
  ask.say = ask.sayOnce = (t) => { out += `${t}\n`; };
  const provider = extra.provider ?? fakeProvider();
  const settings = { ...shipSettings({ projectsRoot: p.projectsRoot, alerts: { matrix: { homeserver: 'https://m.example.org', roomId: '!a:example.org' } } }), pollMs: 1, startTimeoutMs: 1000, updateTimeoutMs: 5000 };
  return shipProject({ projectsRoot: p.projectsRoot, slug: 'acme', name: 'acme-office', settings, ask, env: f.env(), provider,
    loadBrief: async () => TEST_BRIEF, runId: 'ship-20261027-100000', sleep: async () => {}, state: {}, ...extra })
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
  assert.equal(r.provider.released(), 1);
  // Files: the record and the log.
  const files = [path.join(p.projectDir, 'deployments', 'acme-office.json'),
    ...readdirSync(path.join(p.projectDir, 'deployments', 'logs')).map((n) => path.join(p.projectDir, 'deployments', 'logs', n))];
  for (const file of files) for (const s of SECRETS) assert.ok(!readFileSync(file, 'utf8').includes(s), `${s} in ${file}`);
  // Command lines, local and remote.
  for (const c of f.calls()) for (const s of SECRETS) assert.ok(!c.argv.join('\u0000').includes(s), `${s} in argv`);
  // The terminal: the password and the invite link exactly once, nothing else secret.
  assert.equal(r.out.split(PW).length - 1, 1);
  assert.equal(r.out.split('tok_one_time_123').length - 1, 1);
  for (const s of SECRETS.slice(1, 5)) assert.ok(!r.out.includes(s), `${s} on screen`);
});

test('without a terminal a first ship refuses before any SSH call or machine', async () => {
  const d = mkdtempSync(path.join(tmpdir(), 'ship-'));
  const p = makeShipProject(d);
  const f = fakeSsh(d, shipRules(d));
  const ask = scriptedAsk([]); ask.isTTY = false; ask.say = () => {};
  const r = await ship(p, f, [], { ask });
  assert.deepEqual([r.exit, r.text], [1, NO_TTY_FIRST]);
  assert.equal(f.calls().length, 0);
  assert.equal(r.provider.acquired().length, 0);
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
  const r = await ship(p, f, []);
  assert.equal(r.exit, 0, r.text);
  assert.match(r.text, /acme-office is now on 0\.1\.4/);
  assert.ok(f.calls().some((c) => c.command.includes('updater update --to')));
  assert.equal(loadDeployment(p.projectDir, 'acme-office').currentVersion, '0.1.4');
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
  saveDeployment(p.projectDir, { ...dep, pendingCheck: { since: 't', version: '0.1.4', why: 'lost-contact' } });
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
  assert.match(r.out, /There is no project called acme|needs the brief and machine parts of the factory/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-ship.test.js test/cli.test.js test/cli-e2e.test.js`
Expected: FAIL, modules and exports missing; `ship` is not a known command.

- [ ] **Step 3: Add `shipRules` and `releaseNext` to `test/helpers/shipProject.js`.** `shipRules` returns, in this order: build-machine rules like Task 6's `BUILD_RULES` for `version`, except that `sha256sum` prints `'a'.repeat(64)` for **both** files; box preflight `arch=x86_64\ndocker=yes\ncompose=yes\ndir=no\nfreekb=99999999\n`; box `sha256sum …\.part$` printing the built sum (`'a'.repeat(64)`) for both files; box `ls ` listing the four bundle files; then Task 8's `BOX_RULES` (move `BOX_RULES` into this helper and import it in Task 8's test).

- [ ] **Step 4: Implement `src/factory/ship/index.js`, `src/cli/factoryShip.js`, and the `args.js` / `main.js` / `config.js` changes** to the rules above.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/factory-ship.test.js test/cli.test.js test/cli-e2e.test.js && npm test`
Expected: PASS (the e2e test accepts either message, so it passes before and after Plans 7/8 are merged).

- [ ] **Step 6: Commit**

```bash
git add src/factory/ship/index.js src/cli/factoryShip.js src/cli/args.js src/cli/main.js src/config.js test/helpers/shipProject.js test/factory-ship.test.js test/cli.test.js test/cli-e2e.test.js test/factory-first-ship.test.js
git commit -m "feat(ship): conductor ship — refusals first, questions before the build, first setup or safe update"
```
