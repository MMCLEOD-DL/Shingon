# Task 1: Members, options and the project context

This task lays the ground and changes no behaviour:

- **Two new member names.** `design` and `reliability` get a label, an interpreter id prefix and a place in the report order (after Plan 8's `foundation` if that is already in `ORDER`).
- **Tool labels** for every new check, worded exactly as in the index's Shared Interfaces.
- **Options.** `councilGatesTimeoutMs` (40 minutes) caps the local gates of one round, and `councilSmokeTimeoutMs` (40 minutes) caps the machine smoke. `councilTools` now also accepts `axe`: the path to an `axe.min.js` **file**, or `false`.
- **`projectContext`.** This turns the hook's arguments (index A1) into the context the round needs: the build folder, the client name and the foundation `{ repo, tag, commit }` from `project.json` (Plan 7's `loadProject`, index A5).
- **`acceptanceIds`.** This numbers the brief's worked examples the way Plan 8 tags tests (index Ruling 8).

**Files:**
- Modify: `src/council/findings.js`, `src/council/interpret.js`, `src/council/report.js`, `src/council/tools.js`, `src/options.js`, `src/council/index.js` (`validateCouncilOptions`)
- Create: `src/council/project.js`, `test/fixtures/council-full/brief.js` (the sample brief, shared by later tasks)
- Test: `test/council-project.test.js` (new), `test/council-findings.test.js` (append, and the `MEMBER_LABEL` `deepEqual` gains the two members), `test/council-round.test.js` (append: options)

**Interfaces:**
- Consumes: `loadProject(projectDir)` from `src/factory/project.js` (index A5), imported dynamically inside `projectContext` and injectable for tests.
- Produces:
  - the labels, prefixes, order and tool labels in the index;
  - `DEFAULT_OPTIONS.councilGatesTimeoutMs = 2400000`, `DEFAULT_OPTIONS.councilSmokeTimeoutMs = 2400000`;
  - `validateCouncilOptions` accepts `councilTools.axe` (a string or `false`; not added to `COUNCIL_TOOLS`, because it is a file, not a binary) and validates both new timeouts like `councilToolTimeoutMs`;
  - `projectContext(args, { loadProject } = {}) -> Promise<ProjectContext>`;
  - `acceptanceIds(brief) -> [{ id, featureId, n, title, example }]`;
  - `test/fixtures/council-full/brief.js` exports `BRIEF`: the brief below, with `mileage-claims` carrying a third example `{ given: 'a claim of 0 miles', when: 'it is saved', then: 'it is refused' }`.

- [ ] **Step 1: Write the failing tests**

Create `test/council-project.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { projectContext, acceptanceIds } from '../src/council/project.js';
import { BRIEF } from './fixtures/council-full/brief.js';
// BRIEF = { schema: 1, client: 'Acme Ltd', kind: 'web-app',
//   features: [ { id: 'mileage-claims', title: 'Mileage claims', acceptance: [
//       { given: 'a member', when: 'they claim 120 miles', then: 'the claim is £54.00 at 45p a mile' },
//       { given: 'a manager', when: 'they open March', then: "they see their team's claims only" },
//       { given: 'a claim of 0 miles', when: 'it is saved', then: 'it is refused' } ] },
//     { id: 'receipts', title: 'Receipts', acceptance: [] } ],
//   policy: { hosting: 'client-box', outbound: [], residency: 'uk', retention: { text: 'six years', days: 2190 }, backupDestination: 'client-nas', operatorAccess: true } }

const ARGS = { projectDir: '/p/acme', appDir: '/p/acme/app', sha: 'abc123', brief: BRIEF, policy: BRIEF.policy, runId: 'r1', slug: 'acme' };
const PROJECT = { schema: 1, slug: 'acme', client: 'Acme Ltd', foundation: { repo: '/root/highland-foundation', tag: 'v0.1.0', commit: 'f00d' }, status: 'building' };

test('projectContext: build folder, client and foundation from project.json', async () => {
  const c = await projectContext(ARGS, { loadProject: async (dir) => { assert.equal(dir, '/p/acme'); return PROJECT; } });
  assert.equal(c.buildDir, path.join('/p/acme', 'builds', 'r1'));
  assert.equal(c.client, 'Acme Ltd');
  assert.deepEqual(c.foundation, { repo: '/root/highland-foundation', tag: 'v0.1.0', commit: 'f00d' });
  assert.equal(c.brief, BRIEF);
  assert.equal(c.policy, BRIEF.policy);
  assert.equal(c.problem, null);
});

test('projectContext: a missing policy argument falls back to the brief\'s', async () => {
  const c = await projectContext({ ...ARGS, policy: undefined }, { loadProject: async () => PROJECT });
  assert.equal(c.policy, BRIEF.policy);
});

test('projectContext: refuses an unsafe run id', async () => {
  await assert.rejects(projectContext({ ...ARGS, runId: '../x' }, { loadProject: async () => PROJECT }), /The run id "\.\.\/x" cannot be used in a folder name\./);
});

test('acceptanceIds numbers each feature\'s examples from 1', () => {
  assert.deepEqual(acceptanceIds(BRIEF).map((a) => a.id), ['mileage-claims#1', 'mileage-claims#2', 'mileage-claims#3']);
  assert.equal(acceptanceIds(BRIEF)[0].example.then, 'the claim is £54.00 at 45p a mile');
  assert.equal(acceptanceIds(BRIEF)[1].title, 'Mileage claims');
  assert.deepEqual(acceptanceIds(null), []);
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
  - `projectContext(args, { loadProject } = {})`:
    - `loadProject ??= (await import('../factory/project.js')).loadProject`;
    - check `slug` and `runId` against `/^[a-z0-9][a-z0-9-]{0,63}$/i`, else throw `The run id "<v>" cannot be used in a folder name.` (or `The project name "<v>" …`);
    - return the `ProjectContext` shape with `buildDir = path.join(projectDir, 'builds', runId)`, `client = project.client ?? brief.client`, `policy = args.policy ?? args.brief?.policy ?? null` and `problem: null`. Task 3 may supply a problem; Task 12 merges it.
  - `acceptanceIds(brief)`: features in order, examples numbered from 1, `id = `${feature.id}#${n}``.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/council-project.test.js test/council-findings.test.js test/council-round.test.js && npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/council/project.js src/council/findings.js src/council/interpret.js src/council/report.js src/council/tools.js src/council/index.js src/options.js test/fixtures/council-full/brief.js test/council-project.test.js test/council-findings.test.js test/council-round.test.js
git commit -m "feat(council): design and reliability members, gate and smoke timeouts, project context for client builds"
```
