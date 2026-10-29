# Task 3: Brief delta and build units

A change starts from a new approved brief version (Plan 7's session in `revise` mode). This task:
- works out **what changed** between the brief the app was built from and the new one;
- refuses what is not a change request (index Rulings 1–3);
- turns the rest into Plan 8 `Unit`s, which go to `runBuild` as `options.change.units` (Task 4);
- writes the plain-English description shown at the gate, and the line that goes into the app's changelog.

**Example ids are stable** (Contract 7.4). Plan 7 gives every acceptance example `id: '<featureId>#<n>'`. An unchanged example keeps its id, a new or reworded one takes the next unused `n`, and an `n` is never reused. So the delta compares examples **by id**:
- an id only in the new brief is an example to prove with a new test;
- an id only in the old brief is **retired**, and only the tests tagged with exactly that id (`testTag(id)`) may be changed or removed;
- tests for every other example stay as they are, however the brief was reordered.

Everything here is pure (no files, no git), so it is tested directly.

**Files:**
- Create: `src/factory/change/delta.js`
- Test: `test/factory-change-delta.test.js`

**Interfaces:**
- Consumes:
  - the Brief shape from Contract 2 and Contract 7.4: `client`, `purpose`, `kind`, `roles[]`, `features[]` (each with `acceptance[]` examples carrying `id`), `outputs[]`, `integrations[]`, `modules[]`, `policy{}` (`outbound` ids, `residency`, `retention: { text, days }`, `backupDestination: { kind, detail }`), `openQuestions`, `approvedAt`, `approvedBy`, and Plan 7's meta fields;
  - `acceptanceIds`, `testTag` (Plan 7 `acceptance.js`); `MAX_INSTRUCTIONS` and the `Unit` shape (Plan 8 `split.js`); `OUTBOUND_SERVICES` labels (Plan 7 `outbound.js`) for `deltaText`.
- Produces:
  - `briefDelta(prev, next) -> Delta`:
    ```js
    Delta = {
      fromVersion, toVersion,                      // prev.version, next.version (Plan 7 meta)
      features: { added: Feature[], changed: [{ before, after, fields: string[], examples: { added: string[], retired: string[] } }], removed: Feature[] },
      roles: { added: Role[], removed: Role[], changed: [{ before, after }] },     // keyed by name
      outputs: { added, removed }, integrations: { added, removed }, modules: { added: string[], removed: string[] },
      policy: [{ field, before, after }],          // top-level policy fields, compared by value
      identity: [{ field, before, after }],        // client, purpose, kind
      reusedIds: string[],                         // example ids present in both briefs whose words differ (a broken brief)
      empty: boolean,
    }
    ```
  - `deltaProblem(delta, prev, next) -> string | null`;
  - `buildUnits(delta, { toVersion }) -> ChangeUnit[]`, where `ChangeUnit = Unit & { change, retire: string[] }`;
  - `profileChanged(delta) -> boolean`;
  - `deltaText(delta) -> string`;
  - `changeChangelogLines(delta, toVersion) -> string[]`;
  - the refusal texts `NOTHING_TO_BUILD`, `KIND_CHANGED`, `HOSTING_CHANGED`, `OPERATOR_ACCESS_REQUIRED`, `EXAMPLE_ID_REUSED(ids)`.

- [ ] **Step 1: Write the failing tests**

Build two briefs with a small helper (`brief({ version, features, roles, policy })`) so each test states only what it changes. Use the expenses example:
- the old brief (v1) has features `submit-receipt` (examples `submit-receipt#1`, `#2`), `monthly-report` (`monthly-report#1`, `#2`) and `paper-upload` (`paper-upload#1`);
- the new brief (v3) adds `mileage-claims` (`mileage-claims#1`), rewords `monthly-report#2` (so it becomes `monthly-report#3` and `#2` is retired), lists `monthly-report` before `submit-receipt`, and removes `paper-upload`.

```js
test('features are matched by id: added, changed (fields and example ids) and removed; reordering alone is no change', () => {
  const d = briefDelta(prev, next);
  assert.deepEqual(d.features.added.map((f) => f.id), ['mileage-claims']);
  assert.deepEqual(d.features.changed.map((c) => [c.after.id, c.fields, c.examples]),
    [['monthly-report', ['acceptance'], { added: ['monthly-report#3'], retired: ['monthly-report#2'] }]]);
  assert.deepEqual(d.features.removed.map((f) => f.id), ['paper-upload']);
  assert.equal(d.empty, false);
});
test('comparison ignores key order, feature order, example order, approval stamps and Plan 7 meta', ...)
  // same brief with keys and features reordered, a new approvedAt and version → empty: true
test('an example id kept with different words is reported, and deltaProblem refuses it', () => {
  // next has monthly-report#1 with a different `then`
  const d = briefDelta(prev, reworded);
  assert.deepEqual(d.reusedIds, ['monthly-report#1']);
  assert.equal(deltaProblem(d, prev, reworded), EXAMPLE_ID_REUSED(['monthly-report#1']));
});
test('roles are matched by name; a changed mapsTo is a role change', ...)
test('policy changes are listed field by field; outbound compares ids', ...)
  // outbound [] → ['azure-document-intelligence'] gives [{ field: 'outbound', before: [], after: ['azure-document-intelligence'] }]
test('deltaProblem refuses: nothing to build, a different kind, a hosting move, operator access withdrawn', () => {
  assert.equal(deltaProblem(briefDelta(prev, prev), prev, prev), NOTHING_TO_BUILD);
  const moved = withPolicy({ hosting: 'operator-server' });
  assert.equal(deltaProblem(briefDelta(prev, moved), prev, moved), HOSTING_CHANGED);
  // kind 'mobile-app' → KIND_CHANGED; operatorAccess false → OPERATOR_ACCESS_REQUIRED
  assert.equal(deltaProblem(briefDelta(prev, next), prev, next), null);
});
test('buildUnits: added and changed features in new-brief order, then removals, then one brief-wide unit', () => {
  const units = buildUnits(briefDelta(prev, nextWithRoleAndOutputChange), { toVersion: 3 });
  assert.deepEqual(units.map((u) => [u.id, u.change, u.kind]), [
    ['change-monthly-report', 'changed', 'feature'], ['mileage-claims', 'added', 'feature'],
    ['remove-paper-upload', 'removed', 'fix'], ['brief-wide-changes', 'brief-wide', 'fix'],
  ]);
  const added = units.find((u) => u.change === 'added');
  assert.deepEqual([added.covers, added.acceptance, added.retire], [['mileage-claims'], ['mileage-claims#1'], []]);
  const changed = units.find((u) => u.change === 'changed');
  assert.deepEqual([changed.covers, changed.acceptance, changed.retire], [['monthly-report'], ['monthly-report#3'], ['monthly-report#2']]);
  assert.match(changed.instructions, /What changed: its worked examples\./);
  assert.match(changed.instructions, /Tests tagged \[monthly-report#2\] prove an example the client no longer wants: change or remove those tests only\./);
  const removal = units.find((u) => u.change === 'removed');
  assert.deepEqual([removal.covers, removal.acceptance, removal.retire], [[], [], ['paper-upload#1']]);
  assert.match(removal.instructions, /Keep its tables and stored files/);
  assert.match(removal.instructions, /do not write a database change that drops or empties anything/);
  assert.match(removal.instructions, /Remove the tests tagged \[paper-upload#1\], and only those/);
  assert.match(removal.instructions, /Add a test that the menu no longer shows Paper upload/);
  for (const u of units) { assert.ok(u.instructions.length <= MAX_INSTRUCTIONS); assert.deepEqual(u.dependsOn, []); }
});
test('a changed feature with no new example is a fix unit with no acceptance ids', ...)
  // only the story changed → kind 'fix', acceptance [], retire []
test('no brief-wide unit when only features changed', ...)
test('profileChanged: true for modules, outbound or residency changes; false for retention or features only', ...)
test('deltaText is plain English the operator can read at the gate', () => {
  assert.equal(deltaText(briefDelta(prev, next)),
    'Added: Mileage claims.\nChanged: Monthly report (its worked examples).\nRemoved: Paper upload (its data is kept).');
});
test('deltaText lists data policy changes under their own heading, with service labels', ...)
  // /Data policy changes:\n  - Outside services allowed: none → Azure Document Intelligence/
test('changeChangelogLines: one line naming the brief version', () => {
  assert.deepEqual(changeChangelogLines(briefDelta(prev, next), 3),
    ['- Change (brief v3): added Mileage claims; changed Monthly report; removed Paper upload.']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-delta.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/delta.js`**

- **Comparison:**
  - Use a canonical JSON with keys sorted recursively.
  - Ignore `approvedAt`, `approvedBy`, `openQuestions` and Plan 7's meta fields (`slug`, `version`, `createdAt`, `revisedFrom`).
  - Features are keyed by `id` and examples by `id`, so order never counts.
- **`changed.fields`** lists the feature fields that differ, in the order `title, story, roles, data, acceptance`. `acceptance` counts as changed when the example id sets differ.
  - `examples.added` and `examples.retired` are id set differences, sorted by `n`.
  - An id in both briefs whose example differs goes to `reusedIds`.
  - Plain names for `deltaText`: `story` → "what it does", `roles` → "who uses it", `data` → "its records", `acceptance` → "its worked examples", `title` → "its name".
- **`empty`** is true when features, roles, outputs, integrations, modules and policy are all unchanged, and `identity` has no `kind` or `client` change.
- **`deltaProblem`** checks, in order: `reusedIds` → `EXAMPLE_ID_REUSED`, then `empty` → `NOTHING_TO_BUILD`, then kind, hosting and operator access. Exact texts:
  - `NOTHING_TO_BUILD = 'The new brief does not change anything the app does, so there is nothing to build. The new brief version is kept.'`
  - `KIND_CHANGED = 'The new brief describes a different kind of software. That is a new project, not a change: start it with "conductor project new".'`
  - `HOSTING_CHANGED = 'The new brief moves where the app runs. That needs a new deployment (conductor ship), not a change request, so nothing was built.'`
  - `OPERATOR_ACCESS_REQUIRED = 'The new brief no longer gives you remote access for support. Every Highland deployment needs it (spec §4.6), so nothing was built. Revise the brief first.'`
  - `` EXAMPLE_ID_REUSED(ids) = `The new brief changed the words of worked examples that kept their old numbers (${ids.join(', ')}), so Conductor cannot tell which tests prove them. Nothing was built. Revise the brief again so each changed example gets a new number.` ``
- **`buildUnits(delta, { toVersion })`**: each unit is a Plan 8 `Unit` (`dependsOn: []`) plus `change` and `retire`.
  - **Added feature:** `{ id: f.id, title: f.title, covers: [f.id], acceptance: <all its example ids>, kind: 'feature', retire: [] }`. Instructions: `New in brief v<toVersion>. Build this feature as the brief describes it.`
  - **Changed feature:** `{ id: 'change-<id>', title: 'Change <title>', covers: [id], acceptance: examples.added, kind: examples.added.length ? 'feature' : 'fix', retire: examples.retired }`. Instructions: `What changed: <plain fields>. Before: <old story>.`, then `Tests tagged <testTag(id) …> prove an example the client no longer wants: change or remove those tests only.` when `retire` is not empty.
  - **Removal:** `{ id: 'remove-<id>', title: 'Remove <title>', covers: [], acceptance: [], kind: 'fix', retire: <all its old example ids> }`. Instructions: the Ruling 3 text (`Take <title> out of the pages, the menu and the routes. Keep its tables and stored files, and do not write a database change that drops or empties anything: deleting old data is the client's decision.`), then `Remove the tests tagged <tags>, and only those. Add a test that the menu no longer shows <title> and that its old address says it is no longer available.`
  - **Brief-wide:** `brief-wide-changes` (kind `fix`, `retire: []`) lists role, output, integration, module and policy changes as plain sentences, with `For each role change, make sure the role-crossing tests cover it.`
  - Order: added and changed units in the new brief's feature order, then removals in the old brief's order, then the brief-wide unit.
  - Every `instructions` string is clipped to `MAX_INSTRUCTIONS` by shortening the quoted old story first; the tag lists are never clipped.
- **`profileChanged(delta)`**: `modules.added/removed` not empty, or a `policy` entry for `outbound` or `residency`.
- **`changeChangelogLines`**: `- Change (brief v<N>): ` then `added A, B; changed C; removed D.` (omit empty parts; "brief-wide changes" when only those).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-delta.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/delta.js test/factory-change-delta.test.js
git commit -m "feat(change): brief delta by example id, refusals and build units

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
