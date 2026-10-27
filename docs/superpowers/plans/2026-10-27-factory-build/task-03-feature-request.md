# Task 3: Feature requests and the fixed first step

Each feature run gets a request built **by code** from the brief: the feature's own slice of the brief, its worked examples with their tags, the other features by id only, the data policy and the foundation's mandatory rules (index Rulings 2, 3, 5). It must fit `REQUEST_BUDGET` (7000 characters), because `prompts.js` clips every request at 8000.

The run loop gains one additive option, `firstChunk`: a step decided in advance that always runs first. The author plans only the steps after it. For a feature it is `Acceptance tests`.

**Files:**
- Create: `src/factory/featureRequest.js`
- Modify: `src/options.js` (`firstChunk: null`), `src/planPhase.js` (put `firstChunk` first; `validateFirstChunk`), `src/prompts.js` (`planAuthor`/`planReview` mention it), `src/conductor.js` (`runTask` and `resume` call `validateFirstChunk`)
- Test: `test/factory-request.test.js` (new), `test/planPhase.test.js` (append)

**Interfaces:**
- Consumes: `sampleBrief` (Task 1); `clip` (`src/text.js`); `testTag` (`src/factory/acceptance.js`, Plan 7, Contract 7 §7.1); `OUTBOUND_SERVICES` (`src/factory/outbound.js`, Plan 7, Contract 7 §7.4).
- Produces: `REQUEST_BUDGET = 7000`, `BUILDING_ON_RULES`, `featureRequest({ brief, units, index }) -> string` (throws an `Error` with `code: 'too-long'` over budget), `acceptanceStep({ brief, unit }) -> { title: 'Acceptance tests', instructions } | null`, `briefFeatureOf(brief, id)`, `exampleById(brief, id) -> { feature, example } | null`; option `firstChunk`; `validateFirstChunk(options)` (throws plain English).

- [ ] **Step 1: Write the failing tests**

Create `test/factory-request.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { featureRequest, acceptanceStep, REQUEST_BUDGET, BUILDING_ON_RULES } from '../src/factory/featureRequest.js';
import { sampleBrief } from './helpers/factoryFixtures.js';

const units = [
  { id: 'expenses', title: 'Submit and list expenses', covers: ['submit-expense'], acceptance: ['submit-expense#1', 'submit-expense#2'], instructions: 'Add the expense record, its API and its pages.', dependsOn: [], kind: 'feature' },
  { id: 'report', title: 'Monthly report', covers: ['monthly-report'], acceptance: ['monthly-report#1'], instructions: 'Add the monthly report page.', dependsOn: ['expenses'], kind: 'feature' },
];

test('the request carries the slice of the brief, the tagged examples, the policy and the foundation rules', () => {
  const r = featureRequest({ brief: sampleBrief(), units, index: 1 });
  assert.match(r, /^Build step 2 of 2 for Acme Ltd: Monthly report \(report\)/);
  assert.match(r, /Office manager → manager/);
  assert.match(r, /\[monthly-report#1\] Given two Travel expenses of £12\.40 and £7\.60 in March, when a manager opens March, then Travel shows £20\.00/);
  assert.doesNotMatch(r, /submit-expense#1\]/, 'only this feature\'s examples');
  assert.match(r, /Already built \(read the code, do not rebuild\): expenses/);
  assert.match(r, /Data policy: .*nowhere outside the app/);
  const tunnel = sampleBrief({ policy: { ...sampleBrief().policy, outbound: ['cloudflare-tunnel'] } });
  assert.match(featureRequest({ brief: tunnel, units, index: 1 }), /data may go only to [^;]*\(cloudflare-tunnel\)/, 'outbound ids are shown with their label');
  assert.ok(r.includes(BUILDING_ON_RULES));
  assert.ok(r.length <= REQUEST_BUDGET);
});

test('long brief text is clipped; an over-long request is refused with code too-long', () => {
  const brief = sampleBrief();
  brief.features[0].story = 'x'.repeat(20000);
  assert.ok(featureRequest({ brief, units, index: 0 }).length <= REQUEST_BUDGET);
  const huge = [{ ...units[0], instructions: 'y'.repeat(7000) }];
  assert.throws(() => featureRequest({ brief, units: huge, index: 0 }), (e) => e.code === 'too-long' && /request for "expenses" is \d+ characters \(the limit is 7000\)/.test(e.message));
});

test('the fixed first step writes only the tagged tests and tells the reviewer they fail for now', () => {
  const s = acceptanceStep({ brief: sampleBrief(), unit: units[0] });
  assert.equal(s.title, 'Acceptance tests');
  assert.match(s.instructions, /\[submit-expense#1\]/);
  assert.match(s.instructions, /\[submit-expense#2\]/);
  assert.match(s.instructions, /expected to FAIL now/);
  assert.match(s.instructions, /Reviewer: do not block because these tests fail/);
  assert.equal(acceptanceStep({ brief: sampleBrief(), unit: { ...units[0], acceptance: [], kind: 'fix' } }), null);
});

test('examples are found by their stable id, not their position', () => {
  const brief = sampleBrief();
  brief.features[0].acceptance = [brief.features[0].acceptance[1]];          // #1 was removed in a revision; #2 keeps its id
  const s = acceptanceStep({ brief, unit: { ...units[0], acceptance: ['submit-expense#2'] } });
  assert.match(s.instructions, /\[submit-expense#2\] Given a member, when they submit a negative amount/);
});
```

Append to `test/planPhase.test.js`:

```js
const FIRST = { title: 'Acceptance tests', instructions: 'write the tagged tests' };

test('firstChunk: the author plans the rest, the fixed step comes first, and the limit counts it', async () => {
  const many = { summary: 'S', chunks: Array.from({ length: 12 }, (_, i) => ({ title: `C${i}`, instructions: 'x' })) };
  const t = team({
    author: (role, task, c, o, n) => (n === 0 ? { text: '```json\n' + JSON.stringify(many) + '\n```' } : planReply()),
    reviewer: approve,
  });
  const r = await runPlanPhase(await makeCtx({ team: t, options: { firstChunk: FIRST } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plan.chunks.map((c) => c.title), ['Acceptance tests', 'A']);
  assert.match(t.author.calls[0].task, /Step 1 is already fixed and runs first:\nAcceptance tests: write the tagged tests/);
  assert.match(t.author.calls[0].task, /At most 11 chunks/);
  assert.match(t.author.calls[1].task, /plan has 12 chunks \(max 11\)/);
  assert.match(t.reviewer.calls[0].task, /Step 1, fixed in advance: Acceptance tests/);
});

test('validateFirstChunk refuses a malformed fixed step', async () => {
  const { validateFirstChunk } = await import('../src/planPhase.js');
  assert.doesNotThrow(() => validateFirstChunk({ firstChunk: null }));
  assert.throws(() => validateFirstChunk({ firstChunk: { title: '' } }), /firstChunk needs a title and instructions/);
});
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `node --test test/factory-request.test.js test/planPhase.test.js`
Expected: FAIL (module missing; the planPhase tests fail on the chunk titles).

- [ ] **Step 3: Implement `src/factory/featureRequest.js`**

`BUILDING_ON_RULES` is this exact text (it is the compact copy of BUILDING-ON "Adding a feature" that Ruling 5 refers to):

```
Foundation rules. This app is built on the Highland foundation: read docs/BUILDING-ON.md before you start and copy the notes feature.
- Shared schemas in packages/shared/src/schemas.ts with z.strictObject; build the update schema from a base with no defaults.
- One table per record type with owner_id and team_id set from the signed-in actor, never from the request; then npm -w @hf/server run db:generate and commit the migration.
- An actor-first repository: every query filters with visibleTo; not seen means 404, seen but not allowed means 403; validate list cursors; no audit row for a change that changes nothing.
- Routes only through defineRoute with a permission; new permissions go in PERMISSIONS in packages/shared/src/access.ts. Never add a role.
- Audit in the same transaction, recording field names only.
- Crossing cases by hand in apps/server/test/crossing/cases.ts (EXPECTED_ROLES typed by hand, forbiddenFields, paginate), a resource seeder in apps/server/test/crossing/resources/, and oracle.ts updated by hand when visibility changes.
- Pages from the house components in apps/web/src/ui, a route in routes.tsx, an APP_PATHS entry, a PAGES entry in apps/web/e2e/pages.ts, and a NAV entry if it belongs in the menu.
- A demo seeder in apps/server/src/seed/seeders/ using ctx.faker.
- Money in whole pence with the rounding rule written as a test; dates stored in UTC and shown in Europe/London.
- Never edit foundation.json, the crossing harness (harness.ts, world.ts, report.ts), the licence check, the lint or test configs, or the verify script. Never skip or focus a test.
- npm run verify is the test command and must pass when the feature is finished.
```

`featureRequest` assembles these blocks, in order, joined by blank lines (exact headings as in the test):
1. `Build step <i+1> of <n> for <client>: <title> (<id>)`
2. `About the app: <clip(purpose, 600)>`
3. `People who use it (each maps to a foundation role):` then `- <name> → <mapsTo>: <clip(whatTheyDo, 160)>` per role
4. `What to build in this step:\n<instructions>`
5. Only when `covers` is non-empty: `From the client's brief:` then per covered feature `- <title> (<id>): <clip(story, 700)>` and `  Used by: <roles>. Records: <data>.`
6. Only when `acceptance` is non-empty: `Worked examples (each must become a test whose name contains its tag; step 1 writes them):` then `- <testTag(id)> Given <given>, when <when>, then <then>` (each part clipped to 300). Each example is found with `exampleById(brief, id)`, which matches `example.id` (Contract 7 §7.4), never a position.
7. `Already built (read the code, do not rebuild): <ids of units before i, comma-separated, or "nothing yet">` and `Coming later (do not build now): <ids after i, or "nothing">`
8. `Data policy: hosting on <client's own box|a server the operator runs>; data may go only to <each outbound id as "<OUTBOUND_SERVICES[id].label> (<id>)", joined by ", "> | nowhere outside the app (no outside services); data stays in <the UK|the UK or EU|any country>.`
9. `BUILDING_ON_RULES`

Over `REQUEST_BUDGET`: throw `Object.assign(new Error(\`the request for "<id>" is <length> characters (the limit is 7000); make its instructions shorter or split it\`), { code: 'too-long' })`.

`acceptanceStep` returns `null` when `unit.acceptance` is empty; otherwise title `Acceptance tests` and instructions:

```
Write the acceptance tests for "<title>" and nothing else: one test per worked example below, with its tag in square brackets in the test's name, for example it('<testTag(first id)> …'). Server behaviour goes in apps/server/test/<unit id>/ as integration tests against the API, like apps/server/test/notes.test.ts; pure calculations may be unit tests beside them. Use the exact values from the examples (money in whole pence). Do not write any feature code. Do not skip, focus or mark any test as todo. These tests are expected to FAIL now, because the feature does not exist yet; the later steps make them pass.
Reviewer: do not block because these tests fail. Block if an example is missing or encoded wrongly, if a tag is missing, or if anything other than tests was changed.
Examples:
- [<id>] Given …, when …, then …
```

- [ ] **Step 4: Add the `firstChunk` option**

- `src/options.js`: `firstChunk: null, // { title, instructions }: a step decided in advance that runs first; the author plans the rest (factory features)`.
- `src/planPhase.js`: export `validateFirstChunk(o)`: `null`/`undefined` passes; otherwise both fields must be non-empty strings, else throw `options.firstChunk needs a title and instructions`. In `runPlanPhase`, `const first = options.firstChunk ?? null; const limit = first ? options.maxChunks - 1 : options.maxChunks;` pass `maxChunks: limit, firstChunk: first` to `prompts.planAuthor`, `parsePlan(r.text, { maxChunks: limit })`, and `firstChunk: first` to `prompts.planReview`. Every plan this function returns (approved, settled or operator-approved) becomes `{ ...plan, chunks: [first, ...plan.chunks] }` when `first` is set (one helper, used at the three return points).
- `src/prompts.js`: `planAuthor` gains `firstChunk = null`; when set, add after the "You are planning" paragraph: `Step 1 is already fixed and runs first:\n<title>: <show(instructions, 3000)>\nPlan only the steps after it; do not repeat it.` (`At most ${maxChunks} chunks.` then shows the reduced number). `planReview` gains `firstChunk = null`; when set, add `Step 1, fixed in advance: <title>\n<show(instructions, 3000)>` before the proposed plan.
- `src/conductor.js`: call `validateFirstChunk(opts)` in `runTask` and `resume`, next to `validateCouncilOptions`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/factory-request.test.js test/planPhase.test.js && npm test`
Expected: PASS; the existing suite is unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/factory/featureRequest.js src/options.js src/planPhase.js src/prompts.js src/conductor.js test/factory-request.test.js test/planPhase.test.js
git commit -m "feat(factory): size-checked feature requests and a fixed first step

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
