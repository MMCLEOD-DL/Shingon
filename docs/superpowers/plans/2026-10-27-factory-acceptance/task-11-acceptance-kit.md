# Task 11: Acceptance kit (Conductor)

**Repo: `/root/conductor`, branch `plan12-acceptance` from `master`. Zero dependencies, `npm test` (`node --test`).**

The acceptance test (spec §8 item 9) is run by the operator over several sessions (Tasks 12–15). This task gives him three things:
- **the criteria**, each tied to spec §2 and marked automated or operator-checked;
- **a checker**, `check-acceptance.mjs`, that reads the project folder (Contract 1) and the app's own reports and fills in every automated criterion with its evidence;
- **a results template** for everything a person must see with their own eyes (real phones, alerts, a restore).

The checker never builds, deploys or calls a model. It only reads files.

**Files:**
- Create: `spikes/acceptance/check-acceptance.mjs`, `spikes/acceptance/PROCEDURE.md`, `spikes/acceptance/RESULT-TEMPLATE.md`, `spikes/acceptance/rehearsal-notes.md`
- Create: `test/acceptance-check.test.js`, `test/fixtures/acceptance/` (two small project folders, `pass/` and `fail/`, built by hand from the shapes below)
- Modify: `README.md` (one paragraph under the factory section, pointing to `spikes/acceptance/PROCEDURE.md`)

**Interfaces:**
- Consumes (file shapes only):
  - Contract 1 project folder: `project.json`, `brief/current.json`, `app/`, `builds/<runId>/`, `deployments/<name>.json`;
  - Contract 2 brief fields: `features[].acceptance[]`, `modules`, `policy`;
  - Contract 4 deployment JSON (`history[].outcome`, `currentVersion`, `foundation`);
  - the foundation's reports: `app/apps/server/reports/crossing.json` (`{ routes, checks, failures[] }`), `app/reports/screenshots/manifest.json` (entries `{ page, path, project, width, height, file }`), `app/app-profile.json` (Task 1);
  - Plan 5's `CouncilReport` (`verdict`, `blocking[]`, `overridden`), at `builds/<runId>/council-report.json` or `--council <file>` (Contract gap 7);
  - a Vitest JSON report at `app/reports/test-results.json`, made by the operator with `npx vitest run --reporter=json --outputFile=reports/test-results.json` in `app/`.
- Produces:

```js
// spikes/acceptance/check-acceptance.mjs
export const CRITERIA          // [{ id: 'C1', spec: '§2.1', title, how: 'auto' | 'operator' }]
export async function checkAcceptance(projectDir, opts) -> { results: [{ id, status: 'pass' | 'fail' | 'operator', evidence: string }], ok: boolean }
//   opts = { build: runId, change?: runId, deployment?: name, council?: file, changeCouncil?: file, foundationTag?: 'v0.2.0' }
export function renderResults(project, results) -> string   // Markdown: the criteria table with status and evidence
// CLI: node spikes/acceptance/check-acceptance.mjs <projectDir> --build <runId> [--change <runId>] [--deployment <name>]
//        [--council <file>] [--change-council <file>] [--out <file>]
//      exit 0 when every automated criterion passes, 1 otherwise, 2 for bad arguments (plain-English usage)
```

## The criteria (written into `CRITERIA` and `PROCEDURE.md` word for word)

| Id | Spec | Criterion | How |
|---|---|---|---|
| C1 | §2.1 | The role-crossing harness ran on the finished build: `crossing.json` has 0 failures and at least 29 routes (the foundation's 28 plus at least one expenses route). | auto |
| C2 | §2.1, §4.3 | The final council report for the build has verdict `approved` or `approved-with-warnings`, no blocking items, and was **not** overridden. | auto |
| C3 | §2.2 | Every acceptance example in the approved brief is proven by a passing test. With example ids (Contract gap 6), each `[ex:<id>]` appears in a passing test's name in `test-results.json`. Without ids: the number of passing tests tagged `[ex:` is at least the number of examples, and the result says "counted, not traced". | auto |
| C4 | §2.2 | The app's March report, downloaded from the preview as PDF and as a spreadsheet, shows exactly the totals worked out by hand from the brief's examples. | operator |
| C5 | §2.2, §2.5 | On the 10 fictional printed receipts, photographed through the app on a real phone, no field is ever filled in confidently wrong (no "Please check" missing on a wrong value). | operator |
| C6 | §2.3 | Every page has a screenshot at desktop width and phone width in Chromium and WebKit (`manifest.json`: every page has `desktop-chromium`, `mobile-chromium` and `mobile-webkit`). | auto |
| C7 | §2.3, §2.5 | On a real iPhone (Safari) and a real Android phone (Chrome): **Take a photo** opens the camera and uploads; **Choose a file** uploads a photo from the library and a PDF; the reading appears; correcting a field and confirming works; nothing scrolls sideways. | operator |
| C8 | §2.4 | On the test box: a manual backup, then `restore-test`, pass; then a real restore drill from the runbook returns a record count known beforehand. | operator |
| C9 | §2.4 | Stopping the app container sends a Matrix alert within 5 minutes, and starting it sends the recovery message. | operator |
| C10 | §2.4, §4.8 | The change request went out as an **update**: the deployment's `history` ends with outcome `updated` at a newer `currentVersion`, after the first ship. | auto |
| C11 | §2.5 | A member gets from "open the app" to a confirmed receipt in under 60 seconds on a phone, with no step that needs help. | operator |
| C12 | §3, §6 | The app's `app-profile.json` matches the approved brief: `policy.outbound` and `residency` are equal, and `modules` contains every module the brief lists (here `ocr`). (Task 14 also checks `OCR_ENGINE=local` on the box by hand.) | auto |
| C13 | §5a | The final council report has no blocking or warning Legal item about a licence, and every entry in the app's `licence-exceptions.json` has a reason. | auto |
| C14 | §4.8 | The change request's own council report meets C2, and its new acceptance examples meet C3. | auto |
| C15 | §1 | The operator never edited the app's code by hand (Ruling 9). Any hand edit is recorded with its reason, and counts as a FAIL for the factory. | operator |
| C16 | §3 | No paid-API spend unless opted in; frontier cost recorded per stage. | operator |
| C17 | Contract 1 | `project.json` records `foundation.tag` equal to the expected tag (`v0.2.0` by default) and status `shipped` at the end. | auto |

**Verdict:** the acceptance test **passes** only when every criterion passes. Any FAIL means fixing the factory (Ruling 9) and re-running the stage it belongs to.

- [ ] **Step 1: Write the fixtures**

`test/fixtures/acceptance/pass/` is a minimal project:
- `project.json` with status `shipped` and foundation tag `v0.2.0`;
- `brief/current.json` with 2 features, 3 acceptance examples with ids `expense-entry#1`, `expense-entry#2`, `monthly-report#1`, `modules: ["ocr","xlsx-export","pdf-export"]` and `policy.outbound: []`;
- `app/apps/server/reports/crossing.json` with 31 routes and 0 failures;
- `app/reports/screenshots/manifest.json` with 2 pages × 3 projects;
- `app/reports/test-results.json`, Vitest JSON with three passing tests whose names contain the three `[ex:…]` tags;
- `app/app-profile.json` (`modules: ["ocr","xlsx-export","pdf-export"]`, `outbound: []`, `residency: "uk"`) and `app/licence-exceptions.json` (`{}`);
- `builds/b1/council-report.json` (`approved-with-warnings`, `blocking: []`, `overridden: false`) and `builds/c1/council-report.json` (`approved`);
- `deployments/test-box.json` with history `[{ outcome: 'updated', version: '0.1.0' }, { outcome: 'updated', version: '0.1.1' }]` and `currentVersion: '0.1.1'`.

`fail/` copies `pass/`, then breaks one thing per criterion:
- a crossing failure;
- a council report that is `blocked` and another that is `overridden: true`;
- one example tag whose test failed;
- a page missing `mobile-webkit`;
- `outbound: ["azure-document-intelligence"]` while the brief says `[]`;
- a deployment whose last outcome is `rolled-back`.

Each broken case is its own small folder under `fail/`, so each test breaks exactly one thing.

- [ ] **Step 2: Write the failing tests** (`test/acceptance-check.test.js`)

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkAcceptance, renderResults, CRITERIA } from '../spikes/acceptance/check-acceptance.mjs';

const fx = (p) => new URL(`./fixtures/acceptance/${p}`, import.meta.url).pathname;
const byId = (r) => Object.fromEntries(r.results.map((x) => [x.id, x]));

test('every criterion is listed once, C1 to C17, with its spec reference', () => {
  assert.deepEqual(CRITERIA.map((c) => c.id), Array.from({ length: 17 }, (_, i) => `C${i + 1}`));
  assert.ok(CRITERIA.every((c) => c.spec && c.title && ['auto', 'operator'].includes(c.how)));
});

test('a good project passes every automated criterion and leaves the rest to the operator', async () => {
  const r = await checkAcceptance(fx('pass'), { build: 'b1', change: 'c1', deployment: 'test-box' });
  const s = byId(r);
  for (const id of ['C1', 'C2', 'C3', 'C6', 'C10', 'C12', 'C13', 'C14', 'C17']) assert.equal(s[id].status, 'pass', `${id}: ${s[id].evidence}`);
  for (const id of ['C4', 'C5', 'C7', 'C8', 'C9', 'C11', 'C15', 'C16']) assert.equal(s[id].status, 'operator');
  assert.equal(r.ok, true);
  assert.match(s.C1.evidence, /31 routes, 0 problems/);
  assert.match(s.C3.evidence, /3 of 3 examples proven by passing tests/);
});

test('each broken thing fails its own criterion, with a plain sentence', async () => {
  const cases = [
    ['fail/crossing', 'C1', /1 problem: /],
    ['fail/council-blocked', 'C2', /blocked, with 1 blocking item/],
    ['fail/council-overridden', 'C2', /the operator overrode the council/],
    ['fail/example-failed', 'C3', /monthly-report#1 .* failed/],
    ['fail/no-webkit', 'C6', /"receipt-check" has no phone screenshot in WebKit/],
    ['fail/outbound', 'C12', /allows azure-document-intelligence, but the brief allows nothing/],
    ['fail/rolled-back', 'C10', /last update was rolled back/],
  ];
  for (const [dir, id, why] of cases) {
    const r = await checkAcceptance(fx(dir), { build: 'b1', change: 'c1', deployment: 'test-box' });
    assert.equal(byId(r)[id].status, 'fail', dir);
    assert.match(byId(r)[id].evidence, why, dir);
    assert.equal(r.ok, false);
  }
});

test('examples without ids are counted, not traced, and say so', async () => { /* brief examples without id -> C3 pass with "counted, not traced" */ });
test('a missing report is a fail that says which file and how to make it', async () => {
  /* no test-results.json -> C3 fail: "app/reports/test-results.json is missing. In app/, run: npx vitest run --reporter=json --outputFile=reports/test-results.json" */
});
test('renderResults gives the operator a table with every criterion', async () => {
  const r = await checkAcceptance(fx('pass'), { build: 'b1', change: 'c1', deployment: 'test-box' });
  const md = renderResults({ slug: 'acme-expenses' }, r.results);
  assert.match(md, /\| C7 \| §2\.3, §2\.5 \|.*\| for the operator \|/);
  assert.equal((md.match(/^\| C\d+ /gm) ?? []).length, 17);
});
test('the CLI exits 2 with usage for bad arguments, 1 on a fail, 0 on a pass', async () => { /* spawn node with execFile */ });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `node --test test/acceptance-check.test.js`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement `check-acceptance.mjs`**

Plain Node (`node:fs/promises`, `node:path`, `node:util` `parseArgs`). One small function per automated criterion, each returning `{ status, evidence }`; a missing input file is a `fail` whose evidence names the file and the command that makes it. JSON is read defensively: a bad file is a `fail`, never a crash. `--out` writes `renderResults` to the file atomically (temp file, then rename, as Contract 1 asks).

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
git add spikes/acceptance test/acceptance-check.test.js test/fixtures/acceptance README.md
git commit -m "feat: acceptance kit for the factory — criteria tied to spec §2, evidence checker, results template, rehearsal notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
