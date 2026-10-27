# Task 1: Factory config sections, ids and the Contract 7 imports

Everything later reads its settings through `factoryConfig()` (Plan 7's function, Contract 7 §7.1–§7.2), names runs with `newRunId()`, and builds Compose project names with `composeProjectOf()`. This task:
- **extends** Plan 7's `src/factory/config.js` with this plan's three sections (`foundation`, `build`, `machines`);
- creates `src/factory/ids.js` (owned here, Contract 7 §7.1);
- checks that every Plan 7 export this plan imports exists under its Contract 7 name;
- adds the shared test fixtures.

This plan does **not** add `saveProject`, `loadProject`, a project lock or a `loadConfig` change: Plan 7 owns them (Contract 7 §7.1).

**Files:**
- Create: `src/factory/ids.js`, `test/helpers/factoryFixtures.js`
- Modify: `src/factory/config.js` (Plan 7's; adds the `foundation`, `build` and `machines` sections)
- Test: `test/factory-config.test.js`

**Interfaces:**
- Consumes (Plan 7, Contract 7 §7.1):
  - `factoryConfig(config, { env, home })` (`src/factory/config.js`), extended here;
  - `projectDir`, `readProject`, `loadProject`, `saveProject` (`src/factory/projects.js`);
  - `lockProject` (`src/factory/projectLock.js`);
  - `acceptanceIds`, `testTag` (`src/factory/acceptance.js`);
  - `OUTBOUND_SERVICES` (`src/factory/outbound.js`);
  - `writeJsonAtomic` (`src/factory/fsAtomic.js`);
  - `loadBrief`, `renderBrief`, `validateBrief`, `currentBriefInfo` (`src/factory/brief.js`);
  - `extractJson` (`src/plan.js`);
  - `FACTORY_COMMANDS`, `runFactoryCommand` (`src/cli/factory.js`).
- Produces: the `foundation`, `build` and `machines` sections of `FactoryConfig`; `newRunId`, `composeProjectOf`, `SLUG_RE`, `RUN_ID_RE`, `COMPOSE_PROJECT_RE` (index, Shared Interfaces); fixtures `makeFoundationRepo`, `sampleBrief`, `makeProject`.

- [ ] **Step 1: Check the Contract 7 imports**

Run:
```bash
node -e "import('./src/factory/projects.js').then(m=>console.log(['projectDir','readProject','loadProject','saveProject'].map(n=>n+':'+typeof m[n]).join(' ')))"
node -e "import('./src/factory/projectLock.js').then(m=>console.log('lockProject:'+typeof m.lockProject))"
node -e "import('./src/factory/acceptance.js').then(m=>console.log(['acceptanceIds','testTag'].map(n=>n+':'+typeof m[n]).join(' ')))"
node -e "import('./src/factory/outbound.js').then(m=>console.log('OUTBOUND_SERVICES:'+typeof m.OUTBOUND_SERVICES))"
node -e "import('./src/factory/fsAtomic.js').then(m=>console.log('writeJsonAtomic:'+typeof m.writeJsonAtomic))"
node -e "import('./src/factory/config.js').then(m=>console.log('factoryConfig:'+typeof m.factoryConfig))"
node -e "import('./src/factory/brief.js').then(m=>console.log(['loadBrief','renderBrief','validateBrief','currentBriefInfo'].map(n=>n+':'+typeof m[n]).join(' ')))"
node -e "import('./src/plan.js').then(m=>console.log('extractJson:'+typeof m.extractJson))"
node -e "import('./src/cli/factory.js').then(m=>console.log(['runFactoryCommand'].map(n=>n+':'+typeof m[n]).join(' ')+' FACTORY_COMMANDS:'+typeof m.FACTORY_COMMANDS))"
node -e "import('./src/factory/acceptance.js').then(m=>console.log(m.testTag('submit-expense#1')))"
```
Expected: every name prints `function` (`OUTBOUND_SERVICES` and `FACTORY_COMMANDS` print `object`), and the last line prints `[submit-expense#1]`.
- Any name missing means Plan 7 has not merged as Contract 7 says. **Stop and report it**; do not add a local copy.
- Note the shape of one `acceptanceIds(sampleBrief())` entry. This plan reads only `.id`, `.featureId` and `.example` from it.

- [ ] **Step 2: Write the failing tests**

Create `test/factory-config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factoryConfig } from '../src/factory/config.js';
import { validateBrief } from '../src/factory/brief.js';
import { newRunId, composeProjectOf, RUN_ID_RE, SLUG_RE, COMPOSE_PROJECT_RE } from '../src/factory/ids.js';
import { sampleBrief } from './helpers/factoryFixtures.js';

const home = '/home/op';
const cfg = (factory) => factoryConfig({ factory }, { env: {}, home });

test('defaults: static provider, foundation v0.1.0, the real verify, browser gate on, 2 check fixes and 3 council fixes', () => {
  const f = cfg({});
  assert.deepEqual(f.foundation, { repo: '/root/highland-foundation', tag: 'v0.1.0' });
  assert.deepEqual(f.build, { testCommand: null, browserGate: true, fixRounds: 2, councilFixRounds: 3 });
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

test('fail closed: unknown keys, bad tags, bad provider, ssh foundation URLs, bad hosts, bad fix rounds', () => {
  assert.throws(() => cfg({ biuld: {} }), /Unknown setting "factory.biuld"/);
  assert.throws(() => cfg({ build: { fixrounds: 1 } }), /Unknown setting "factory.build.fixrounds"/);
  assert.throws(() => cfg({ build: { councilFixRounds: 11 } }), /factory.build.councilFixRounds must be a whole number from 0 to 10/);
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

test('run ids and compose project names; SLUG_RE follows Plan 7\'s slug rule', () => {
  const id = newRunId(new Date(Date.UTC(2026, 9, 27, 14, 30, 5)), () => 'a1b2');
  assert.equal(id, '20261027-143005-a1b2');
  assert.match(newRunId(), RUN_ID_RE);
  assert.equal(composeProjectOf('acme-ltd', id), 'hf-acme-ltd-20261027-143005-a1b2');
  assert.match(composeProjectOf('acme-ltd', id), COMPOSE_PROJECT_RE);
  assert.throws(() => composeProjectOf('Acme Ltd', id), /not a valid project name/);
  assert.throws(() => composeProjectOf('acme', '$(id)'), /not a valid run id/);
  for (const [s, ok] of [['a', true], ['acme-ltd', true], ['-a', false], ['a--b', false], ['a-', false], ['x'.repeat(41), false]]) assert.equal(SLUG_RE.test(s), ok, s);
});

test('the sample brief is a valid approved brief with example ids', () => {
  const b = sampleBrief();
  assert.deepEqual(validateBrief(b, { stage: 'approved' }).problems, []);
  assert.deepEqual(b.features.flatMap((f) => f.acceptance.map((a) => a.id)), ['submit-expense#1', 'submit-expense#2', 'monthly-report#1']);
});
```

`projectsRoot` and `operatorName` are Plan 7's and are tested there.

- [ ] **Step 3: Run the tests to see them fail**

Run: `node --test test/factory-config.test.js`
Expected: FAIL (`Cannot find module '../src/factory/ids.js'`).

- [ ] **Step 4: Implement `src/factory/ids.js`**

- `SLUG_RE = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/`, the same rule as Plan 7's `validateSlug`.
- `RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/`; `COMPOSE_PROJECT_RE = /^hf-[a-z0-9-]+-\d{8}-\d{6}-[0-9a-f]{4}$/`.
- `newRunId` formats the UTC date as `YYYYMMDD-HHMMSS`, then `-` and the 4 hex characters from `rand()`. The run's kind (build, change) lives in its record, not in its id (Contract 7 §7.1).
- `composeProjectOf` throws `"<slug>" is not a valid project name` / `"<runId>" is not a valid run id`, checked against `SLUG_RE` / `RUN_ID_RE`.

- [ ] **Step 5: Extend `factoryConfig` in `src/factory/config.js`**

Add three section readers beside Plan 7's code. Plan 7's `factoryConfig` leaves unknown top-level keys alone (so later plans' sections are not refused before they land); this task adds the check: an unknown top-level key, or an unknown key inside a section, throws `Unknown setting "factory.<path>" in the config (known: …)`. The known top-level keys after this task are `projectsRoot`, `operatorName`, `foundation`, `build` and `machines`; Plan 10 Task 10 adds `alerts` and `ship`. Each reader takes the raw section and `{ home }`, checks its own keys, and returns a frozen section. `factoryConfig` adds `foundation`, `build` and `machines` to the object it returns. Plan 7's own tests must still pass.

- `foundationSection` (defaults `{ repo: '/root/highland-foundation', tag: 'v0.1.0' }`):
  - `repo`: an absolute local path, `file://…` or `https://…`. Anything else throws `factory.foundation.repo must be a local folder, a file:// or an https:// address (got "<value>")`.
  - `tag` must match `^v\d+\.\d+\.\d+$`.
- `buildSection`:
  - `testCommand`: `null` or a non-empty string;
  - `browserGate`: boolean;
  - `fixRounds` (red whole-app checks): whole number 0–5, default 2;
  - `councilFixRounds` (blocking whole-app council findings, spec §4.3): whole number 0–10, default 3.
  - `councilFixRounds` is separate from the per-run `options.councilFixRounds` (Plan 5). That option caps the council's bounce-back inside one feature run.
- `machinesSection`:
  - `provider` is `'static'|'proxmox'`; `sshBin`/`scpBin` are non-empty strings; `sweepAfterMs` is a whole number ≥ 60 000.
  - **Static host.** Defaults: `name` = `id`, `user: 'root'`, `keyPath: '~/.ssh/id_ed25519'`, `previewPort: 8080`, `workRoot: '/srv/hf-factory'`. Checks:
    - `id` matches `^[a-z0-9][a-z0-9-]{0,30}$`;
    - `host` matches `^[A-Za-z0-9.-]{1,253}$` (else `host "<v>" is not a valid address`);
    - `user` matches `^[a-z_][a-z0-9_-]{0,31}$`;
    - `previewPort` is 1–65535;
    - `workRoot` is absolute and matches `^/[A-Za-z0-9/_.-]+$`;
    - duplicate ids throw.
  - **Proxmox**, required when `provider === 'proxmox'`. Required fields:
    - `apiUrl` (https, or `http://127.0.0.1:<port>`);
    - `node`;
    - `tokenId` (`^[^\s!]+@[^\s!]+![A-Za-z0-9_-]+$`);
    - `pool` (`^[A-Za-z0-9_-]+$`);
    - `template` (an integer outside the range);
    - `vmidRange` (two integers ≥ 100, lowest first);
    - `keyPath`.
  - Proxmox defaults: `tokenEnv: 'CONDUCTOR_PROXMOX_TOKEN'`, `caFile: null`, `maxContainers: 3`, `maxMemoryMb: 12288`, `cores: 2`, `memoryMb: 4096`, `fullClone: false`, `user: 'root'`, `previewPort: 80`, `workRoot: '/srv/hf-factory'`.
- `~` at the start of a path expands to `home`, with the helper Plan 7 uses for `projectsRoot`.
- Messages are plain sentences, as in the tests.

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
export function sampleBrief(over = {}) -> Brief       // passes Plan 7's validateBrief(…, { stage: 'approved' })
//   client 'Acme Ltd', kind 'web-app', purpose (≥ 40 characters), roles [{ name: 'Office manager', whatTheyDo, sees, mapsTo: 'manager' }, { name: 'Staff', whatTheyDo, sees, mapsTo: 'member' }],
//   records: [{ name: 'Expense', description, holdsFiles: false, personalData: true }],
//   features: [{ id: 'submit-expense', title: 'Submit an expense', story, roles: ['Staff'], data: ['Expense'],
//                acceptance: [{ id: 'submit-expense#1', given: 'a member', when: 'they submit £12.40 with £2.07 VAT for Travel', then: 'it appears in their list as £12.40' },
//                             { id: 'submit-expense#2', given: 'a member', when: 'they submit a negative amount', then: 'they are told the amount must be above £0' }] },
//              { id: 'monthly-report', title: 'Monthly report', …, acceptance: [{ id: 'monthly-report#1', given: 'two Travel expenses of £12.40 and £7.60 in March', when: 'a manager opens March', then: 'Travel shows £20.00' }] }],
//   outputs: [], integrations: [], modules: [],
//   policy: { hosting: 'client-box', outbound: [], residency: 'uk', retention: { text: 'Kept for 6 years, then deleted', days: 2190 },
//             backupDestination: { kind: 'client-owned', detail: "A USB disk kept in the client's office" }, operatorAccess: true },
//   assumptions: [], openQuestions: [],
//   // the meta fields Plan 7 stamps at approval (its validator needs every one at stage 'approved'):
//   exampleSeq: { 'submit-expense': 2, 'monthly-report': 1 }, slug: 'acme-ltd', version: 1, createdAt: '2026-10-27T09:00:00.000Z', revisedFrom: null,
//   approvedAt: '2026-10-27T10:00:00.000Z' /* exact toISOString() form */, approvedBy: 'operator', schema: 1, ...over
//   (Plan 7's own fixture is test/helpers/briefFixtures.js approvedBrief(); copy its shape. Add any further field Plan 7's validator requires, as Step 2's last test shows.)
export function makeProject({ root = mkdtempSync(…), slug = 'acme-ltd', status = 'briefing', foundation } = {}) -> { projectsRoot, projectDir, slug }
//   writes project.json with Plan 7's saveProject:
//   { schema: 1, slug, client: 'Acme Ltd', createdAt, status, foundation: foundation ?? { repo: null, tag: null }, approved: null, builtFromBrief: null }
```

- [ ] **Step 7: Run the tests**

Run: `node --test test/factory-config.test.js && npm test`
Expected: PASS, and the whole suite stays green, including Plan 7's config tests.

- [ ] **Step 8: Commit**

```bash
git add src/factory/config.js src/factory/ids.js test/helpers/factoryFixtures.js test/factory-config.test.js
git commit -m "feat(factory): build and machine settings, run ids and shared fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
