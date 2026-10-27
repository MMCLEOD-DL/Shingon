# Task 7: Questions and policy-derived settings

Spec §4.5: "The operator's only inputs are the target machine's address and access, plus any secrets the app needs. The factory asks for them in plain English." This task writes those questions, checks the answers against the brief's data policy (Ruling 8), and turns them into two things: the fields of a new deployment record, and the list of `.env` settings Task 8 writes on the box.

Secrets are asked with a hidden prompt (nothing echoed), registered with `rememberSecret` the moment they are read, and kept in memory only.

**Files:**
- Create: `src/ui/ask.js`, `src/factory/ship/setupPlan.js`, `test/helpers/scriptedAsk.js`
- Test: `test/ask.test.js`, `test/factory-setup-plan.test.js`

**Interfaces:**
- Consumes: `rememberSecret` (Task 1); `targetProblem` (Task 2); `newDeployment`/`validateDeployment` patterns (Task 1).
- Produces: `createAsk`, `Ask` (index, Task 7); `policyProblems`, `askDeploymentBasics`, `askSettings`, `backupProblem`, `backupShown`, `initArgs`, and:

```js
baseSettings(dep, version) -> [{ key, value, secret: false }]
//   always APP_TAG=<version>
//   registry: APP_IMAGE=<host>/<ns>/app, OPS_IMAGE=<host>/<ns>/ops, IMAGE_PULL_POLICY=missing
//   cloudflare-tunnel: COMPOSE_PROFILES=tunnel, TUNNEL_ENABLED=true
// test/helpers/scriptedAsk.js
scriptedAsk(answers: Array<string|boolean|null>) -> Ask & { asked: string[] }   // each call takes the next answer; text/secret run `check` and throw if it fails
```

**`createAsk({ input, output, isTTY })`** — one reader over `input` 'data' events, splitting on `\n` or `\r`:
- every method returns `null` (or `false` for `confirm`) at once when `!isTTY`; nothing is written;
- `text(q, { def, check })`: writes `q` + (` [<def>]` when given) + ` > `; empty answer → `def`; `check(answer)` returns a problem string or null; on a problem write it and ask again;
- `secret(q, { check, optional })`: writes `q` + ` (hidden) > `; calls `input.setRawMode?.(true)` and restores it in `finally`; echoes **nothing**; backspace (`\x7f`, `\b`) removes a character; `\x03` (Ctrl-C) returns `null`; Enter ends; empty with `optional` → `''`; a non-empty answer is passed to `rememberSecret` **before** `check` runs; writes `\n` at the end;
- `choose(q, choices)`: writes `q`, then `  [k] label` per choice, then `> `; repeats until a listed key is typed;
- `confirm(q)`: `q + ' [y] yes · [n] no > '`; only `y` is `true`;
- `say(text)` writes `text\n`; `sayOnce(text)` is the same here (Task 10's wrapper redacts and logs `say` but leaves `sayOnce` raw and unlogged, for the two things shown exactly once); `close()` removes the listener.

**Questions** (`askDeploymentBasics`; `def` in brackets). It returns `null` after `ask.say`-ing the reason when the operator declines or a policy problem appears:

| # | Question | Check / note |
|---|---|---|
| 1 | `What is the box's address or SSH alias? (for example acme-box or 192.168.1.50)` | `targetProblem` |
| 2 | `Which user should Conductor log in as on the box?` [`highland`] | Task 1 user pattern |
| 3 | `Which SSH port?` [`22`] | 1–65535; `22` stored as `null` |
| 4 | `Which folder on the box holds this deployment?` [`/opt/highland/<slug>`] | Task 1 bundle-folder rule |
| — | hosting is **not asked**: it is `policy.hosting`; said as `The brief says this app runs on the client's own box.` / `… on a server you run.` | |
| 5 | `How will you reach this box from outside?` choices `t` Cloudflare tunnel (outbound only, nothing opened on the client's network), `s` SSH directly (a rented server, or a VPN), `n` Tailscale (you set it up by hand, see the runbook) | `s` with `client-box` → `confirm('Has the client agreed to open SSH to this box from outside their network?')` |
| 6 | `What web address will staff type? (for example https://staff.acme.co.uk)` | `http(s)://` origin, no path |
| 7 | (not with the tunnel, where site is `:80`) `What should the front door answer to? Use the public name for automatic HTTPS, or :80 for plain HTTP on the client's network.` [origin's host] | non-empty |
| 8 | `How should the app's images reach the box?` choices `f` a file copied over SSH (simplest), `r` your private registry | `r` → `Registry address? (for example registry.example.com)`, `Image folder in the registry?` [`highland-<slug>`], `Registry user name for this box?` |

Then `policyProblems(policy, { hosting: policy.hosting, access })`; any problem → say each, return `null`.

**`policyProblems` texts:**
- no policy → `The approved brief has no data policy, so Conductor cannot decide how to set up the box. Revise the brief.`
- `operatorAccess !== true` → `The client has not agreed to your remote access (the brief's data policy). Shipping needs it, so that you can fix things in flight.`
- hosting mismatch → `The brief says the app runs on the client's own box, but this deployment is a server you run.` (and the reverse)
- tunnel without `/cloudflare/i` in `outbound` → `The data policy does not allow Cloudflare, and the Cloudflare tunnel lets Cloudflare see the app's traffic. Choose Tailscale instead (set up by hand: RUNBOOK.md, "Tailscale instead of Cloudflare"), or revise the brief to allow Cloudflare.`

**`askSettings`** (returns `null` when the operator declines; every answer below is `secret: true` unless marked *visible*):
1. `Mail server address for invitations and password resets (for example smtp://user:password@smtp.example.co.uk:587)` → `SMTP_URL`; check `^smtps?://`.
2. *visible* `Sender address for those emails?` → `EMAIL_FROM`; check contains `@`.
3. `Backup destination (for example sftp:backup@host:/path, rest:https://host:8000/repo, s3:… or b2:…)` → `BACKUP_REPOSITORY`; check `backupProblem`. Then `confirm('The client's data policy says backups go to <policy.backupDestination>, with data kept <residency text>. This box will send its encrypted backups to <backupShown(repo)>. Is that right?')` where residency text is `in the UK` / `in the UK or EU` / `anywhere`. No → say `Nothing has been changed on the box.` and return `null`.
4. Sign-in for the destination, by scheme: `s3:` → `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, *visible optional* `AWS_DEFAULT_REGION`; `b2:` → `B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY`; `rest:` → optional `RESTIC_REST_USERNAME`, optional `RESTIC_REST_PASSWORD`; `sftp:` → none, and say `For sftp, the box's own SSH key must be allowed on the backup server.`
5. `choose('Where should alerts go?', m Matrix (your usual alerts room), w a webhook only)` [Matrix is listed first]. Matrix → *visible* homeserver [`defaults.matrix.homeserver`], *visible* room id [`defaults.matrix.roomId`] (check `^!.+:.+$`), then the bot's access token → `MATRIX_ACCESS_TOKEN`. Then optional `Also send alerts to a webhook? Paste its address, or press Enter for none.` → `ALERT_WEBHOOK_URL` (required when `w`).
6. `Uptime Kuma push address for this box (or type skip)` → `HEARTBEAT_URL`; check `^https?://` or `skip`. `skip` → `confirm('Without an outside watcher, nobody notices if the whole box goes off. Ship without one?')`; no → ask again.
7. Cloudflare tunnel only: `Tunnel token from the Cloudflare dashboard` → `TUNNEL_TOKEN` (required).

Result: `{ settings, alerts: { matrix: { homeserver, roomId } | null, webhook: boolean, heartbeat: boolean } }`. `MATRIX_HOMESERVER` and `MATRIX_ROOM_ID` are in `settings` with `secret: false`.

**`backupProblem(repo)`**: `null` for `sftp:user@host:/path`, `rest:http(s)://…`, `s3:…`, `b2:bucket:path`, unless the host is `localhost`, `127.*`, `::1` or `[::1]` (`The backup destination points at the box itself. Backups must leave the box.`); a value starting `/`, `.`, `~` or `local:` → `Backups must not stay on the box. …`; anything else → `Conductor does not recognise that backup destination. Use sftp:, rest:, s3: or b2:.`
**`backupShown(repo)`** never includes a user name or password: `sftp:u@backup.acme.co.uk:/srv/x` → `an SFTP server at backup.acme.co.uk`; `rest:https://u:p@nas.acme.lan:8000/hf` → `a restic REST server at nas.acme.lan:8000`; `s3:s3.eu-west-2.amazonaws.com/acme-bk` → `an S3 bucket at s3.eu-west-2.amazonaws.com/acme-bk`; `b2:acme-bk:hf` → `the Backblaze B2 bucket acme-bk`.

- [ ] **Step 1: Write the failing tests**

```js
// test/ask.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createAsk } from '../src/ui/ask.js';
import { secretValues, forgetRememberedSecrets } from '../src/secrets.js';

function io(isTTY = true) {
  const input = new PassThrough(); const output = new PassThrough(); let out = '';
  output.on('data', (d) => { out += d; });
  return { input, ask: createAsk({ input, output, isTTY }), out: () => out };
}

test('without a terminal every question fails closed and prints nothing', async () => {
  const { ask, out } = io(false);
  assert.equal(await ask.text('Host?'), null);
  assert.equal(await ask.secret('Token'), null);
  assert.equal(await ask.confirm('Sure?'), false);
  assert.equal(out(), '');
});

test('a secret is not echoed, is remembered for redaction, and supports backspace', async () => {
  const { input, ask, out } = io();
  const p = ask.secret('Matrix token');
  input.write('syt_abcx\x7fdef\r');
  assert.equal(await p, 'syt_abcdef');
  assert.equal(out(), 'Matrix token (hidden) > \n');
  assert.ok(secretValues({}).includes('syt_abcdef'));
  forgetRememberedSecrets();
});

test('text uses the default, and repeats until the check passes', async () => {
  const { input, ask, out } = io();
  const p = ask.text('Port?', { def: '22', check: (a) => (/^\d+$/.test(a) ? null : 'Type a number.') });
  input.write('abc\n\n');
  assert.equal(await p, '22');
  assert.match(out(), /Port\? \[22\] > Type a number\.\nPort\? \[22\] > /);
});

test('Ctrl-C in a secret prompt gives null', async () => {
  const { input, ask } = io();
  const p = ask.secret('Token');
  input.write('ab\x03');
  assert.equal(await p, null);
});
```

```js
// test/factory-setup-plan.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptedAsk } from './helpers/scriptedAsk.js';
import { TEST_BRIEF } from './helpers/shipProject.js';
import { policyProblems, askDeploymentBasics, askSettings, backupProblem, backupShown, initArgs, baseSettings } from '../src/factory/ship/setupPlan.js';
import { newDeployment } from '../src/factory/deployments/store.js';

const P = TEST_BRIEF.policy;
const DEFAULTS = { matrix: { homeserver: 'https://matrix.example.org', roomId: '!alerts:example.org' } };

test('policy problems fail closed', () => {
  assert.deepEqual(policyProblems(P, { hosting: 'client-box', access: 'cloudflare-tunnel' }), []);
  assert.match(policyProblems({ ...P, operatorAccess: false }, { hosting: 'client-box', access: 'ssh' })[0], /has not agreed to your remote access/);
  assert.match(policyProblems({ ...P, outbound: [] }, { hosting: 'client-box', access: 'cloudflare-tunnel' })[0], /does not allow Cloudflare/);
  assert.match(policyProblems(P, { hosting: 'operator-server', access: 'ssh' })[0], /client's own box, but this deployment is a server you run/);
  assert.match(policyProblems(null, { hosting: 'client-box', access: 'ssh' })[0], /no data policy/);
});

test('basics for a client box behind the Cloudflare tunnel', async () => {
  const ask = scriptedAsk(['acme-box', '', '', '', 't', 'https://staff.acme.co.uk', 'f']);
  const fields = await askDeploymentBasics(ask, { name: 'acme-office', slug: 'acme', policy: P, defaults: DEFAULTS });
  const dep = newDeployment({ ...fields, alerts: { matrix: null, webhook: false, heartbeat: false } });
  assert.equal(dep.host, 'acme-box');
  assert.deepEqual(dep.ssh, { user: 'highland', port: null, keyPath: null });
  assert.equal(dep.bundleDir, '/opt/highland/acme');
  assert.equal(dep.hosting, 'client-box');
  assert.equal(dep.access, 'cloudflare-tunnel');
  assert.equal(dep.site, ':80');
  assert.equal(dep.imageDelivery, 'tar');
});

test('direct SSH into a client box needs the client\'s agreement', async () => {
  const ask = scriptedAsk(['acme-box', '', '', '', 's', false]);
  assert.equal(await askDeploymentBasics(ask, { name: 'acme-office', slug: 'acme', policy: P, defaults: DEFAULTS }), null);
});

test('settings: secrets flagged, policy confirmation asked, alerts recorded', async () => {
  const dep = newDeployment({ name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
    bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null, access: 'cloudflare-tunnel',
    origin: 'https://staff.acme.co.uk', site: ':80', alerts: { matrix: null, webhook: false, heartbeat: false } });
  const ask = scriptedAsk(['smtp://u:p@smtp.acme.co.uk:587', 'hr@acme.co.uk', 'sftp:bk@backup.acme.co.uk:/srv/hf', true,
    'm', '', '', 'syt_token_value', '', 'https://kuma.example.org/api/push/abc', 'cf-tunnel-token-value']);
  const r = await askSettings(ask, { dep, policy: P, defaults: DEFAULTS });
  const byKey = Object.fromEntries(r.settings.map((s) => [s.key, s]));
  assert.equal(byKey.SMTP_URL.secret, true);
  assert.equal(byKey.EMAIL_FROM.secret, false);
  assert.equal(byKey.MATRIX_ROOM_ID.value, '!alerts:example.org');
  assert.equal(byKey.MATRIX_ACCESS_TOKEN.secret, true);
  assert.equal(byKey.TUNNEL_TOKEN.value, 'cf-tunnel-token-value');
  assert.equal('ALERT_WEBHOOK_URL' in byKey, false);
  assert.deepEqual(r.alerts, { matrix: { homeserver: 'https://matrix.example.org', roomId: '!alerts:example.org' }, webhook: false, heartbeat: true });
  assert.ok(ask.asked.some((q) => /data policy says backups go to client-owned storage, with data kept in the UK\. This box will send its encrypted backups to an SFTP server at backup\.acme\.co\.uk\./.test(q)));
});

test('declining the backup destination stops before anything is changed', async () => {
  const dep = { access: 'ssh', imageDelivery: 'tar' };
  const ask = scriptedAsk(['smtp://u:p@h:587', 'a@b.c', 'sftp:bk@backup.acme.co.uk:/srv/hf', false]);
  assert.equal(await askSettings(ask, { dep, policy: P, defaults: DEFAULTS }), null);
});

test('backup destinations: refused on the box, shown without credentials', () => {
  assert.equal(backupProblem('sftp:bk@backup.acme.co.uk:/srv/hf'), null);
  assert.match(backupProblem('/var/backups'), /must not stay on the box/);
  assert.match(backupProblem('rest:http://localhost:8000/x'), /points at the box itself/);
  assert.match(backupProblem('ftp://x'), /does not recognise/);
  assert.equal(backupShown('rest:https://u:pw@nas.acme.lan:8000/hf'), 'a restic REST server at nas.acme.lan:8000');
  assert.equal(backupShown('b2:acme-bk:hf'), 'the Backblaze B2 bucket acme-bk');
});

test('initArgs and baseSettings follow the deployment', () => {
  const dep = { origin: 'https://staff.acme.co.uk', bundleDir: '/opt/highland/acme', access: 'cloudflare-tunnel', site: ':80', imageDelivery: 'tar', registry: null };
  assert.deepEqual(initArgs(dep, TEST_BRIEF), ['init', '--client', 'Acme Ltd', '--origin', 'https://staff.acme.co.uk', '--dir', '/opt/highland/acme', '--tunnel', '--out', '/out/.env']);
  assert.deepEqual(initArgs({ ...dep, access: 'ssh', site: 'staff.acme.co.uk' }, TEST_BRIEF).slice(7, 9), ['--site', 'staff.acme.co.uk']);
  assert.deepEqual(baseSettings(dep, '0.1.3').map((s) => `${s.key}=${s.value}`), ['APP_TAG=0.1.3', 'COMPOSE_PROFILES=tunnel', 'TUNNEL_ENABLED=true']);
  assert.deepEqual(baseSettings({ ...dep, access: 'ssh', imageDelivery: 'registry', registry: { host: 'reg.example.com', namespace: 'highland-acme', user: 'u' } }, '0.1.3').map((s) => s.key),
    ['APP_TAG', 'APP_IMAGE', 'OPS_IMAGE', 'IMAGE_PULL_POLICY']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/ask.test.js test/factory-setup-plan.test.js`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/ui/ask.js` and `test/helpers/scriptedAsk.js`.** The scripted ask has `say`/`sayOnce` that do nothing (tests replace them), records each question text in `asked` (for `choose`, the question line only), returns the next answer, treats `''` for `text` as "take the default", and for `secret` calls `rememberSecret` like the real one.

- [ ] **Step 4: Implement `src/factory/ship/setupPlan.js`** to the tables above.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/ask.test.js test/factory-setup-plan.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/ui/ask.js src/factory/ship/setupPlan.js test/helpers/scriptedAsk.js test/ask.test.js test/factory-setup-plan.test.js
git commit -m "feat(ship): plain-English setup questions, hidden secret prompts and data-policy checks"
```
