import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coverageFindings, TAG_PATTERN } from '../src/council/coverage.js';
import { testTag } from '../src/factory/acceptance.js';
import { applyInterpretation } from '../src/council/interpret.js';

import { BRIEF } from './fixtures/council-full/brief.js';

test('each worked example needs a passing test that carries its tag', () => {
  const r = coverageFindings(BRIEF, [
    { title: '[mileage-claims#1] 120 miles at 45p comes to £54.00', status: 'failed', message: 'expected 5400, got 5399' },
    { title: 'claims > [mileage-claims#2] [mileage-claims#4] team only, and zero refused', status: 'passed' },
    { title: '[mileage-claims#3] an example removed from the brief', status: 'passed' },
  ]);
  assert.deepEqual([r.proven, r.total], [2, 3]);
  assert.deepEqual(r.findings.map((f) => [f.title, f.grade, f.locked]), [
    ['Worked example mileage-claims#1 fails its test', 'blocking', true],
    ['Feature receipts has no worked examples', 'warning', true],
    ['A test names worked example mileage-claims#3, which the brief does not have', 'note', false],
  ]);
  assert.match(r.findings[0].detail, /expected 5400, got 5399/);
  assert.deepEqual(r.lines, ['Worked examples proven: 2 of 3.', 'mileage-claims#1: its test fails']);
  assert.deepEqual([...testTag('mileage-claims#4').matchAll(TAG_PATTERN)].map((m) => m[1]), ['mileage-claims#4']);
});

test('the interpreter cannot clear or lower a coverage block', () => {
  const [f] = coverageFindings({ features: [BRIEF.features[0]] }, []).findings;
  const out = applyInterpretation([f], ['C1'], { findings: [{ id: 'C1', decision: 'dismiss', grade: 'note', why: 'covered by another test' }], extra: [] }, { member: 'correctness' });
  assert.deepEqual([out[0].grade, out[0].dismissed], ['blocking', false]);
});

test('skipped, todo or a mistyped tag counts as no test', () => {
  const r = coverageFindings({ features: [BRIEF.features[0]] }, [
    { title: '[mileage-claims#1] later', status: 'skipped' },
    { title: '[mileage-claims#2] later', status: 'todo' },
    { title: '[mileage-claims#4 ] stray space', status: 'passed' },
  ]);
  assert.equal(r.proven, 0);
  assert.deepEqual(r.findings.map((f) => f.title), [
    'Worked example mileage-claims#1 has no test', 'Worked example mileage-claims#2 has no test', 'Worked example mileage-claims#4 has no test']);
  assert.match(r.findings[0].detail, /^Feature: Mileage claims\. Given a member, when they claim 120 miles, then the claim is £54\.00 at 45p a mile\. Write a test whose title includes \[mileage-claims#1\]\.$/);
});

test('a failed and a passed match for one example is still a failure', () => {
  const r = coverageFindings({ features: [BRIEF.features[0]] }, [
    { title: '[mileage-claims#1] a', status: 'passed' }, { title: '[mileage-claims#1] b', status: 'failed', message: 'm' },
  ]);
  assert.equal(r.findings[0].title, 'Worked example mileage-claims#1 fails its test');
});

test('a lone missing report makes an unmatched example "not proven" (locked warning), not blocking', () => {
  const one = { features: [BRIEF.features[0]] };
  const r = coverageFindings(one, [{ title: '[mileage-claims#1] a', status: 'passed' }], { missing: 'browser' });
  assert.deepEqual(r.findings.map((f) => [f.title, f.grade, f.locked]), [
    ['Worked example mileage-claims#2 is not proven: the browser report was missing', 'warning', true],
    ['Worked example mileage-claims#4 is not proven: the browser report was missing', 'warning', true]]);
  assert.equal(r.proven, 1);
  assert.ok(r.lines.every((l, i) => i === 0 || !l.startsWith('- ')));
  const both = coverageFindings(one, [], { missing: null });
  assert.ok(both.findings.every((f) => f.grade === 'blocking'));
});

test('[mileage-claims#10] does not prove #1', () => {
  const r = coverageFindings({ features: [BRIEF.features[0]] }, [{ title: '[mileage-claims#10] x', status: 'passed' }]);
  assert.equal(r.proven, 0);
  assert.ok(r.findings.some((f) => f.title === 'Worked example mileage-claims#1 has no test'));
});
