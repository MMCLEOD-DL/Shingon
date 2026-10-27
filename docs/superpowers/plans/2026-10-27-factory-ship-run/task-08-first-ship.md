# Task 8: First-time setup

The first ship to a deployment follows the runbook's "Setting up a new deployment", step by step, on the box, and records each finished step in the deployment record so a failure or an interrupted run carries on from where it stopped (Ruling 7). The foundation's tools do the work: `docker load`, `ops init --out`, `docker compose up -d`, `ops backup`, `ops restore-test`, `ops check`, `bootstrap-admin.js`. Conductor only fills in what `ops init`'s checklist asks the operator to fill in, and it writes those values into `.env` **through standard input**.

**Files:**
- Create: `src/factory/ship/envFile.js`, `src/factory/ship/firstShip.js`
- Test: `test/factory-env-file.test.js`, `test/factory-first-ship.test.js`

**Interfaces:**
- Consumes: `remoteRun`, `shq`, `sshProblem` (Task 2); `composeCmd`, `probeVersion`, `probeBox` (Task 5); `imageNames` (Task 6); `baseSettings`, `initArgs` (Task 7); `withStep`, `addHistory`, `SETUP_STEPS` (Task 1); `rememberSecret`, `redact`.
- Produces: `SETTABLE`, `dotenvLine`, `setEnvCommand`, `setEnv`, `readBackupPassword` (index, Task 8) and:

```js
runFirstSetup({
  dep, brief, target, ask, version,
  images,            // imageNames(...) for this version
  imagesFile,        // 'images-<v>.tar' | null (from deliverToBox)
  facts,             // preflight facts from before delivery: { hasEnv, hasCompose }
  settings,          // askSettings(...) result; required while dep.setup.step is before 'configured', else ignored
  save,              // (dep) => dep   persists through saveDeployment and returns it
  env, now = () => new Date().toISOString(),
  opts: { startTimeoutMs, pollMs, sleep },
}) -> Promise<{ outcome: 'installed'|'stopped'|'partway', text, dep }>
```

**`SETTABLE`** (Conductor may write only these; never `DB_PASSWORD`, `HEALTH_TOKEN`, `BACKUP_PASSWORD`, which `ops init` generates on the box):
`APP_TAG, APP_IMAGE, OPS_IMAGE, IMAGE_PULL_POLICY, COMPOSE_PROFILES, SMTP_URL, EMAIL_FROM, BACKUP_REPOSITORY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION, B2_ACCOUNT_ID, B2_ACCOUNT_KEY, RESTIC_REST_USERNAME, RESTIC_REST_PASSWORD, MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, MATRIX_ROOM_ID, ALERT_WEBHOOK_URL, HEARTBEAT_URL, TUNNEL_TOKEN, TUNNEL_ENABLED`.

**`dotenvLine(key, value)`** mirrors the foundation's `dotenvValue` in `ops/src/init.ts` exactly (same character class, same escaping order), so Compose reads the value back as typed:
- key not in `SETTABLE` → throw `Conductor may not set <key> on a box.`;
- `\r` or `\n` in value → throw `The value for <key> has a line break in it. Paste it again on one line.` (never quoting the value);
- `/^[A-Za-z0-9_@%+=:,./ -]*$/` and no leading/trailing space → `KEY=value`;
- otherwise `KEY="…"` with `\` → `\\`, then `"` → `\"`, then `$` → `$$`.

**`setEnvCommand(bundleDir)`** (the remote command; it holds no value):

```sh
set -eu
cd <shq(bundleDir)>
[ -f .env ] || { echo "There is no .env in this folder." >&2; exit 3; }
umask 077
tmp=$(mktemp .env.conductor.XXXXXX)
trap 'rm -f "$tmp"' EXIT
awk 'NR == FNR { k = substr($0, 1, index($0, "=") - 1); v[k] = $0; order[++n] = k; next }
{ key = $0; sub(/^# /, "", key); key = substr(key, 1, index(key, "=") - 1)
  if (key ~ /^[A-Z0-9_]+$/ && (key in v) && !(key in done)) { print v[key]; done[key] = 1; next }
  print }
END { for (i = 1; i <= n; i++) if (!(order[i] in done)) print v[order[i]] }' - .env > "$tmp"
chmod 600 "$tmp"
mv "$tmp" .env
trap - EXIT
```

It replaces the first `KEY=…` or commented `# KEY=…` line for each key (the layout `ops init` writes) and appends keys it did not find. `setEnv(t, dir, settings)` builds the stdin as `settings.map((s) => dotenvLine(s.key, s.value)).join('\n') + '\n'`, returns `{ ok: true }` at once for an empty list (an empty stdin would make `awk` treat `.env` as the first file), and on failure `{ ok: false, problem: 'The settings could not be written into .env on acme-office (<first stderr line, redacted>).' }`.

**`readBackupPassword(t, dir)`**: `sed -n 's/^BACKUP_PASSWORD=//p' <shq(dir)>/.env`; the trimmed value (unquoted if `ops init` quoted it) is passed to `rememberSecret` **before** it is returned; empty → `null`.

**`runFirstSetup` steps.** `at(step)` means `SETUP_STEPS.indexOf(dep.setup.step) < SETUP_STEPS.indexOf(step)`; each block runs only when its step is not yet reached, and ends with `dep = save(withStep(dep, step, now()))`. A failure returns `{ outcome: 'partway', text: <reason> + '\nRun the same command again to carry on from here: conductor ship <project> --to <name>', dep }` with the last finished step saved.

0. **A newer release arrived mid-setup.** If `dep.bundleVersion` is set, differs from `version`, and the step is `delivered` or later: re-run step 1's copy and image load for `version` (both are safe to repeat); if the step is `configured` or later, also `setEnv(target, dir, [{ key: 'APP_TAG', value: version }])`; if it is `started` or `verified`, set it back to `configured` so the box is started again on the new version (the box is not live yet). Then `dep.bundleVersion = version`, saved, and carry on.
1. **`delivered`**
   - If `dep.setup.step === 'new'` and (`facts.hasEnv` or `facts.hasCompose`) → `{ outcome: 'stopped', text: 'The folder /opt/highland/acme on acme-office already holds a deployment that Conductor did not set up, so nothing was changed. Choose another folder, or move that one away.' }`.
   - `cd <dir> && cp .conductor/bundle-<v>/compose.yaml .conductor/bundle-<v>/Caddyfile .conductor/bundle-<v>/.env.example .conductor/bundle-<v>/RUNBOOK.md .`
   - tar: `cd <dir> && docker load -i <imagesFile>`. Registry: `password = await ask.secret('Registry password for <user> at <host>')` (null → partway `Stopped: no registry password was given.`), then `cd <dir> && docker --config "$PWD/.docker" login <host> -u <user> --password-stdin` with the password **as stdin**, then `cd <dir> && DOCKER_CONFIG="$PWD/.docker" docker pull <opsRef>`.
   - `dep.bundleVersion = version`.
2. **`initialised`**
   - `cd <dir> && [ ! -e .env ]` must succeed, else `stopped` with the same "did not set up" text (Ruling 7: `ops init` is never run over an existing `.env`).
   - `cd <dir> && [DOCKER_CONFIG="$PWD/.docker" ]docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/out" <opsRef> <initArgs(dep, brief) each through shq>`. Non-zero → partway `ops init did not work on the box: <first stderr line, redacted>.` (its checklist on stderr is not printed: Conductor does each item itself).
3. **`password-saved`** — `!ask.isTTY` → partway `The backup password has to be shown to you once, and there is no terminal. Run the ship in a terminal.`. Otherwise `readBackupPassword`; `null` → partway `The new settings on the box have no BACKUP_PASSWORD.` Then:

   ```
   Save this backup password in your password manager now, under "Acme Ltd – acme-office backups".
   Without it the backups cannot be read, and it must not live only on the box.

       <password>

   Conductor will not show it again and keeps no copy. Clear your terminal's scrollback once it is saved.
   ```

   then `ask.text('Type saved when it is in your password manager', { check: (a) => (a === 'saved' ? null : 'Type saved, or press Ctrl-C to stop (it will be shown again next time).') })`; `null` → partway `Stopped before the backup password was confirmed.`
4. **`configured`** — `setEnv(target, dir, [...baseSettings(dep, version), ...settings.settings])`; `dep.alerts = settings.alerts`.
5. **`started`** — `composeCmd(dep, 'up -d')` (timeout 10 minutes). Non-zero → partway `The box could not start the app (<last non-empty output line, redacted>). On the box, docker compose ps and docker compose logs --tail 100 show why.`
6. **`verified`**
   - Poll `probeVersion` (one container run, not the full probe) every `pollMs` until `r.version?.app === version`, at most `startTimeoutMs` → else partway `The app did not report version <v> within <n> minutes.`
   - `composeCmd(dep, 'run --rm -T ops backup')` (60 minutes) must exit 0, else partway `The first backup did not work: <last line, redacted>. RUNBOOK.md on the box, "Backups", lists the reasons.`
   - `composeCmd(dep, 'run --rm -T ops restore-test')` (60 minutes), same rule with `The first restore test did not work: …`.
   - `probeBox`: `checks.ok` must be true, else partway `The box's checks do not all pass yet:\n- <failing…>`.
   - `dep.currentVersion = version`; `dep.foundation = status.version.foundation ? 'v' + status.version.foundation : null`.
7. **`done`**
   - `ask.confirm('Create the first admin account now?')`; yes → `text('Their email address?')` (contains `@`), `text('Their full name?')`, then `composeCmd(dep, 'run --rm -T app node apps/server/dist/auth/bootstrap-admin.js --email <q> --name <q>')`. The first `https?://\S+` in its output is passed to `rememberSecret`, then shown once: `Send this link to <name> yourself (it works for 7 days): <link>`. A failure here is a note, not a partway: `The first admin could not be created (<line>). Do it later on the box: see RUNBOOK.md, "Create the first admin".`
   - `dep = addHistory(dep, { version, outcome: 'installed', at: now() })`, step `done`, saved.
   - Text: `acme-office is running 0.1.3 on foundation 0.1.0. The first backup and a test restore both worked, and every check passes.` then `Alerts go to Matrix (<roomId>)` or `Alerts go to the webhook`, and `The outside watcher (Uptime Kuma) is set.` or `There is no outside watcher: nobody will notice if the whole box goes off.`

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-env-file.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { dotenvLine, setEnvCommand, SETTABLE } from '../src/factory/ship/envFile.js';

test('dotenvLine quotes exactly like the foundation and refuses line breaks', () => {
  assert.equal(dotenvLine('EMAIL_FROM', 'hr@acme.co.uk'), 'EMAIL_FROM=hr@acme.co.uk');
  assert.equal(dotenvLine('SMTP_URL', `smtp://u:p@ss w#rd$"\\'x@h:587`), String.raw`SMTP_URL="smtp://u:p@ss w#rd$$\"\\'x@h:587"`);
  assert.throws(() => dotenvLine('SMTP_URL', 'abc\ndef'), (e) => /line break/.test(e.message) && !e.message.includes('abc'));
  assert.throws(() => dotenvLine('DB_PASSWORD', 'x'), /may not set DB_PASSWORD/);
  assert.ok(!SETTABLE.includes('BACKUP_PASSWORD') && !SETTABLE.includes('HEALTH_TOKEN'));
});

test('the setter replaces commented and empty lines, appends the rest, keeps mode 600 (run with the local sh)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'env-'));
  const env = path.join(dir, '.env');
  writeFileSync(env, ['# The release to run.', '# APP_TAG=', 'APP_NAME="Acme Ltd"', '# Fill this in.', 'SMTP_URL=',
    '# Matrix room that gets the alerts: the server address,', '# MATRIX_HOMESERVER=', 'BACKUP_PASSWORD=abc', ''].join('\n'), { mode: 0o600 });
  const input = [dotenvLine('APP_TAG', '0.1.3'), dotenvLine('SMTP_URL', 'smtp://u:p#w@h'), dotenvLine('MATRIX_HOMESERVER', 'https://m.example.org'), dotenvLine('COMPOSE_PROFILES', 'tunnel')].join('\n') + '\n';
  const r = spawnSync('sh', ['-c', setEnvCommand(dir)], { input });
  assert.equal(r.status, 0, String(r.stderr));
  assert.equal(readFileSync(env, 'utf8'), ['# The release to run.', 'APP_TAG=0.1.3', 'APP_NAME="Acme Ltd"', '# Fill this in.', 'SMTP_URL="smtp://u:p#w@h"',
    '# Matrix room that gets the alerts: the server address,', 'MATRIX_HOMESERVER=https://m.example.org', 'BACKUP_PASSWORD=abc', 'COMPOSE_PROFILES=tunnel', ''].join('\n'));
  assert.equal(statSync(env).mode & 0o777, 0o600);
});
```

```js
// test/factory-first-ship.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeSsh } from './helpers/fakeSsh.js';
import { scriptedAsk } from './helpers/scriptedAsk.js';
import { TEST_BRIEF } from './helpers/shipProject.js';
import { runFirstSetup } from '../src/factory/ship/firstShip.js';
import { newDeployment, withStep } from '../src/factory/deployments/store.js';
import { forgetRememberedSecrets } from '../src/secrets.js';

const T = { host: 'acme-box', user: 'highland', port: null, keyPath: null, label: 'acme-office' };
const PW = 'Zq3-backup-password-from-ops-init_xyz';
const SETTINGS = { settings: [{ key: 'SMTP_URL', value: 'smtp://u:mailpass@h:587', secret: true }, { key: 'MATRIX_ACCESS_TOKEN', value: 'syt_matrix_token_1', secret: true }],
  alerts: { matrix: { homeserver: 'https://m.example.org', roomId: '!a:example.org' }, webhook: false, heartbeat: true } };
const VERSION = JSON.stringify({ version: { app: '0.1.3', foundation: '0.1.0', commit: 'abc' }, ready: { status: 'ok', checks: [] } });
const BOX_RULES = [
  { match: "\\[ ! -e \\.env \\]" },
  { match: 'docker run --rm -u', stderr: 'Setting up Acme Ltd. Do these before you start the box:\n' },
  { match: "sed -n 's/\\^BACKUP_PASSWORD=//p'", stdout: `${PW}\n` },
  { match: 'entrypoint node ops', stdout: VERSION },
  { match: 'ops check', stdout: '✓ app\n✓ app:backups\n✓ app:restore-test\n' },
  { match: 'psql', stdout: '{}' },
  { match: 'bootstrap-admin', stdout: 'Send this link: https://staff.acme.co.uk/invite/tok_one_time_123\n' },
];
const dep0 = () => newDeployment({ name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
  bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
  origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: false, heartbeat: false } });

function run(f, dep, answers, extra = {}) {
  const ask = scriptedAsk(answers);
  const said = [];
  ask.say = (t) => said.push(t);
  ask.sayOnce = (t) => said.push(t);
  const saved = [];
  return runFirstSetup({ dep, brief: TEST_BRIEF, target: T, ask, version: '0.1.3',
    images: { app: 'highland/app', ops: 'highland/ops', appRef: 'highland/app:0.1.3', opsRef: 'highland/ops:0.1.3' },
    imagesFile: 'images-0.1.3.tar', facts: { hasEnv: false, hasCompose: false }, settings: SETTINGS,
    save: (d) => { saved.push(d); return d; }, env: f.env(), now: () => '2026-10-27T10:00:00.000Z',
    opts: { startTimeoutMs: 1000, pollMs: 1, sleep: async () => {} }, ...extra })
    .then((r) => ({ ...r, said: said.join('\n'), saved, ask }));
}

test('a full first ship follows the runbook order and shows the backup password exactly once', async (t) => {
  t.after(forgetRememberedSecrets);
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, dep0(), ['saved', true, 'jo@acme.co.uk', 'Jo Bloggs']);
  assert.equal(r.outcome, 'installed', r.text);
  const cmds = f.calls().map((c) => c.command);
  const order = ['cp .conductor/bundle-0.1.3/compose.yaml', 'docker load -i', "[ ! -e .env ]", 'init', "BACKUP_PASSWORD=//p", 'mktemp .env.conductor', 'up -d', 'entrypoint node ops', 'ops backup', 'ops restore-test', 'ops check', 'bootstrap-admin'];
  let last = -1;
  for (const o of order) { const i = cmds.findIndex((c, k) => k > last && c.includes(o)); assert.ok(i > last, `missing or out of order: ${o}`); last = i; }
  assert.equal(r.said.split(PW).length - 1, 1);
  assert.match(r.said, /Send this link to Jo Bloggs yourself \(it works for 7 days\): https:\/\/staff\.acme\.co\.uk\/invite\/tok_one_time_123/);
  for (const c of f.calls()) for (const s of [PW, 'mailpass', 'syt_matrix_token_1']) assert.ok(!c.command.includes(s) && !c.argv.join(' ').includes(s), `secret in argv: ${c.command}`);
  assert.match(f.calls().find((c) => c.command.includes('mktemp .env.conductor')).stdin, /^APP_TAG=0\.1\.3\nCOMPOSE_PROFILES=tunnel\nTUNNEL_ENABLED=true\nSMTP_URL=smtp:\/\/u:mailpass@h:587\nMATRIX_ACCESS_TOKEN=syt_matrix_token_1\n$/);
  assert.deepEqual(r.saved.map((d) => d.setup.step), ['delivered', 'initialised', 'password-saved', 'configured', 'started', 'verified', 'done']);
  assert.equal(r.dep.currentVersion, '0.1.3');
  assert.equal(r.dep.foundation, 'v0.1.0');
  assert.deepEqual(r.dep.history.map((h) => h.outcome), ['installed']);
  for (const d of r.saved) assert.ok(!JSON.stringify(d).includes(PW));
});

test('resuming after the password was shown but not confirmed never re-runs ops init', async (t) => {
  t.after(forgetRememberedSecrets);
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, withStep(dep0(), 'initialised', 'x'), ['saved', false]);
  assert.equal(r.outcome, 'installed', r.text);
  assert.ok(!f.calls().some((c) => c.command.includes('docker run --rm -u')));
  assert.ok(r.said.includes(PW));
});

test('once the password is confirmed it is never read again', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, withStep(dep0(), 'password-saved', 'x'), [false]);
  assert.equal(r.outcome, 'installed', r.text);
  assert.ok(!f.calls().some((c) => c.command.includes('BACKUP_PASSWORD')));
});

test('a newer release arriving mid-setup reloads the images and moves APP_TAG on', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, { ...withStep(dep0(), 'started', 'x'), bundleVersion: '0.1.2' }, [false]);
  assert.equal(r.outcome, 'installed', r.text);
  const cmds = f.calls().map((c) => c.command);
  assert.ok(cmds.some((c) => c.includes('docker load -i')));
  assert.ok(cmds.some((c) => c.endsWith('docker compose up -d')));
  assert.equal(f.calls().find((c) => c.command.includes('mktemp .env.conductor')).stdin, 'APP_TAG=0.1.3\n');
});

test('a folder that already holds a deployment is left alone', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const r = await run(f, dep0(), [], { facts: { hasEnv: true, hasCompose: true } });
  assert.equal(r.outcome, 'stopped');
  assert.match(r.text, /already holds a deployment that Conductor did not set up/);
  assert.equal(f.calls().length, 0);
});

test('an .env that appeared after delivery stops before ops init', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), [{ match: "\\[ ! -e \\.env \\]", code: 1 }, ...BOX_RULES]);
  const r = await run(f, withStep(dep0(), 'delivered', 'x'), []);
  assert.equal(r.outcome, 'stopped');
  assert.ok(!f.calls().some((c) => c.command.includes('docker run --rm -u')));
});

test('no terminal at the password step: part-way, step stays at initialised', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), BOX_RULES);
  const ask = scriptedAsk([]); ask.isTTY = false;
  const r = await run(f, withStep(dep0(), 'initialised', 'x'), [], { ask });
  assert.equal(r.outcome, 'partway');
  assert.match(r.text, /shown to you once, and there is no terminal/);
  assert.match(r.text, /conductor ship acme --to acme-office$/);
});

test('a failed start is part-way and keeps the configured step', async () => {
  const f = fakeSsh(mkdtempSync(path.join(tmpdir(), 'fs-')), [{ match: 'docker compose up -d', code: 1, stderr: 'dependency failed to start: container migrate exited (1)\n' }, ...BOX_RULES]);
  const r = await run(f, withStep(dep0(), 'password-saved', 'x'), []);
  assert.equal(r.outcome, 'partway');
  assert.match(r.text, /could not start the app \(dependency failed to start: container migrate exited \(1\)\)/);
  assert.equal(r.saved.at(-1).setup.step, 'configured');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-env-file.test.js test/factory-first-ship.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/factory/ship/envFile.js`.**

- [ ] **Step 4: Implement `src/factory/ship/firstShip.js`** to the step list above. Every interpolated value in a remote command goes through `shq`. All operator-facing text goes through `ask.say`, **except** the backup-password block and the first-admin link, which go through `ask.sayOnce` (Task 10 logs and redacts `say`, never `sayOnce`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/factory-env-file.test.js test/factory-first-ship.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/ship/envFile.js src/factory/ship/firstShip.js test/factory-env-file.test.js test/factory-first-ship.test.js
git commit -m "feat(ship): resumable first-time setup through the foundation's own tools, secrets on stdin only"
```
