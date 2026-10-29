# Task 1: Members, options and the project context

This task lays the ground and changes no behaviour:

- **Two new member names.** `design` and `reliability` get a label, an interpreter id prefix and a place in the report order (after Plan 8's `foundation` if that is already in `ORDER`).
- **Tool labels** for every new check, worded exactly as in the index's Shared Interfaces.
- **Options.** `councilGatesTimeoutMs` (40 minutes) caps the local gates of one round, and `councilSmokeTimeoutMs` (40 minutes) caps the machine smoke. `councilTools` now also accepts `axe`: the path to an `axe.min.js` **file**, or `false`.
- **`projectContext`.** This turns the hook's arguments (index A1) into the context the round needs: the build folder, the client name and the foundation `{ repo, tag, commit }` from `project.json` (Plan 7's `loadProject` in `src/factory/projects.js`, index A5), and Plan 8's `checks` (or `null`).
- **No `acceptanceIds` here.** It is Plan 7's (`src/factory/acceptance.js`, Contract 7.1), and reads the examples' stable ids. Task 9 imports it.

**Files:**
- Modify: `src/council/findings.js`, `src/council/interpret.js`, `src/council/report.js`, `src/council/tools.js`, `src/options.js`, `src/council/index.js` (`validateCouncilOptions`)
- Create: `src/council/project.js`, `test/fixtures/council-full/brief.js` (the sample brief, shared by later tasks)
- Test: `test/council-project.test.js` (new), `test/council-findings.test.js` (append, and the `MEMBER_LABEL` `deepEqual` gains the two members), `test/council-round.test.js` (append: options)

**Interfaces:**
- Consumes: `loadProject(dir)` from `src/factory/projects.js` (Plan 7, index A5), imported dynamically inside `projectContext` and injectable for tests. `SLUG_RE`, `RUN_ID_RE` from `src/factory/ids.js` (Plan 8), imported the same way.
- Produces:
  - the labels, prefixes, order and tool labels in the index;
  - `DEFAULT_OPTIONS.councilGatesTimeoutMs = 2400000`, `DEFAULT_OPTIONS.councilSmokeTimeoutMs = 2400000`;
  - `validateCouncilOptions` accepts `councilTools.axe` (a string or `false`; not added to `COUNCIL_TOOLS`, because it is a file, not a binary) and validates both new timeouts like `councilToolTimeoutMs`;
  - `projectContext(args, { loadProject, ids } = {}) -> Promise<ProjectContext>`;
  - `test/fixtures/council-full/brief.js` exports `BRIEF`: the brief below, in Contract 7.4's shapes. Example ids are stable and **not positional**: `mileage-claims` has `#1`, `#2` and `#4` (an earlier `#3` was removed in a revision), so coverage tests prove ids are read, never counted.

- [ ] **Step 1: Write the failing tests**

Create `test/council-project.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectContext } from '../src/council/project.js';
import { BRIEF } from './fixtures/council-full/brief.js';
// BRIEF = { schema: 1, client: 'Acme Ltd', kind: 'web-app',
//   features: [ { id: 'mileage-claims', title: 'Mileage claims', acceptance: [
//       { id: 'mileage-claims#1', given: 'a member', when: 'they claim 120 miles', then: 'the claim is £54.00 at 45p a mile' },
//       { id: 'mileage-claims#2', given: 'a manager', when: 'they open March', then: "they see their team's claims only" },
//       { id: 'mileage-claims#4', given: 'a claim of 0 miles', when: 'it is saved', then: 'it is refused' } ] },
//     { id: 'receipts', title: 'Receipts', acceptance: [] } ],
//   policy: { hosting: 'client-box', outbound: ['cloudflare-tunnel'], residency: 'uk', retention: { text: 'six years', days: 2190 },
//             backupDestination: { kind: 'client-nas', detail: 'the office NAS' }, operatorAccess: true } }

const ARGS = { projectDir: '/p/acme', appDir: '/p/acme/app', sha: 'abc123', brief: BRIEF, policy: BRIEF.policy, runId: 'r1', slug: 'acme' };
const IDS = { SLUG_RE: /^[a-z0-9][a-z0-9-]*$/, RUN_ID_RE: /^[a-z0-9][a-z0-9-]*$/ };   // stand-ins for Plan 8's ids.js
const PROJECT = { schema: 1, slug: 'acme', client: 'Acme Ltd', foundation: { repo: '/root/highland-foundation', tag: 'v0.1.0', commit: 'f00d' }, status: 'building' };

test('projectContext: build folder, client and foundation from project.json', async () => {
  const c = await projectContext(ARGS, { ids: IDS, loadProject: async (dir) => { assert.equal(dir, '/p/acme'); return PROJECT; } });
  assert.equal(c.buildDir, path.join('/p/acme', 'builds', 'r1'));
  assert.equal(c.client, 'Acme Ltd');
  assert.deepEqual(c.foundation, { repo: '/root/highland-foundation', tag: 'v0.1.0', commit: 'f00d' });
  assert.equal(c.brief, BRIEF);
  assert.equal(c.policy, BRIEF.policy);
  assert.equal(c.checks, null);
  assert.equal(c.problem, null);
});

test('projectContext: carries Plan 8\'s checks for the same commit', async () => {
  const checks = { verify: { status: 'passed', summary: 'ok', output: '' }, browser: { status: 'passed', summary: 'ok', output: '' }, reports: ['/p/acme/builds/r1/reports/vitest.json'] };
  const c = await projectContext({ ...ARGS, checks }, { ids: IDS, loadProject: async () => PROJECT });
  assert.equal(c.checks, checks);
});

test('projectContext: a missing policy argument falls back to the brief\'s', async () => {
  const c = await projectContext({ ...ARGS, policy: undefined }, { ids: IDS, loadProject: async () => PROJECT });
  assert.equal(c.policy, BRIEF.policy);
});

test('projectContext: refuses an unsafe run id', async () => {
  await assert.rejects(projectContext({ ...ARGS, runId: '../x' }, { ids: IDS, loadProject: async () => PROJECT }), /The run id "\.\.\/x" cannot be used in a folder name\./);
});

```

Append to `test/council-findings.test.js`:

```js
test('design and reliability are council members with their own labels', () => {
  assert.equal(MEMBER_LABEL.design, 'Design');
  assert.equal(MEMBER_LABEL.reliability, 'Reliability');
  assert.equal(makeFinding({ member: 'design', tool: 'page-gate', grade: 'blocking', title: 'x' }).maxGrade, 'blocking');
  assert.equal(makeFinding({ member: 'reliability', grade: 'blocking', title: 'no tool' }).grade, 'warning');
});
```

Append to `test/council-round.test.js`:
- `validateCouncilOptions({ ...DEFAULT_OPTIONS, council: true, councilTools: { axe: '/x/axe.min.js', semgrep: false } })` does not throw;
- `councilTools: { axe: true }` throws the existing "must map a tool name to a path or false" message;
- `councilSmokeTimeoutMs: 0` (with `council: true`) throws `/councilSmokeTimeoutMs must be a whole number of milliseconds above 0/`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/council-project.test.js test/council-findings.test.js test/council-round.test.js`
Expected: FAIL (`Cannot find module '../src/council/project.js'`, missing labels, unknown tool `axe`).

- [ ] **Step 3: Implement**

- Add the labels, prefixes, order and `TOOL_LABEL` entries.
- Add the two options to `src/options.js`, each with a one-line comment.
- In `validateCouncilOptions`, allow the key `axe` and check both timeouts.
- `src/council/project.js`:
  - `projectContext(args, { loadProject, ids } = {})`:
    - `loadProject ??= (await import('../factory/projects.js')).loadProject`;
    - check `slug` against `SLUG_RE` and `runId` against `RUN_ID_RE` (Plan 8's `src/factory/ids.js`, Contract 7.1; `ids ??= await import('../factory/ids.js')`, injectable as the second argument's `ids`), else throw `The run id "<v>" cannot be used in a folder name.` (or `The project name "<v>" …`). No local copy of either pattern;
    - return the `ProjectContext` shape with `buildDir = path.join(projectDir, 'builds', runId)`, `client = project.client ?? brief.client`, `policy = args.policy ?? args.brief?.policy ?? null`, `checks = args.checks ?? null` and `problem: null`. Task 3 may supply a problem; Task 12 merges it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-project.test.js test/council-findings.test.js test/council-round.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/project.js src/council/findings.js src/council/interpret.js src/council/report.js src/council/tools.js src/council/index.js src/options.js test/fixtures/council-full/brief.js test/council-project.test.js test/council-findings.test.js test/council-round.test.js
git commit -m "feat(council): design and reliability members, gate and smoke timeouts, project context for client builds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
