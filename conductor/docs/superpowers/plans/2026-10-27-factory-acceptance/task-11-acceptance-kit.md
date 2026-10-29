# Task 11: Acceptance kit (Conductor)

**Repo: `/root/conductor`, branch `plan12-acceptance` from `master`. Zero dependencies, `npm test` (`node --test`).**

The acceptance test (spec §8 item 9) is run by the operator over several sessions (Tasks 12–15). This task gives him three things:
- **the criteria**, each tied to spec §2 and marked automated or operator-checked;
- **a checker**, `check-acceptance.mjs`, that reads the project folder (Contract 1) and the app's own reports and fills in every automated criterion with its evidence;
- **a results template** for everything a person must see with their own eyes (real phones, alerts, a restore).

The checker never builds, deploys or calls a model. It only reads files.

It also makes the one Conductor product change the acceptance run needs (Step 0) [cross-plan ruling: Plan 8's `briefProblems` refuses any brief with `modules` ("the optional modules arrive in Plan 12") and no earlier plan lifts it, yet the expenses tracker needs `ocr` and the exports. Plan 12 lifts it here, only for foundation v0.2.0 or later, so Plan 8's behaviour and tests on v0.1.0 stay as built].

**Files:**
- Create: `spikes/acceptance/check-acceptance.mjs`, `spikes/acceptance/PROCEDURE.md`, `spikes/acceptance/RESULT-TEMPLATE.md`, `spikes/acceptance/rehearsal-notes.md`
- Create: `test/acceptance-check.test.js`, `test/helpers/acceptanceProject.js` (builds a good project folder in a temp dir with Plans 7 and 10's own writers; each failing case is one mutation of it)
- Modify: `README.md` (one paragraph under the factory section, pointing to `spikes/acceptance/PROCEDURE.md`)
- Modify (Step 0): `src/factory/split.js` (`briefProblems`, `MODULES_SINCE`), `src/factory/build.js` (passes the foundation tag) — Plan 8's files
- Create (Step 0): `test/factory-modules-lift.test.js`

**Interfaces:**
- Consumes (Conductor modules, imported, never re-implemented):
  - Plan 7: `loadProject(dir)` (`src/factory/projects.js`); `loadBrief(projectDir)`, `currentBriefInfo(projectDir)`, `briefPaths`, `saveApprovedBrief` (`src/factory/brief.js`); `acceptanceIds(brief) -> [{ id, featureId, n, example }]` and `testTag(id) -> '[<id>]'` (`src/factory/acceptance.js`, Contract 7.1/7.4); `writeFileAtomic` (`src/factory/fsAtomic.js`); test helpers `validBrief`, `approvedBrief` (`test/helpers/briefFixtures.js`).
  - Plan 10: `loadDeployment(projectDir, name)`, `newDeployment`, `addHistory`, `saveDeployment` (`src/factory/deployments/store.js`, Contract 4); `compareVersions` (`src/factory/foundationLog.js`, Contract 7.1).
  - Plan 8 (Step 0 only): `briefProblems(brief)` (`src/factory/split.js`) and its call in `runBuild` (`src/factory/build.js`, refusal step 3); `sampleBrief` (`test/helpers/factoryFixtures.js`).
- Consumes (file shapes):
  - Contract 7.5 `project.json`: `status`, `foundation.tag`;
  - the approved brief (`loadBrief`; `brief/current.json` is a pointer, so the checker never reads it directly), and the previous version `brief/brief-v<N-1>.json` (written once, never changed) for C14;
  - Plan 8's whole-app check evidence in the run folder (Plan 8 Task 6 fixes the names; `checks.reports` lists them as **absolute** paths in `builds/<runId>/reports/`): `crossing.json` (`{ routes, checks, failures[] }`) and the `screenshots` folder, whose `manifest.json` has entries `{ page, path, project, width, height, file }`;
  - Plan 8's Vitest JSON report: the `checks.reports` entry named `vitest.json` in `builds/<runId>/build.json` (Contract 7.7; Plan 8 Task 6), whose JSON has a `testResults` array. A change run is looked up the same way: Plan 11 runs Plan 8's `runBuild` in change mode with the change's run id, so its `build.json` sits in `builds/<change runId>/` beside `change.json`. `--tests <file>` overrides it, for a report the operator makes by hand;
  - Plan 9's council report `builds/<runId>/council-report.json` (Contract 7.5): Plan 5's `CouncilReport` minus `text` (`round`, `verdict`, `blocking[]`, `warnings[]`, `overridden`; items carry `member`, `tool`, `title`) plus Plan 9's `checked`, `coverage`, `files`. An operator override at Plan 8's gate is recorded in `build.json` as `council.overridden: true`, not in the report, so C2 reads both;
  - the app repo's `app/app-profile.json` (Task 1's `AppProfileSchema`, written by Plan 8/11) and `app/licence-exceptions.json`;
  - the deployment record (Contract 4: `history[] { at, version, from, outcome, detail }`, `currentVersion`; the first ship records outcome `installed`).
- Produces:

```js
// spikes/acceptance/check-acceptance.mjs
export const CRITERIA          // [{ id: 'C1', spec: '§2.1', title, how: 'auto' | 'operator' }]
export const FOUNDATION_V020_ROUTES = 31   // v0.1.0's 28 + Task 5's 3; Task 10's hand-off confirms the figure
export async function checkAcceptance(projectDir, opts) -> { results: [{ id, status: 'pass' | 'fail' | 'operator', evidence: string }], ok: boolean }
//   opts = { build: runId, change?: runId, deployment?: name, tests?: file, changeTests?: file,
//            foundationTag = 'v0.2.0', foundationRoutes = FOUNDATION_V020_ROUTES,
//            deps? = { loadBrief } }   // tests only: Plan 7's validator cannot save a brief whose example lacks an id
export function renderResults(project, results) -> string   // Markdown: the criteria table with status and evidence
// CLI: node spikes/acceptance/check-acceptance.mjs <projectDir> --build <runId> [--change <runId>] [--deployment <name>]
//        [--tests <file>] [--change-tests <file>] [--foundation-tag <vX.Y.Z>] [--foundation-routes <n>] [--out <file>]
//      exit 0 when every automated criterion passes, 1 otherwise, 2 for bad arguments (plain-English usage)
```

## The criteria (written into `CRITERIA` and `PROCEDURE.md` word for word)

| Id | Spec | Criterion | How |
|---|---|---|---|
| C1 | §2.1 | The role-crossing harness ran on the finished build: the run's `crossing.json` has 0 failures and more routes than the foundation's own at v0.2.0 (`foundationRoutes`, 31), so at least one expenses route is checked. | auto |
| C2 | §2.1, §4.3 | The build's council report (`builds/<runId>/council-report.json`) has verdict `approved` or `approved-with-warnings`, no blocking items, and was **not** overridden (neither the report's `overridden` nor `build.json`'s `council.overridden`). | auto |
| C3 | §2.2 | Every acceptance example in the current approved brief is proven by a passing test: for each id from `acceptanceIds(brief)`, a test whose title contains `testTag(id)` (`[<featureId>#<n>]`, Contract 7.4) passed in the latest run's Vitest report (the change run when given, else the build). An example with no id, a tag with no test, or a tag whose only tests failed is a FAIL naming the id. | auto |
| C4 | §2.2 | The app's March report, downloaded from the preview as PDF and as a spreadsheet, shows exactly the totals worked out by hand from the brief's examples. | operator |
| C5 | §2.2, §2.5 | On the 10 fictional printed receipts, photographed through the app on a real phone, no field is ever filled in confidently wrong (no "Please check" missing on a wrong value). | operator |
| C6 | §2.3 | Every page has a screenshot at desktop width and phone width in Chromium and WebKit (`manifest.json`: every page has `desktop-chromium`, `mobile-chromium` and `mobile-webkit`). | auto |
| C7 | §2.3, §2.5 | On a real iPhone (Safari) and a real Android phone (Chrome): **Take a photo** opens the camera and uploads; **Choose a file** uploads a photo from the library and a PDF; the reading appears; correcting a field and confirming works; nothing scrolls sideways. | operator |
| C8 | §2.4 | On the test box: a manual backup, then `restore-test`, pass; then a real restore drill from the runbook returns a record count known beforehand. | operator |
| C9 | §2.4 | Stopping the app container sends a Matrix alert within 5 minutes, and starting it sends the recovery message. | operator |
| C10 | §2.4, §4.8 | The change request went out as an **update**: the deployment's `history` starts with outcome `installed` and ends with outcome `updated` at a `currentVersion` newer than the installed one (`compareVersions`). | auto |
| C11 | §2.5 | A member gets from "open the app" to a confirmed receipt in under 60 seconds on a phone, with no step that needs help. | operator |
| C12 | §3, §6 | The app's `app-profile.json` matches the approved brief: `policy.outbound` holds the same `OUTBOUND_SERVICES` ids (Contract 7.4), `residency` is equal, and `modules` contains every module the brief lists (here `ocr`). (Task 14 also checks `OCR_ENGINE=local` on the box by hand.) | auto |
| C13 | §5a | The latest council report has no blocking or warning item with `member: 'legal'` from the `licences` or `scancode` tool, and every entry in the app's `licence-exceptions.json` has a reason (Plan 9's Legal accepts those entries, Contract 7.7). | auto |
| C14 | §4.8 | The change run's own council report meets C2's rule, and every example id that is new in the current brief version (absent from `brief-v<N-1>.json`) is proven by a passing test in the change run's report. | auto |
| C15 | §1 | The operator never edited the app's code by hand (Ruling 9). Any hand edit is recorded with its reason, and counts as a FAIL for the factory. | operator |
| C16 | §3 | No paid-API spend unless opted in; frontier cost recorded per stage. | operator |
| C17 | Contract 7.5 | `project.json` records `foundation.tag` equal to the expected tag (`foundationTag`, `v0.2.0`, the value of `factory.foundation.tag` for this run) and status `shipped` at the end. | auto |

**Verdict:** the acceptance test **passes** only when every criterion passes. Any FAIL means fixing the factory (Ruling 9) and re-running the stage it belongs to.

- [ ] **Step 0: Lift Plan 8's modules refusal for foundation v0.2.0 and later** [cross-plan ruling]

`test/factory-modules-lift.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefProblems, MODULES_SINCE } from '../src/factory/split.js';
import { sampleBrief } from './helpers/factoryFixtures.js';

test('modules are refused before foundation v0.2.0 and accepted from it on', () => {
  const b = sampleBrief({ modules: ['ocr', 'xlsx-export'] });
  assert.equal(MODULES_SINCE, 'v0.2.0');
  assert.match(briefProblems(b).join('\n'), /needs optional modules \(ocr, xlsx-export\)/);                       // no tag: Plan 8's behaviour
  assert.match(briefProblems(b, { foundationTag: 'v0.1.0' }).join('\n'), /needs optional modules/);
  assert.deepEqual(briefProblems(b, { foundationTag: 'v0.2.0' }), []);
  assert.deepEqual(briefProblems(b, { foundationTag: 'v0.10.0' }), []);
});
```

Plus one `runBuild` test in the same file, using Plan 8's `test/helpers/buildHarness.js`: with `factory.foundation.tag` `v0.2.0` (and a fake foundation repo made at `v0.2.0` by `makeFoundationRepo({ tag: 'v0.2.0', extra: { 'foundation.json': '{"name":"highland-foundation","version":"0.2.0","commit":"v0.2.0"}' } })`, so Plan 8's `createApp` accepts it), a brief with `modules: ['ocr']` is not refused and reaches the split; with `v0.1.0` it is refused with Plan 8's sentence.

Implement:
- `src/factory/split.js`: `export const MODULES_SINCE = 'v0.2.0'`; `briefProblems(brief, { foundationTag = null } = {})` keeps Plan 8's modules sentence, but adds it only when `foundationTag` is null or `compareVersions(foundationTag.slice(1), MODULES_SINCE.slice(1)) < 0` (Plan 10's `compareVersions`, `src/factory/foundationLog.js`). Every other refusal is unchanged.
- `src/factory/build.js`: refusal step 3 calls `briefProblems(brief, { foundationTag: project.foundation?.tag ?? factory.foundation.tag })`.
- Plan 8's existing tests (which pass no tag, or `v0.1.0`) stay unchanged and green.

- [ ] **Step 1: Write the fixture builder** (`test/helpers/acceptanceProject.js`)

`makeAcceptanceProject(root, { mutate } = {}) -> projectDir` builds a good project in a temp folder with the owners' own writers, so the fixture can never drift from their validators:
- `project.json` (Contract 7.5) with status `shipped`, `foundation: { repo: '/root/highland-foundation', tag: 'v0.2.0', commit: 'a'.repeat(40) }`, `approved` and `builtFromBrief: 2`;
- brief v1 through `saveApprovedBrief(projectDir, approvedBrief({ … }))` with 2 features and examples `expense-entry#1`, `expense-entry#2`, `monthly-report#1`, `modules: ['ocr', 'xlsx-export', 'pdf-export']`, `policy.outbound: []`, `residency: 'uk'`; then brief v2 (`revisedFrom: 1`) adding feature `mileage` with example `mileage#1`;
- `builds/b1/`: `build.json` with `checks.reports` listing, as absolute paths (Plan 8 Task 6's fixed names), `<b1>/reports/vitest.json`, `<b1>/reports/crossing.json` and `<b1>/reports/screenshots`, and `council: { status: 'approved-with-warnings', overridden: false }`; `reports/crossing.json` with 34 routes and 0 failures; `reports/screenshots/manifest.json` with 2 pages × `desktop-chromium`, `mobile-chromium`, `mobile-webkit`; `reports/vitest.json` (Vitest JSON) with passing tests titled `… [expense-entry#1]`, `… [expense-entry#2]`, `… [monthly-report#1]`; `council-report.json` (`round: 1`, `verdict: 'approved-with-warnings'`, `blocking: []`, `warnings: [one correctness item]`, `overridden: false`);
- `builds/c1/`: the same shape, with the Vitest report also passing `… [mileage#1]`, and `council-report.json` `approved`;
- `app/app-profile.json` (`{ schema: 1, modules: ['ocr','xlsx-export','pdf-export'], policy: { outbound: [], residency: 'uk' } }`) and `app/licence-exceptions.json` (`{}`);
- `deployments/test-box.json` through `newDeployment` + `addHistory` (`installed` 1.0.0, the app's first release; then `updated` 1.1.0 from 1.0.0, the change's `minor` release; Contract 7.11) + `saveDeployment`, `currentVersion: '1.1.0'`, `foundation: 'v0.2.0'`.

The helper exports `MUTATIONS = { [name]: (projectDir) => void }`; each breaks exactly one thing:
- `crossing`: one crossing failure;
- `council-blocked`: b1's report `blocked` with 1 blocking item; `council-overridden`: b1's `build.json` `council.overridden: true` (where Plan 8 records an override at the gate);
- `example-failed`: the `[monthly-report#1]` test has status `failed`; `example-missing`: no test carries `[mileage#1]` in c1's report;
- `no-vitest-report`: b1's `checks.reports` lists no Vitest JSON;
- `no-webkit`: page `receipt-check` lacks `mobile-webkit`;
- `outbound`: `app-profile.json` allows `azure-document-intelligence` while the brief allows `[]`;
- `licence`: b1's report has a `legal`/`licences` warning;
- `rolled-back`: the deployment's last outcome is `rolled-back`;
- `wrong-tag`: `project.json` foundation tag `v0.1.0`.

- [ ] **Step 2: Write the failing tests** (`test/acceptance-check.test.js`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkAcceptance, renderResults, CRITERIA } from '../spikes/acceptance/check-acceptance.mjs';
import { makeAcceptanceProject, MUTATIONS } from './helpers/acceptanceProject.js';
import { approvedBrief } from './helpers/briefFixtures.js';

const fx = (name) => makeAcceptanceProject(mkdtempSync(path.join(tmpdir(), 'acc-')), { mutate: name ? MUTATIONS[name] : undefined });
const byId = (r) => Object.fromEntries(r.results.map((x) => [x.id, x]));
const OPTS = { build: 'b1', change: 'c1', deployment: 'test-box' };

test('every criterion is listed once, C1 to C17, with its spec reference', () => {
  assert.deepEqual(CRITERIA.map((c) => c.id), Array.from({ length: 17 }, (_, i) => `C${i + 1}`));
  assert.ok(CRITERIA.every((c) => c.spec && c.title && ['auto', 'operator'].includes(c.how)));
});

test('a good project passes every automated criterion and leaves the rest to the operator', async () => {
  const r = await checkAcceptance(fx(), OPTS);
  const s = byId(r);
  for (const id of ['C1', 'C2', 'C3', 'C6', 'C10', 'C12', 'C13', 'C14', 'C17']) assert.equal(s[id].status, 'pass', `${id}: ${s[id].evidence}`);
  for (const id of ['C4', 'C5', 'C7', 'C8', 'C9', 'C11', 'C15', 'C16']) assert.equal(s[id].status, 'operator');
  assert.equal(r.ok, true);
  assert.match(s.C1.evidence, /34 routes \(foundation 31\), 0 problems/);
  assert.match(s.C3.evidence, /4 of 4 examples proven by passing tests: expense-entry#1, expense-entry#2, monthly-report#1, mileage#1/);
  assert.match(s.C14.evidence, /1 new example \(mileage#1\) proven/);
});

test('each broken thing fails its own criterion, with a plain sentence', async () => {
  const cases = [
    ['crossing', 'C1', /1 problem: /],
    ['council-blocked', 'C2', /blocked, with 1 blocking item/],
    ['council-overridden', 'C2', /the operator overrode the council/],
    ['example-failed', 'C3', /monthly-report#1: its test failed/],
    ['example-missing', 'C14', /mileage#1: no test carries \[mileage#1\]/],
    ['no-webkit', 'C6', /"receipt-check" has no phone screenshot in WebKit/],
    ['outbound', 'C12', /allows azure-document-intelligence, but the brief allows nothing/],
    ['licence', 'C13', /Legal warning about a licence/],
    ['rolled-back', 'C10', /last update was rolled back/],
    ['wrong-tag', 'C17', /built on v0\.1\.0, but this run expects v0\.2\.0/],
  ];
  for (const [name, id, why] of cases) {
    const r = await checkAcceptance(fx(name), OPTS);
    assert.equal(byId(r)[id].status, 'fail', name);
    assert.match(byId(r)[id].evidence, why, name);
    assert.equal(r.ok, false);
  }
});

test('an example without an id is a fail, never a count', async () => {
  const brief = approvedBrief(); brief.features[0].acceptance[0] = { ...brief.features[0].acceptance[0], id: undefined };
  const r = await checkAcceptance(fx(), { ...OPTS, deps: { loadBrief: () => brief } });
  assert.equal(byId(r).C3.status, 'fail');
  assert.match(byId(r).C3.evidence, /has no id, so no test can be traced to it/);
});
test('a missing test report is a fail that says which run and how to supply one', async () => {
  // build.json checks.reports without a Vitest JSON entry
  const r = await checkAcceptance(fx('no-vitest-report'), { build: 'b1' });
  assert.match(byId(r).C3.evidence, /builds\/b1 has no Vitest report in its checks\. Re-run the build's checks, or pass --tests <file> made with: npx vitest run --reporter=json --outputFile=<file>/);
});
test('renderResults gives the operator a table with every criterion', async () => {
  const r = await checkAcceptance(fx(), OPTS);
  const md = renderResults({ slug: 'acme-expenses' }, r.results);
  assert.match(md, /\| C7 \| §2\.3, §2\.5 \|.*\| for the operator \|/);
  assert.equal((md.match(/^\| C\d+ /gm) ?? []).length, 17);
});
test('the CLI exits 2 with usage for bad arguments, 1 on a fail, 0 on a pass', () => {
  const cli = new URL('../spikes/acceptance/check-acceptance.mjs', import.meta.url).pathname;
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  const bad = run(fx());                                   // no --build
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /Usage: node spikes\/acceptance\/check-acceptance\.mjs <projectDir> --build <runId>/);
  assert.equal(run(fx('crossing'), '--build', 'b1', '--change', 'c1', '--deployment', 'test-box').status, 1);
  const good = fx(); const out = path.join(good, 'acceptance', 'checker.md');
  assert.equal(run(good, '--build', 'b1', '--change', 'c1', '--deployment', 'test-box', '--out', out).status, 0);
  assert.match(readFileSync(out, 'utf8'), /^\| C17 /m);
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/acceptance-check.test.js`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `check-acceptance.mjs`**

Plain Node (`node:fs/promises`, `node:path`, `node:util` `parseArgs`) plus the Conductor modules listed under Interfaces, imported by relative path (`../../src/factory/…`). One small function per automated criterion, each returning `{ status, evidence }`:
- the project comes from `loadProject`, the brief from `loadBrief` (or `opts.deps.loadBrief`), the previous brief from `briefPaths(projectDir).json(version - 1)` with `version` from `currentBriefInfo`, the deployment from `loadDeployment`; any of these throwing becomes a `fail` with its plain message;
- example ids come only from `acceptanceIds`, and test tags only from `testTag`, so a change to the tag format in Plan 7 reaches the checker without an edit here;
- a test counts as proving an id when its `fullName` or `title` contains `testTag(id)` and its status is `passed`; if another test with the same tag failed, the example is a FAIL (not reliably proven);
- a missing input file is a `fail` whose evidence names the file and how to make it. JSON is read defensively: a bad file is a `fail`, never a crash.

`--out` writes `renderResults` with `writeFileAtomic` (Plan 7), creating the parent folder first (`mkdir -p`).

- [ ] **Step 5: Write `PROCEDURE.md`, `RESULT-TEMPLATE.md` and `rehearsal-notes.md`**

- `PROCEDURE.md`: the criteria table above; the stages of Tasks 12–15, each as a checklist with the exact commands; the rule that fixes go into the factory (Ruling 9); and where the results live (`<projectsRoot>/<slug>/acceptance/RESULT.md`, never in a repo, because it may name the client).
- `RESULT-TEMPLATE.md`: a header (client slug, dates, foundation tag, Conductor commit, who ran it); one section per stage with the evidence boxes (pasted command output, screenshot file names, timings, costs); a C4 worksheet (the brief's examples, the hand-worked totals, the PDF figure and the spreadsheet figure side by side); a C5 table (receipt, field, proposed value, "Please check" shown?, right?); a list of hand edits for C15 (expected: none); and a verdict line.
- `rehearsal-notes.md`: the fictional meeting notes for Task 12 (below, verbatim).

```markdown
# Meeting notes — Glenmore Joinery Ltd (FICTIONAL, for the dress rehearsal only)

12 staff: 8 joiners on site, 2 office, 1 workshop manager, 1 director (Moira).
They lose receipts. Joiners buy screws, fuel and lunch on their own cards and claim monthly.
Want: snap the receipt on the phone, it fills itself in, they check it, done.
Moira approves each joiner's claims. The workshop manager approves for the workshop lads.
Office staff (Jen) pays out monthly and needs a spreadsheet for the accountant and a PDF per person.
Categories: Materials, Fuel, Subsistence, Tools, Other.
VAT matters, they reclaim it. Most fuel receipts show VAT. Some cafés don't.
Example: a £12.40 taxi with £2.07 VAT should show up in March under Travel — they want a Travel category too.
Example: March for Jamie: £45.00 fuel (VAT £7.50) and £8.75 lunch (VAT £1.46) = £53.75, VAT £8.96.
No cloud stuff — Moira doesn't want receipts going to Google or whoever. Box in the office is fine.
Keep records 6 years (HMRC). When someone leaves, keep their claims but they can't log in.
Backups to the NAS in Moira's house.
Fine with Malcolm logging in remotely to fix things.
```

(The second example's totals: 4500 + 875 = 5375 → £53.75; 750 + 146 = 896 → £8.96.)

- [ ] **Step 6: Run the tests**

Run: `npm test` → PASS (whole Conductor suite).

- [ ] **Step 7: Commit**

```bash
git add spikes/acceptance test/acceptance-check.test.js test/helpers/acceptanceProject.js README.md src/factory/split.js src/factory/build.js test/factory-modules-lift.test.js
git commit -m "feat: acceptance kit for the factory — criteria tied to spec §2, evidence checker, results template, rehearsal notes; builds accept brief modules on foundation v0.2.0+

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
