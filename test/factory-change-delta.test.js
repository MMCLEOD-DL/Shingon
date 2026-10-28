import test from 'node:test';
import assert from 'node:assert/strict';
import {
  briefDelta, deltaProblem, buildUnits, profileChanged, deltaText, changeChangelogLines,
  NOTHING_TO_BUILD, KIND_CHANGED, HOSTING_CHANGED, OPERATOR_ACCESS_REQUIRED, EXAMPLE_ID_REUSED,
} from '../src/factory/change/delta.js';
import { MAX_INSTRUCTIONS } from '../src/factory/split.js';

const ex = (id, then = 'it works') => ({ id, given: 'a user', when: 'they act', then });
const feat = (id, title, acceptance, extra = {}) => ({
  id, title, story: `${title} story`, roles: ['member'], data: [`${id} records`], acceptance, ...extra,
});
const basePolicy = () => ({
  hosting: 'client-box', outbound: [], residency: 'uk',
  retention: { text: 'seven years', days: 2555 }, backupDestination: { kind: 'client-owned', detail: 'nas' }, operatorAccess: true,
});
function brief({ version = 1, features, roles, policy, kind = 'web-app', outputs = [], integrations = [], modules = [], ...rest } = {}) {
  return {
    schema: 1, slug: 'expenses', version, createdAt: 'x', revisedFrom: version - 1, exampleSeq: { a: 9 },
    client: 'Acme', purpose: 'Expenses', kind,
    roles: roles ?? [{ name: 'Staff', whatTheyDo: 'claim', sees: 'own', mapsTo: 'member' }],
    features, outputs, integrations, modules, policy: policy ?? basePolicy(),
    openQuestions: [], approvedAt: `2026-01-0${version}`, approvedBy: 'me', ...rest,
  };
}
const submit = () => feat('submit-receipt', 'Submit receipt', [ex('submit-receipt#1'), ex('submit-receipt#2')]);
const report = (acc) => feat('monthly-report', 'Monthly report', acc ?? [ex('monthly-report#1'), ex('monthly-report#2')]);
const paper = () => feat('paper-upload', 'Paper upload', [ex('paper-upload#1')]);
const mileage = () => feat('mileage-claims', 'Mileage claims', [ex('mileage-claims#1')]);

const prev = brief({ version: 1, features: [submit(), report(), paper()] });
const next = brief({
  version: 3,
  features: [report([ex('monthly-report#1'), ex('monthly-report#3', 'a different result')]), submit(), mileage()],
});
const withPolicy = (p, o = {}) => brief({ version: 3, features: prev.features, policy: { ...basePolicy(), ...p }, ...o });

test('features are matched by id: added, changed (fields and example ids) and removed; reordering alone is no change', () => {
  const d = briefDelta(prev, next);
  assert.equal(d.fromVersion, 1);
  assert.equal(d.toVersion, 3);
  assert.deepEqual(d.features.added.map((f) => f.id), ['mileage-claims']);
  assert.deepEqual(d.features.changed.map((c) => [c.after.id, c.fields, c.examples]),
    [['monthly-report', ['acceptance'], { added: ['monthly-report#3'], retired: ['monthly-report#2'] }]]);
  assert.deepEqual(d.features.removed.map((f) => f.id), ['paper-upload']);
  assert.equal(d.empty, false);
});

test('comparison ignores key order, feature order, example order, approval stamps and Plan 7 meta', () => {
  const reordered = {
    approvedBy: 'someone else', approvedAt: 'later', openQuestions: [{ id: 'q', question: 'q', why: 'w' }],
    policy: Object.fromEntries(Object.entries(basePolicy()).reverse()),
    features: [paper(), report([ex('monthly-report#2'), ex('monthly-report#1')]), submit()].map((f) => Object.fromEntries(Object.entries(f).reverse())),
    version: 7, slug: 'other', createdAt: 'y', revisedFrom: 6, exampleSeq: { a: 1 },
    modules: [], outputs: [], integrations: [], roles: prev.roles, kind: 'web-app', purpose: 'Expenses', client: 'Acme', schema: 1,
  };
  const d = briefDelta(prev, reordered);
  assert.equal(d.empty, true);
  assert.deepEqual(d.reusedIds, []);
});

test('an example id kept with different words is reported, and deltaProblem refuses it', () => {
  const reworded = brief({
    version: 3,
    features: [submit(), report([ex('monthly-report#1', 'something else'), ex('monthly-report#2')]), paper()],
  });
  const d = briefDelta(prev, reworded);
  assert.deepEqual(d.reusedIds, ['monthly-report#1']);
  assert.equal(deltaProblem(d, prev, reworded), EXAMPLE_ID_REUSED(['monthly-report#1']));
  assert.match(EXAMPLE_ID_REUSED(['a#1', 'a#2']), /\(a#1, a#2\)/);
});

test('roles are matched by name; a changed mapsTo is a role change', () => {
  const roles = [{ name: 'Staff', whatTheyDo: 'claim', sees: 'own', mapsTo: 'manager' }, { name: 'Auditor', whatTheyDo: 'look', sees: 'all', mapsTo: 'admin' }];
  const d = briefDelta(prev, brief({ version: 2, features: prev.features, roles }));
  assert.deepEqual(d.roles.added.map((r) => r.name), ['Auditor']);
  assert.deepEqual(d.roles.removed, []);
  assert.deepEqual(d.roles.changed.map((c) => [c.before.mapsTo, c.after.mapsTo]), [['member', 'manager']]);
  assert.equal(d.empty, false);
});

test('outputs, integrations and modules are listed as added and removed', () => {
  const o = { name: 'Report', format: 'pdf', roles: ['admin'], description: 'monthly' };
  const i = { name: 'OCR', purpose: 'read', dataSent: 'images', service: 'azure-document-intelligence' };
  const d = briefDelta(prev, brief({ version: 2, features: prev.features, outputs: [o], integrations: [i], modules: ['ocr'] }));
  assert.deepEqual([d.outputs.added, d.outputs.removed], [[o], []]);
  assert.deepEqual([d.integrations.added, d.integrations.removed], [[i], []]);
  assert.deepEqual([d.modules.added, d.modules.removed], [['ocr'], []]);
  const back = briefDelta(brief({ version: 2, features: prev.features, modules: ['ocr'] }), prev);
  assert.deepEqual(back.modules.removed, ['ocr']);
});

test('policy changes are listed field by field; outbound compares ids', () => {
  const d = briefDelta(prev, withPolicy({ outbound: ['azure-document-intelligence'] }));
  assert.deepEqual(d.policy, [{ field: 'outbound', before: [], after: ['azure-document-intelligence'] }]);
  const same = briefDelta(prev, withPolicy({ retention: { days: 2555, text: 'seven years' } }));
  assert.deepEqual(same.policy, []);
  assert.equal(same.empty, true);
});

test('deltaProblem refuses: nothing to build, a different kind, a hosting move, operator access withdrawn', () => {
  assert.equal(deltaProblem(briefDelta(prev, prev), prev, prev), NOTHING_TO_BUILD);
  const moved = withPolicy({ hosting: 'operator-server' });
  assert.equal(deltaProblem(briefDelta(prev, moved), prev, moved), HOSTING_CHANGED);
  const mobile = brief({ version: 3, features: prev.features, kind: 'mobile-app' });
  assert.equal(deltaProblem(briefDelta(prev, mobile), prev, mobile), KIND_CHANGED);
  const noAccess = withPolicy({ operatorAccess: false });
  assert.equal(deltaProblem(briefDelta(prev, noAccess), prev, noAccess), OPERATOR_ACCESS_REQUIRED);
  assert.equal(deltaProblem(briefDelta(prev, next), prev, next), null);
});

const nextWide = brief({
  version: 3,
  features: next.features,
  roles: [{ name: 'Staff', whatTheyDo: 'claim', sees: 'own', mapsTo: 'manager' }],
  outputs: [{ name: 'Report', format: 'pdf', roles: ['admin'], description: 'monthly' }],
});

test('buildUnits: added and changed features in new-brief order, then removals, then one brief-wide unit', () => {
  const units = buildUnits(briefDelta(prev, nextWide), { toVersion: 3 });
  assert.deepEqual(units.map((u) => [u.id, u.change, u.kind]), [
    ['change-monthly-report', 'changed', 'feature'], ['mileage-claims', 'added', 'feature'],
    ['remove-paper-upload', 'removed', 'fix'], ['brief-wide-changes', 'brief-wide', 'fix'],
  ]);
  const added = units.find((u) => u.change === 'added');
  assert.deepEqual([added.covers, added.acceptance, added.retire], [['mileage-claims'], ['mileage-claims#1'], []]);
  assert.match(added.instructions, /^New in brief v3\. Build this feature as the brief describes it\./);
  const changed = units.find((u) => u.change === 'changed');
  assert.deepEqual([changed.covers, changed.acceptance, changed.retire], [['monthly-report'], ['monthly-report#3'], ['monthly-report#2']]);
  assert.match(changed.instructions, /What changed: its worked examples\./);
  assert.match(changed.instructions, /Before: Monthly report story\./);
  assert.match(changed.instructions, /Tests tagged \[monthly-report#2\] prove an example the client no longer wants: change or remove those tests only\./);
  const removal = units.find((u) => u.change === 'removed');
  assert.deepEqual([removal.covers, removal.acceptance, removal.retire], [[], [], ['paper-upload#1']]);
  assert.match(removal.instructions, /Keep its tables and stored files/);
  assert.match(removal.instructions, /do not write a database change that drops or empties anything/);
  assert.match(removal.instructions, /Remove the tests tagged \[paper-upload#1\], and only those/);
  assert.match(removal.instructions, /Add a test that the menu no longer shows Paper upload/);
  const wide = units.find((u) => u.change === 'brief-wide');
  assert.deepEqual(wide.retire, []);
  assert.match(wide.instructions, /For each role change, make sure the role-crossing tests cover it\./);
  for (const u of units) { assert.ok(u.instructions.length <= MAX_INSTRUCTIONS); assert.deepEqual(u.dependsOn, []); }
});

test('a changed feature with no new example is a fix unit with no acceptance ids', () => {
  const restory = brief({ version: 2, features: [submit(), report(), paper()].map((f) => (f.id === 'submit-receipt' ? { ...f, story: 'new story' } : f)) });
  const d = briefDelta(prev, restory);
  assert.deepEqual(d.features.changed[0].fields, ['story']);
  const [u, ...rest] = buildUnits(d, { toVersion: 2 });
  assert.equal(rest.length, 0);
  assert.deepEqual([u.kind, u.acceptance, u.retire], ['fix', [], []]);
  assert.match(u.instructions, /What changed: what it does\./);
  assert.doesNotMatch(u.instructions, /Tests tagged/);
});

test('no brief-wide unit when only features changed', () => {
  const units = buildUnits(briefDelta(prev, next), { toVersion: 3 });
  assert.ok(!units.some((u) => u.change === 'brief-wide'));
});

test('a very long old story is shortened so instructions stay within the limit, tags kept', () => {
  const long = report([ex('monthly-report#1'), ex('monthly-report#2')]);
  const p = brief({ version: 1, features: [{ ...long, story: 'x'.repeat(5000) }] });
  const n = brief({ version: 2, features: [{ ...long, story: 'x'.repeat(5000), acceptance: [ex('monthly-report#1'), ex('monthly-report#3')] }] });
  const [u] = buildUnits(briefDelta(p, n), { toVersion: 2 });
  assert.ok(u.instructions.length <= MAX_INSTRUCTIONS);
  assert.match(u.instructions, /Tests tagged \[monthly-report#2\]/);
});

test('profileChanged: true for modules, outbound or residency changes; false for retention or features only', () => {
  assert.equal(profileChanged(briefDelta(prev, brief({ version: 2, features: prev.features, modules: ['ocr'] }))), true);
  assert.equal(profileChanged(briefDelta(prev, withPolicy({ outbound: ['cloudflare-tunnel'] }))), true);
  assert.equal(profileChanged(briefDelta(prev, withPolicy({ residency: 'uk-eu' }))), true);
  assert.equal(profileChanged(briefDelta(prev, withPolicy({ retention: { text: 'one year', days: 365 } }))), false);
  assert.equal(profileChanged(briefDelta(prev, next)), false);
});

test('deltaText is plain English the operator can read at the gate', () => {
  assert.equal(deltaText(briefDelta(prev, next)),
    'Added: Mileage claims.\nChanged: Monthly report (its worked examples).\nRemoved: Paper upload (its data is kept).');
});

test('deltaText lists data policy changes under their own heading, with service labels', () => {
  const t = deltaText(briefDelta(prev, withPolicy({ outbound: ['azure-document-intelligence'] })));
  assert.match(t, /Data policy changes:\n {2}- Outside services allowed: none → Azure Document Intelligence/);
});

test('changeChangelogLines: one line naming the brief version', () => {
  assert.deepEqual(changeChangelogLines(briefDelta(prev, next), 3),
    ['- Change (brief v3): added Mileage claims; changed Monthly report; removed Paper upload.']);
  assert.deepEqual(changeChangelogLines(briefDelta(prev, withPolicy({ residency: 'uk-eu' })), 3),
    ['- Change (brief v3): brief-wide changes.']);
});
