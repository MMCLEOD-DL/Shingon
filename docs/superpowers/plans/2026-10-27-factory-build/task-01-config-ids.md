# Task 1: Factory config, ids and the Plan 7 seam

Everything later reads its settings through `factoryConfig()`, names runs with `newRunId()`, and builds Compose project names with `composeProjectOf()`. This task also checks the Plan 7 seam (index, "Plan 7 seam") and adds the shared test fixtures.

**Files:**
- Create: `src/factory/config.js`, `src/factory/ids.js`, `test/helpers/factoryFixtures.js`
- Modify: `src/config.js` (`loadConfig` returns `factory`, unless Plan 7 already did), `src/factory/projects.js` (adds `saveProject`)
- Test: `test/factory-config.test.js`

**Interfaces:**
- Consumes: `loadConfig` (`src/config.js`); Plan 7's `src/factory/projects.js`, `src/factory/fsAtomic.js` and `src/factory/brief.js`.
- Produces: `factoryConfig`, `newRunId`, `composeProjectOf`, `SLUG_RE`, `RUN_ID_RE`, `COMPOSE_PROJECT_RE` (index, Shared Interfaces); fixtures `makeFoundationRepo`, `sampleBrief`, `makeProject`.

- [ ] **Step 1: Check the Plan 7 seam**

Run:
```bash
node -e "import('./src/factory/projects.js').then(m=>console.log(['projectDir','readProject','saveProject'].map(n=>n+':'+typeof m[n]).join(' ')))"
node -e "import('./src/factory/fsAtomic.js').then(m=>console.log('writeJsonAtomic:'+typeof m.writeJsonAtomic))"
node -e "import('./src/plan.js').then(m=>console.log('extractJson:'+typeof m.extractJson))"
node -e "import('./src/factory/brief.js').then(m=>console.log(['loadBrief','renderBrief','validateBrief'].map(n=>n+':'+typeof m[n]).join(' ')))"
grep -n "factory" src/config.js
```
Expected: every name prints `function` except `saveProject` (Plan 7 has none); `loadConfig` may not return `factory` yet.
- A name exported under another name: use Plan 7's name in this plan's imports, and note it in the commit message.
- Add `saveProject(dir, project)` to `src/factory/projects.js`: `writeJsonAtomic(path.join(dir, 'project.json'), project)`. Add a one-line test beside Plan 7's project tests (`saveProject` then `readProject` returns the same object).
- `loadConfig` without `factory`: add `factory: parsed.factory ?? {}` to its return value, and `if (parsed.factory != null && (typeof parsed.factory !== 'object' || Array.isArray(parsed.factory))) throw new Error('"factory" in the config must be an object')`.

- [ ] **Step 2: Write the failing tests**

Create `test/factory-config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factoryConfig } from '../src/factory/config.js';
import { newRunId, composeProjectOf, RUN_ID_RE, SLUG_RE, COMPOSE_PROJECT_RE } from '../src/factory/ids.js';

const home = '/home/op';
const cfg = (factory) => factoryConfig({ factory }, { env: {}, home });

test('defaults: static provider, foundation v0.1.0, the real verify, browser gate on', () => {
  const f = cfg({});
  assert.equal(f.projectsRoot, '/home/op/highland-projects');
  assert.deepEqual(f.foundation, { repo: '/root/highland-foundation', tag: 'v0.1.0' });
  assert.deepEqual(f.build, { testCommand: null, browserGate: true, fixRounds: 2 });
  assert.equal(f.machines.provider, 'static');
  assert.equal(f.machines.sweepAfterMs, 6 * 3600_000);
  assert.deepEqual(f.machines.static.hosts, []);
  assert.equal(f.machines.proxmox, null);
});

test('a static host is completed with defaults and ~ is expanded', () => {
  const f = cfg({ machines: { static: { hosts: [{ id: 'ct111', host: '192.168.1.111', keyPath: '~/.ssh/id_ed25519' }] } } });
  assert.deepEqual(f.machines.static.hosts[0], {
    id: 'ct111', name: 'ct111', host: '192.168.1.111', user: 'root', keyPath: '/home/op/.ssh/id_ed25519',
    previewPort: 8080, workRoot: '/srv/hf-factory',
  });
});

test('fail closed: unknown keys, bad tags, bad provider, ssh foundation URLs, bad hosts', () => {
  assert.throws(() => cfg({ biuld: {} }), /Unknown setting "factory.biuld"/);
  assert.throws(() => cfg({ foundation: { tag: 'main' } }), /factory.foundation.tag must be a release tag such as v0.1.0/);
  assert.throws(() => cfg({ foundation: { repo: 'git@github.com:x/y.git' } }), /local folder, a file:\/\/ or an https:\/\/ address/);
  assert.throws(() => cfg({ machines: { provider: 'aws' } }), /factory.machines.provider must be "static" or "proxmox"/);
  assert.throws(() => cfg({ machines: { static: { hosts: [{ id: 'x', host: 'a b' }] } } }), /host "a b" is not a valid address/);
  assert.throws(() => cfg({ machines: { static: { hosts: [{ id: 'x', host: 'h', workRoot: 'relative' }] } } }), /workRoot must be an absolute path/);
  assert.throws(() => cfg({ machines: { provider: 'proxmox' } }), /factory.machines.proxmox is missing/);
});

test('proxmox settings: required fields, range, http only for 127.0.0.1', () => {
  const ok = { apiUrl: 'https://192.168.1.100:8006', node: 'ms01', tokenId: 'conductor@pve!factory', pool: 'hf-factory',
    template: 9099, vmidRange: [9100, 9149], keyPath: '~/.ssh/hf_factory' };
  const f = cfg({ machines: { provider: 'proxmox', proxmox: ok } });
  assert.equal(f.machines.proxmox.tokenEnv, 'CONDUCTOR_PROXMOX_TOKEN');
  assert.deepEqual([f.machines.proxmox.maxContainers, f.machines.proxmox.cores, f.machines.proxmox.memoryMb, f.machines.proxmox.maxMemoryMb], [3, 2, 4096, 12288]);
  assert.equal(f.machines.proxmox.previewPort, 80);
  assert.throws(() => cfg({ machines: { provider: 'proxmox', proxmox: { ...ok, vmidRange: [9149, 9100] } } }), /vmidRange must be two whole numbers, lowest first/);
  assert.throws(() => cfg({ machines: { provider: 'proxmox', proxmox: { ...ok, apiUrl: 'http://192.168.1.100:8006' } } }), /must start with https:\/\//);
  assert.doesNotThrow(() => cfg({ machines: { provider: 'proxmox', proxmox: { ...ok, apiUrl: 'http://127.0.0.1:4555' } } }));
  assert.throws(() => cfg({ machines: { provider: 'proxmox', proxmox: { ...ok, template: 9120 } } }), /template must not be inside vmidRange/);
});

test('run ids and compose project names', () => {
  const id = newRunId(new Date(Date.UTC(2026, 9, 27, 14, 30, 5)), () => 'a1b2');
  assert.equal(id, '20261027-143005-a1b2');
  assert.match(newRunId(), RUN_ID_RE);
  assert.equal(composeProjectOf('acme-ltd', id), 'hf-acme-ltd-20261027-143005-a1b2');
  assert.match(composeProjectOf('acme-ltd', id), COMPOSE_PROJECT_RE);
  assert.throws(() => composeProjectOf('Acme Ltd', id), /not a valid project name/);
  assert.throws(() => composeProjectOf('acme', '$(id)'), /not a valid run id/);
  assert.equal(SLUG_RE.test('a'), true);
  assert.equal(SLUG_RE.test('-a'), false);
});
```

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test test/factory-config.test.js`
Expected: FAIL (`Cannot find module '../src/factory/config.js'`).

- [ ] **Step 4: Implement `src/factory/ids.js`**

`newRunId` formats the UTC date as `YYYYMMDD-HHMMSS` plus `-` and the 4 hex characters from `rand()`. `composeProjectOf` throws `"<slug>" is not a valid project name` / `"<runId>" is not a valid run id` against `SLUG_RE` / `RUN_ID_RE`.

- [ ] **Step 5: Implement `factoryConfig(config, { env, home })` in `src/factory/config.js`**

- Reads `config.factory ?? {}`. Every object level is checked against its known keys (top level: `projectsRoot`, `operatorName` (Plan 7's; not checked here), `foundation`, `build`, `machines`); an unknown key throws `Unknown setting "factory.<path>" in the config (known: …)`.
- `~` at the start of a path expands to `home`. `projectsRoot` is `env.CONDUCTOR_PROJECTS_ROOT`, else `factory.projectsRoot`, else `~/highland-projects` (Plan 7's rule); it must end up absolute.
- `foundation.repo`: an absolute local path, `file://…` or `https://…`; anything else throws `factory.foundation.repo must be a local folder, a file:// or an https:// address (got "<value>")`. `foundation.tag` must match `^v\d+\.\d+\.\d+$`.
- `build.testCommand`: `null` or a non-empty string; `browserGate`: boolean; `fixRounds`: whole number 0–5.
- `machines.provider` `'static'|'proxmox'`; `sshBin`/`scpBin` non-empty strings; `sweepAfterMs` whole number ≥ 60 000.
- Static host (defaults: `name` = `id`, `user: 'root'`, `keyPath: '~/.ssh/id_ed25519'`, `previewPort: 8080`, `workRoot: '/srv/hf-factory'`): `id` matches `^[a-z0-9][a-z0-9-]{0,30}$`; `host` matches `^[A-Za-z0-9.-]{1,253}$` (else `host "<v>" is not a valid address`); `user` matches `^[a-z_][a-z0-9_-]{0,31}$`; `previewPort` 1–65535; `workRoot` absolute and matching `^/[A-Za-z0-9/_.-]+$`. Duplicate ids throw.
- Proxmox, required when `provider === 'proxmox'`: `apiUrl` (https, or `http://127.0.0.1:<port>`), `node`, `tokenId` (`^[^\s!]+@[^\s!]+![A-Za-z0-9_-]+$`), `pool` (`^[A-Za-z0-9_-]+$`), `template` (integer, outside the range), `vmidRange` (two integers ≥ 100, lowest first), `keyPath`. Defaults: `tokenEnv: 'CONDUCTOR_PROXMOX_TOKEN'`, `caFile: null`, `maxContainers: 3`, `maxMemoryMb: 12288`, `cores: 2`, `memoryMb: 4096`, `fullClone: false`, `user: 'root'`, `previewPort: 80`, `workRoot: '/srv/hf-factory'`.
- Returns a frozen copy. Messages are plain sentences, as in the tests.

- [ ] **Step 6: Create `test/helpers/factoryFixtures.js`**

```js
// Shared factory fixtures. Never touches /root/highland-foundation: the "foundation" is a tiny repo in a temp dir.
export async function makeFoundationRepo({ tag = 'v0.1.0', extra = {} } = {}) -> string
//   files: foundation.json {"name":"highland-foundation","version":"0.1.0","commit":"v0.1.0"},
//          package.json {"name":"highland-foundation","version":"0.1.0","scripts":{"verify":"node -e 0","test":"node -e 0","lint":"node -e 0"}},
//          apps/web/src/brand.ts (the real one-line BRAND export), docs/BUILDING-ON.md ("# Building"),
//          apps/server/test/crossing/harness.ts, apps/server/test/crossing/cases.ts, apps/web/e2e/pages.ts,
//          apps/web/src/appPaths.ts, apps/server/src/db/schema/index.ts, .gitignore ("node_modules/\nreports/\n"), plus `extra`;
//   one commit on main, annotated tag `tag`.
export function sampleBrief(over = {}) -> Brief
//   client 'Acme Ltd', kind 'web-app', purpose, roles [{ name: 'Office manager', whatTheyDo, mapsTo: 'manager' }, { name: 'Staff', whatTheyDo, mapsTo: 'member' }],
//   features: [{ id: 'submit-expense', title: 'Submit an expense', story, roles: ['Staff'], data: ['expense'],
//                acceptance: [{ given: 'a member', when: 'they submit £12.40 with £2.07 VAT for Travel', then: 'it appears in their list as £12.40' },
//                             { given: 'a member', when: 'they submit a negative amount', then: 'they are told the amount must be above £0' }] },
//              { id: 'monthly-report', title: 'Monthly report', …, acceptance: [{ given: 'two Travel expenses of £12.40 and £7.60 in March', when: 'a manager opens March', then: 'Travel shows £20.00' }] }],
//   outputs: [], integrations: [], modules: [], policy: { hosting: 'client-box', outbound: [], residency: 'uk', retention: { text: '6 years', days: 2190 }, backupDestination: 'client-owned', operatorAccess: true },
//   openQuestions: [], approvedAt: '2026-10-27T10:00:00Z', approvedBy: 'operator', schema: 1, ...over
export function makeProject({ root = mkdtempSync(…), slug = 'acme-ltd', status = 'briefing', foundation } = {}) -> { projectsRoot, projectDir, slug }
//   writes project.json via Plan 7's writeJsonAtomic: { schema: 1, slug, client: 'Acme Ltd', createdAt, status, foundation: foundation ?? { repo: null, tag: null } }
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/factory-config.test.js && npm test`
Expected: PASS, and the whole suite stays green.

- [ ] **Step 8: Commit**

```bash
git add src/factory/config.js src/factory/ids.js test/helpers/factoryFixtures.js test/factory-config.test.js src/config.js src/factory/projects.js test/
git commit -m "feat(factory): factory settings, run ids and shared fixtures"
```
