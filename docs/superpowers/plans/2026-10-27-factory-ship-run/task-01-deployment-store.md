# Task 1: Deployment records (Contract 4)

This task gives every deployment a small, safe record at `<projectDir>/deployments/<name>.json`. Plan 11 reads it, every later task writes it. The record holds only non-secret facts (where the box is, how it is reached, what it runs, what happened). The save function **refuses** anything that looks like a secret, so a later bug cannot quietly put a token on Conductor's disk.

**Files:**
- Create: `src/factory/deployments/store.js`
- Modify: `src/secrets.js` (add `rememberSecret`, `forgetRememberedSecrets`)
- Test: `test/factory-deployments-store.test.js`, `test/secrets.test.js` (append)

**Interfaces:**
- Consumes: `secretValues` from `src/secrets.js`; `writeJsonAtomic`, `createFileExclusive` from Plan 7's `src/factory/fsAtomic.js` (Contract 7 §7.1); `validateSlug` from Plan 7's `src/factory/projects.js`.
- Produces: everything under "Task 1" in the index's Shared Interfaces, plus `class DeploymentError extends Error`; and in `src/secrets.js`, `rememberSecret(value)` / `forgetRememberedSecrets()` (every later task uses them).

Field rules (`validateDeployment` returns every problem, in this order, in plain English):

| Field | Rule |
|---|---|
| `schema` | exactly `1` |
| `name` | `/^[a-z0-9][a-z0-9-]{0,39}$/` |
| `project` | a valid project slug (`validateSlug` returns null) |
| `host` | `/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/` (hostname, IPv4 or `~/.ssh/config` alias; never starts with `-`) |
| `ssh.user` | `/^[a-z_][a-z0-9_-]{0,31}$/`; `ssh.port` null or integer 1–65535; `ssh.keyPath` null or absolute path |
| `bundleDir` | `/^\/[A-Za-z0-9._\/-]+$/`, no `..` segment, not `/` |
| `hosting` | `client-box` \| `operator-server` |
| `imageDelivery` | `tar` \| `registry`; `registry` non-null exactly when `registry` delivery, with `host` (`/^[A-Za-z0-9.-]+(:\d+)?$/`), `namespace` (`/^[a-z0-9][a-z0-9._\/-]*$/`), `user` (non-empty) |
| `access` | `cloudflare-tunnel` \| `ssh` \| `tailscale` |
| `origin` | `http(s)://host[:port]` with no path, query, login |
| `site` | non-empty; must be `:80` when `access` is `cloudflare-tunnel` |
| `setup.step` | one of `SETUP_STEPS` |
| `currentVersion` | null or `x.y.z` |
| `foundation` | null or `vX.Y.Z` (always with the `v`, Contract 7 §7.5) |
| `history[].outcome` | one of `OUTCOMES` |

**Secret refusal** (in `saveDeployment`, after validation): walk the object; refuse when any **key** matches `/token|password|secret|passphrase|credential|apikey|api_key/i` (so `keyPath` is allowed), or when any **string value** contains a value from `secretValues()`. The message never quotes the value: `The deployment record for acme-office was not saved because it would have held a secret (in alerts.matrix). This is a bug in Conductor; nothing was written.`

- [ ] **Step 1: Write the failing tests**

```js
// test/factory-deployments-store.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  SETUP_STEPS, OUTCOMES, newDeployment, validateDeployment, saveDeployment, loadDeployment,
  listDeployments, addHistory, withStep, lockDeployment, deploymentPath, DeploymentError,
} from '../src/factory/deployments/store.js';
import { rememberSecret, forgetRememberedSecrets } from '../src/secrets.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'deps-'));
export const BASE = {
  name: 'acme-office', project: 'acme', host: 'acme-box', ssh: { user: 'highland', port: null, keyPath: null },
  bundleDir: '/opt/highland/acme', hosting: 'client-box', imageDelivery: 'tar', registry: null,
  access: 'cloudflare-tunnel', origin: 'https://staff.acme.co.uk', site: ':80',
  alerts: { matrix: { homeserver: 'https://matrix.example.org', roomId: '!a:example.org' }, webhook: false, heartbeat: true },
};

test('a new deployment is valid, starts at step "new", and has no version or history', () => {
  const d = newDeployment(BASE);
  assert.deepEqual(validateDeployment(d), { ok: true, problems: [] });
  assert.equal(d.schema, 1);
  assert.equal(d.setup.step, 'new');
  assert.equal(d.currentVersion, null);
  assert.deepEqual(d.history, []);
  assert.equal(SETUP_STEPS.at(-1), 'done');
  assert.ok(OUTCOMES.includes('rolled-back') && OUTCOMES.includes('lost-contact'));
});

test('validation explains each bad field in plain words', () => {
  const r = validateDeployment({ ...newDeployment(BASE), host: '-oProxyCommand=x', bundleDir: '/opt/../etc', site: 'staff.acme.co.uk', imageDelivery: 'registry' });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /host/.test(p)));
  assert.ok(r.problems.some((p) => /bundle folder/.test(p)));
  assert.ok(r.problems.some((p) => /:80/.test(p)));
  assert.ok(r.problems.some((p) => /registry/.test(p)));
  assert.ok(validateDeployment({ ...newDeployment(BASE), foundation: '0.1.0' }).problems.some((p) => /foundation/.test(p)));
  assert.equal(validateDeployment({ ...newDeployment(BASE), foundation: 'v0.1.0' }).ok, true);
});

test('save is atomic, round-trips, and leaves no temp files', () => {
  const dir = tmp();
  const d = newDeployment(BASE);
  saveDeployment(dir, d);
  assert.deepEqual(loadDeployment(dir, 'acme-office'), d);
  assert.deepEqual(readdirSync(path.join(dir, 'deployments')), ['acme-office.json']);
  assert.equal(loadDeployment(dir, 'nope'), null);
});

test('save refuses a secret-looking key or a remembered secret value, and writes nothing', () => {
  const dir = tmp();
  assert.throws(() => saveDeployment(dir, { ...newDeployment(BASE), alerts: { ...BASE.alerts, matrix: { ...BASE.alerts.matrix, accessToken: 'x' } } }),
    (e) => e instanceof DeploymentError && /would have held a secret \(in alerts\.matrix\)/.test(e.message));
  rememberSecret('syt_supersecretvalue');
  try {
    assert.throws(() => saveDeployment(dir, addHistory(newDeployment(BASE), { version: '0.1.0', outcome: 'cancelled', detail: 'token syt_supersecretvalue', at: 't' })),
      (e) => !e.message.includes('syt_supersecretvalue'));
  } finally { forgetRememberedSecrets(); }
  assert.equal(existsSync(deploymentPath(dir, 'acme-office')), false);
});

test('a corrupt record is a plain-English error, not a crash', () => {
  const dir = tmp();
  mkdirSync(path.join(dir, 'deployments'));
  writeFileSync(deploymentPath(dir, 'acme-office'), '{ not json');
  assert.throws(() => loadDeployment(dir, 'acme-office'), (e) => e instanceof DeploymentError && /could not be read/.test(e.message));
});

test('listDeployments walks every project and reports unreadable records instead of skipping them', () => {
  const root = tmp();
  const a = path.join(root, 'acme'); mkdirSync(a);
  saveDeployment(a, newDeployment(BASE));
  const b = path.join(root, 'bobs'); mkdirSync(path.join(b, 'deployments'), { recursive: true });
  writeFileSync(path.join(b, 'deployments', 'shop.json'), '[]');
  const list = listDeployments(root);
  assert.deepEqual(list.map((e) => [e.slug, e.name, e.problem === null]), [['acme', 'acme-office', true], ['bobs', 'shop', false]]);
  assert.deepEqual(listDeployments(root, { slug: 'bobs' }).map((e) => e.name), ['shop']);
  assert.deepEqual(listDeployments(path.join(root, 'missing')), []);
});

test('history and step helpers return new objects', () => {
  const d = newDeployment(BASE);
  const h = addHistory(d, { version: '0.1.0', outcome: 'installed', at: '2026-10-27T10:00:00.000Z' });
  assert.deepEqual(h.history, [{ at: '2026-10-27T10:00:00.000Z', version: '0.1.0', from: null, outcome: 'installed', detail: '' }]);
  assert.deepEqual(d.history, []);
  assert.throws(() => addHistory(d, { version: '0.1.0', outcome: 'exploded', at: 't' }));
  assert.equal(withStep(d, 'delivered', 't').setup.step, 'delivered');
  assert.throws(() => withStep(d, 'flying', 't'));
});

test('one ship per deployment at a time; a dead holder\'s lock is taken over', () => {
  const dir = tmp();
  const first = lockDeployment(dir, 'acme-office', { pid: 111, isAlive: () => true });
  assert.ok(first);
  assert.equal(lockDeployment(dir, 'acme-office', { pid: 222, isAlive: () => true }), null);
  assert.ok(lockDeployment(dir, 'acme-office', { pid: 333, isAlive: (pid) => pid !== 111 }));
  first.release(); // releasing a lock that was taken over must not remove the new holder's file
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'deployments', 'acme-office.lock'), 'utf8')).pid, 333);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/factory-deployments-store.test.js`
Expected: FAIL, `Cannot find module '../src/factory/deployments/store.js'`, and `rememberSecret` is not exported.

Append to `test/secrets.test.js`:

```js
import { rememberSecret, forgetRememberedSecrets, redact, secretValues } from '../src/secrets.js';

test('a remembered secret is redacted everywhere, whatever env var it came from', () => {
  rememberSecret('hunter2-matrix-token');
  rememberSecret('abc'); // too short to redact safely: ignored
  try {
    assert.equal(redact('token=hunter2-matrix-token'), 'token=[redacted]');
    assert.ok(secretValues({}).includes('hunter2-matrix-token'));
    assert.ok(!secretValues({}).includes('abc'));
  } finally { forgetRememberedSecrets(); }
  assert.equal(redact('hunter2-matrix-token', secretValues({})), 'hunter2-matrix-token');
});
```

- [ ] **Step 3: Implement `rememberSecret` in `src/secrets.js`**

A module-level `Set`. `rememberSecret(v)` adds strings of length ≥ 4 (shorter values would redact ordinary words); `secretValues(env)` returns the env-derived values plus the remembered ones, longest first, de-duplicated; `forgetRememberedSecrets()` clears the set. `redact`'s default argument picks them up through `secretValues()`.

- [ ] **Step 4: Implement `src/factory/deployments/store.js`**

- Atomic write: `mkdirSync(deployments, { recursive: true })`, then Plan 7's `writeJsonAtomic(file, dep, { mode: 0o644 })` (no local copy of the temp-fsync-rename logic).
- `newDeployment(fields)` fills `schema: 1`, `setup: { step: 'new', at: null }`, `currentVersion: null`, `foundation: null`, `bundleVersion: null`, `pendingCheck: null`, `lastStatus: null`, `history: []`, and throws `DeploymentError` with the joined problems if invalid.
- `loadDeployment` wraps parse and validation failures as `The deployment record <file> could not be read (<first problem>). Fix or remove it.`
- `listDeployments(root, { slug = null } = {})`: `readdirSync(root, { withFileTypes: true })` directories whose name is a valid slug (`validateSlug` returns null) (and equals `slug` when given), sorted, then `deployments/*.json` sorted; `problem` is the `DeploymentError` message, `deployment` null in that case. A missing `root` returns `[]`. Plan 11 lists one project's deployments with `{ slug }`.
- `lockDeployment`: file `<name>.lock` holding `{ pid, at }`, created with Plan 7's `createFileExclusive`. On `EEXIST` read it; if `!isAlive(holder.pid)` replace it (write temp + rename) and return a lock; else `null`. `release()` unlinks only if the file still holds this lock's pid. `defaultIsAlive(pid)` is `process.kill(pid, 0)` true unless it throws `ESRCH`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/factory-deployments-store.test.js test/secrets.test.js && npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/secrets.js src/factory/deployments/store.js test/factory-deployments-store.test.js test/secrets.test.js
git commit -m "feat(ship): deployment records (Contract 4) with atomic, secret-refusing saves

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
