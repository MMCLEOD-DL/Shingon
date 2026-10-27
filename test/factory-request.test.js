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

test('final-fix 3: a fix unit is clipped to the room left, so its request never goes over the budget', async () => {
  const { fixUnit } = await import('../src/factory/buildFinal.js');
  const brief = sampleBrief({
    purpose: 'p'.repeat(5000),
    roles: Array.from({ length: 10 }, (_, i) => ({ name: `Role number ${i} with a long name`, whatTheyDo: 'w'.repeat(400), sees: 's', mapsTo: i === 0 ? 'admin' : 'member' })),
  });
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `a-rather-long-unit-identifier-number-${i}`, title: `Unit ${i}`, covers: [], acceptance: [], instructions: 'Short.', dependsOn: [], kind: 'feature' }));
  const build = { units: many, features: [] };
  for (const [prefix, instructions] of [['fix', `Council fix: ${'c'.repeat(2990)}`], ['feedback', `Feedback: ${'f'.repeat(1990)}`], ['fix', `Checks: ${'o'.repeat(1500)}`]]) {
    const unit = fixUnit({ build, prefix, title: 'A fix', instructions });
    const index = build.units.indexOf(unit);
    const r = featureRequest({ brief, units: build.units, index });
    assert.ok(r.length <= REQUEST_BUDGET, `${unit.id}: ${r.length}`);
    assert.ok(r.includes(BUILDING_ON_RULES), `${unit.id}: the foundation rules survive`);
    assert.match(r, /\(clipped\)/, `${unit.id}: the clip is noted`);
    assert.match(r, new RegExp(`\\(${unit.id}\\)`));
  }
  // an ordinary feature unit is still refused when it is too long
  assert.throws(() => featureRequest({ brief, units: [{ ...many[0], instructions: 'y'.repeat(7000) }], index: 0 }), (e) => e.code === 'too-long');
  // a fix unit that fits is not touched
  const small = { units: [], features: [] };
  const u = fixUnit({ build: small, prefix: 'fix', title: 'Small', instructions: 'Make the checks pass.' });
  assert.doesNotMatch(featureRequest({ brief: sampleBrief(), units: small.units, index: small.units.indexOf(u) }), /\(clipped\)/);
});
