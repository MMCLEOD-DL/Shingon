# Task 3: Brief delta and build items

A change starts from a new approved brief version (Plan 7's revise flow). This task works out **what changed** between the brief the app was built from and the new one, refuses what is not a change request (index Rulings 1–3), and turns the rest into build items for Plan 8's feature loop. It also writes the plain-English description shown at the gate and the line that goes into the app's changelog.

Everything here is pure (no files, no git), so it is tested directly.

**Files:**
- Create: `src/factory/change/delta.js`
- Test: `test/factory-change-delta.test.js`

**Interfaces:**
- Consumes: the Brief shape from Contract 2 (`client`, `purpose`, `kind`, `roles[]`, `features[]`, `outputs[]`, `integrations[]`, `modules[]`, `policy{}`, `openQuestions`, `approvedAt`, `approvedBy`).
- Produces:
  - `briefDelta(prev, next) -> Delta`:
    ```js
    Delta = {
      features: { added: Feature[], changed: [{ before: Feature, after: Feature, fields: string[] }], removed: Feature[] },
      roles: { added: Role[], removed: Role[], changed: [{ before, after }] },     // keyed by name
      outputs: { added, removed }, integrations: { added, removed }, modules: { added: string[], removed: string[] },
      policy: [{ field, before, after }],          // top-level policy fields, compared by value
      identity: [{ field, before, after }],        // client, purpose, kind
      empty: boolean,                              // nothing above changed except identity.purpose wording
    }
    ```
  - `deltaProblem(delta, prev, next) -> string | null`;
  - `buildItems(delta) -> Feature[]`;
  - `deltaText(delta) -> string`;
  - `changeChangelogLines(delta, toVersion) -> string[]`;
  - the refusal texts `NOTHING_TO_BUILD`, `KIND_CHANGED`, `HOSTING_CHANGED`, `OPERATOR_ACCESS_REQUIRED`.

- [ ] **Step 1: Write the failing tests**

Build two briefs with a small helper (`brief({ features, roles, policy })`) so each test states only what it changes. Use the expenses example: features `submit-receipt`, `monthly-report`; new brief adds `mileage-claims`, changes `monthly-report`'s acceptance, removes `paper-upload`.

```js
test('features are matched by id: added, changed (with the fields that changed) and removed', () => {
  const d = briefDelta(prev, next);
  assert.deepEqual(d.features.added.map((f) => f.id), ['mileage-claims']);
  assert.deepEqual(d.features.changed.map((c) => [c.after.id, c.fields]), [['monthly-report', ['acceptance']]]);
  assert.deepEqual(d.features.removed.map((f) => f.id), ['paper-upload']);
  assert.equal(d.empty, false);
});
test('comparison ignores key order and approval stamps', ...)   // same brief with keys reordered and a new approvedAt → empty: true
test('roles are matched by name; a changed mapsTo is a role change', ...)
test('policy changes are listed field by field', ...)   // outbound [] → ['ocr.example'] gives [{ field: 'outbound', before: [], after: ['ocr.example'] }]
test('deltaProblem refuses: nothing to build, a different kind, a hosting move, operator access withdrawn', () => {
  assert.equal(deltaProblem(briefDelta(prev, prev), prev, prev), NOTHING_TO_BUILD);
  assert.equal(deltaProblem(briefDelta(prev, withPolicy({ hosting: 'operator-server' })), prev, withPolicy({ hosting: 'operator-server' })), HOSTING_CHANGED);
  // kind 'mobile-app' → KIND_CHANGED; operatorAccess false → OPERATOR_ACCESS_REQUIRED
  assert.equal(deltaProblem(briefDelta(prev, next), prev, next), null);
});
test('buildItems: added and changed features in brief order, then removals, then one brief-wide item', () => {
  const items = buildItems(briefDelta(prev, nextWithRoleAndOutputChange));
  assert.deepEqual(items.map((i) => [i.id, i.change]), [
    ['mileage-claims', 'added'], ['monthly-report', 'changed'], ['remove-paper-upload', 'removed'], ['brief-wide-changes', 'brief-wide'],
  ]);
  const removal = items.find((i) => i.change === 'removed');
  assert.match(removal.story, /Keep its tables and stored files/);
  assert.match(removal.story, /do not write a database change that drops or empties anything/);
  assert.deepEqual(removal.acceptance.length > 0, true);   // "given a member, when they open the menu, then Paper upload is not there"
  assert.match(items.find((i) => i.change === 'changed').story, /What changed: acceptance/);
});
test('no brief-wide item when only features changed', ...)
test('deltaText is plain English the operator can read at the gate', () => {
  assert.equal(deltaText(briefDelta(prev, next)),
    'Added: Mileage claims.\nChanged: Monthly report (its worked examples).\nRemoved: Paper upload (its data is kept).');
});
test('deltaText lists data policy changes under their own heading', ...)   // /Data policy changes:\n  - Outside services allowed: none → ocr\.example/
test('changeChangelogLines: one line naming the brief version', () => {
  assert.deepEqual(changeChangelogLines(briefDelta(prev, next), 3),
    ['- Change (brief v3): added Mileage claims; changed Monthly report; removed Paper upload.']);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-delta.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/delta.js`**

- Compare with a canonical JSON (keys sorted recursively). Ignore `approvedAt`, `approvedBy`, `openQuestions` and any `version` field.
- `changed.fields` lists the feature fields that differ, in the order `title, story, roles, data, acceptance`. Plain names for `deltaText`: `story` → "what it does", `roles` → "who uses it", `data` → "its records", `acceptance` → "its worked examples", `title` → "its name".
- `empty` is true when features, roles, outputs, integrations, modules and policy are all unchanged and `identity` has no `kind` or `client` change.
- Refusal texts (exact):
  - `NOTHING_TO_BUILD = 'The new brief does not change anything the app does, so there is nothing to build. The new brief version is kept.'`
  - `KIND_CHANGED = 'The new brief describes a different kind of software. That is a new project, not a change: start it with "conductor project new".'`
  - `HOSTING_CHANGED = 'The new brief moves where the app runs. That needs a new deployment (conductor ship), not a change request, so nothing was built.'`
  - `OPERATOR_ACCESS_REQUIRED = 'The new brief no longer gives you remote access for support. Every Highland deployment needs it (spec §4.6), so nothing was built. Revise the brief first.'`
- `buildItems`:
  - added/changed items are the new brief's feature objects plus `change`; a changed item's `story` gets a final paragraph `What changed: <fields>. Before: <old story>` so the author sees both;
  - a removal is `{ id: 'remove-<id>', title: 'Remove <title>', change: 'removed', roles: <old roles>, data: [], story: <Ruling 3 text>, acceptance: [{ given: 'any signed-in user', when: 'they open the menu or go to the feature\'s old address', then: '<title> is not there, and the page says it is no longer available' }] }`;
  - `brief-wide-changes` lists role, output, integration, module and policy changes as plain sentences, with one acceptance example per role change ("given a <role> … then the role-crossing tests cover it").
- `changeChangelogLines`: `- Change (brief v<N>): ` then `added A, B; changed C; removed D.` (omit empty parts; "brief-wide changes" when only those).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-delta.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/delta.js test/factory-change-delta.test.js
git commit -m "feat(change): brief delta, refusals and build items"
```
