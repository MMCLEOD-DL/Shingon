import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEST_FILE, testFindings, testFilesFinding, CORRECTNESS } from '../src/council/correctness.js';

test('TEST_FILE recognises the usual test locations', () => {
  for (const f of ['test/a.js', 'src/__tests__/x.ts', 'a.test.mjs', 'b.spec.tsx', 'pkg/x_test.go', 'tests/test_y.py', 'spec/z.rb'])
    assert.ok(TEST_FILE.test(f), f);
  for (const f of ['src/a.js', 'latest.js', 'contest/a.js', 'README.md']) assert.ok(!TEST_FILE.test(f), f);
});

test('failing tests: one locked blocking finding carrying the output', () => {
  const [f] = testFindings({ ran: true, passed: false, code: 1, output: 'not ok 3 - totals\nexpected 12.40' });
  assert.equal(f.grade, 'blocking');
  assert.equal(f.locked, true);
  assert.equal(f.tool, 'tests');
  assert.equal(f.title, 'The tests fail');
  assert.match(f.detail, /^exit code 1\n/);
  assert.match(f.detail, /expected 12\.40/);
  assert.deepEqual(testFindings({ ran: true, passed: true, code: 0, output: '' }), []);
  const [none] = testFindings({ ran: false, passed: null, code: null, output: '' });
  assert.equal(none.grade, 'note');
  assert.equal(none.title, 'No test command is set, so Correctness could only judge the change by reading it');
});

test('tests that already failed at the starting commit: a locked warning, not a block (Ruling 5)', () => {
  const failing = { ran: true, passed: false, code: 1, output: 'not ok 1' };
  const [f] = testFindings(failing, { ran: true, passed: false, code: 1 });
  assert.deepEqual([f.grade, f.maxGrade, f.locked, f.preExisting], ['warning', 'warning', true, true]);
  assert.equal(f.title, 'The tests fail (exit code 1), but they already failed before this change');
  assert.match(f.detail, /cannot tell whether this change broke anything more/);
  assert.equal(testFindings(failing, { ran: true, passed: true, code: 0 })[0].grade, 'blocking', 'green before, red now: blocks');
  assert.equal(testFindings(failing, null)[0].grade, 'blocking');
});

test('code changed without any test changing is a warning; docs-only changes are not', () => {
  const [w] = testFilesFinding(['src/a.js', 'README.md']);
  assert.equal(w.grade, 'warning');
  assert.equal(w.tool, 'test-files');
  assert.equal(w.title, 'The change adds or edits no tests');
  assert.deepEqual(testFilesFinding(['src/a.js', 'test/a.test.js']), []);
  assert.deepEqual(testFilesFinding(['README.md', 'docs/x.md', 'notes.txt']), []);
  assert.deepEqual(testFilesFinding([]), []);
});

test('CORRECTNESS.collect reuses the final-phase test result; no test command → skipped', async () => {
  const runs = await CORRECTNESS.collect({ files: ['src/a.js'], tests: { ran: true, passed: false, code: 2, output: 'boom' } });
  assert.deepEqual(runs.map((r) => [r.tool, r.status, r.findings.map((f) => f.grade)]), [
    ['tests', 'ran', ['blocking']],
    ['test-files', 'ran', ['warning']],
  ]);
  const old = await CORRECTNESS.collect({ files: ['src/a.js'], tests: { ran: true, passed: false, code: 2, output: 'boom' }, baseTests: { ran: true, passed: false, code: 2 } });
  assert.equal(old[0].findings[0].grade, 'warning');
  const none = await CORRECTNESS.collect({ files: [], tests: { ran: false } });
  assert.equal(none[0].status, 'skipped');
  assert.equal(none[0].findings[0].grade, 'note');
  assert.equal(CORRECTNESS.alwaysInterpret, true);
});
