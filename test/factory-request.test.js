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
