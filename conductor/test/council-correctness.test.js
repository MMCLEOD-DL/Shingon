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
  assert.equal(f.title, 'The tests fail, but they already failed before this change');
  assert.match(f.detail, /^exit code 1\n/);
  assert.match(f.detail, /cannot tell whether this change broke anything more/);
  const [timedOut] = testFindings({ ran: true, passed: false, code: -1, output: '' }, { ran: true, passed: false, code: 1 });
  assert.equal(timedOut.title, 'The tests fail, but they already failed before this change');
  assert.match(timedOut.detail, /^the test command timed out\n/);
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

// ---------- Task 9: client apps ----------
import { mkdtempSync, mkdirSync, writeFileSync as wf, readFileSync as rf } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { verifyFindings, moneyFindings, CROSSING_TEST } from '../src/council/correctness.js';
import { parseVitestJson, parsePlaywrightJson } from '../src/council/gates.js';
import { BRIEF } from './fixtures/council-full/brief.js';

const FXDIR = new URL('./fixtures/council-full/gates-out/', import.meta.url).pathname;
const fx = (n) => rf(nodePath.join(FXDIR, n), 'utf8');
function moneyDir() {
  const d = mkdtempSync(nodePath.join(tmpdir(), 'cmoney-'));
  mkdirSync(nodePath.join(d, 'apps/server/src/claims'), { recursive: true });
  wf(nodePath.join(d, 'apps/server/src/claims/total.ts'), 'const total = miles * 0.45;\n');
  return d;
}

test('project build: verify, coverage, journeys and money run', async () => {
  const gates = { steps: { 'npm-ci': 0, lint: 0, typecheck: 0, licences: 0, vitest: 1, build: 0, browser: 1, a11y: null }, logs: { vitest: 'FAIL claims.test.ts' }, verify: null,
    source: { verify: 'council', browser: 'council', a11y: null },
    tests: parseVitestJson(fx('vitest.json')), browser: parsePlaywrightJson(fx('playwright.json')), crossing: { routes: 31, checks: 7012, failures: [] } };
  const runs = await CORRECTNESS.collect({ brief: BRIEF, dir: moneyDir(), files: ['apps/server/src/claims/total.ts'], tests: null, evidence: { gates, gatesNote: null } });
  assert.deepEqual(runs.map((r) => r.tool), ['verify', 'test-files', 'coverage', 'journeys', 'money']);
  assert.deepEqual(runs[0].findings.map((f) => [f.title, f.grade, f.locked]), [['The tests fail', 'blocking', true]]);
  assert.match(runs[0].context, /came from the council's own run/);
  assert.doesNotMatch(runs.map((r) => [r.context ?? ''].flat().join('\n')).join('\n'), /Role-crossing/);
  assert.deepEqual(runs[2].coverage, { proven: 1, total: 3 });
  assert.deepEqual(runs[3].findings.map((f) => f.title), ['A user journey fails in the browser: a member adds a note with a photo (desktop)']);
  assert.deepEqual(runs[4].findings.map((f) => [f.file, f.grade, f.maxGrade]), [['apps/server/src/claims/total.ts', 'warning', 'warning']]);
});

test('Ruling R9: a crossing-only failure is Security\'s only when the crossing report is present', () => {
  const crossingOnly = [{ file: 'apps/server/test/crossing/crossing.test.ts', title: 'crossing > every role', status: 'failed', message: 'a member read a claim' }];
  const other = { file: 'apps/server/test/claims.test.ts', title: 'claims > x', status: 'failed', message: 'm' };
  const base = { steps: {}, logs: {}, browser: null, crossing: { routes: 1, checks: 1, failures: ['s'] }, source: { verify: 'build', browser: null, a11y: null }, verify: { status: 'failed', summary: 'The tests fail.', output: 'x' } };
  assert.ok(CROSSING_TEST.test('apps/server/test/crossing/a.test.ts'));
  assert.deepEqual(verifyFindings({ ...base, tests: crossingOnly }), []);
  assert.deepEqual(verifyFindings({ ...base, crossing: null, tests: crossingOnly }).map((f) => f.title), ['The tests fail']);
  assert.deepEqual(verifyFindings({ ...base, tests: null }).map((f) => [f.title, f.grade, f.locked]),
    [["The foundation's checks fail (install, lint, types, licences or tests)", 'blocking', true]]);
  const both = verifyFindings({ ...base, tests: [...crossingOnly, other] });
  assert.deepEqual(both.map((f) => f.title), ['The tests fail']);
  assert.doesNotMatch(both[0].detail, /crossing/);
  // council source: the vitest step is dropped for crossing-only failures, other failed steps stay
  const council = { ...base, source: { verify: 'council' }, steps: { 'npm-ci': 0, lint: 1, vitest: 1 }, logs: { lint: 'bad lint', vitest: 'x' }, tests: crossingOnly };
  assert.deepEqual(verifyFindings(council).map((f) => f.title), ['The lint check fails']);
  assert.deepEqual(verifyFindings({ ...council, tests: null }).map((f) => f.title), ['The lint check fails', 'The tests fail']);
});

test('project build without gates: verify and coverage are "not proven"', async () => {
  const runs = await CORRECTNESS.collect({ brief: BRIEF, dir: '/nope', files: [], tests: null, evidence: { gates: null, gatesNote: 'TEST_DATABASE_URL is not set' } });
  assert.deepEqual(runs.map((r) => [r.tool, r.status]), [['verify', 'skipped'], ['test-files', 'ran'], ['coverage', 'skipped'], ['journeys', 'skipped'], ['money', 'ran']]);
  assert.equal(runs[0].note, "The foundation's checks did not run in the council (TEST_DATABASE_URL is not set).");
  assert.deepEqual(runs[2].findings.map((f) => [f.title, f.grade, f.locked]), [['Brief coverage was not proven: there was no test report', 'warning', true]]);
});

test('money: web files skip toFixed, test files and other dirs are ignored', () => {
  const d = mkdtempSync(nodePath.join(tmpdir(), 'cmoney-'));
  for (const f of ['apps/web/src/a.ts', 'apps/server/src/b.ts', 'apps/server/src/c.test.ts', 'apps/server/lib/d.ts']) {
    mkdirSync(nodePath.dirname(nodePath.join(d, f)), { recursive: true });
    wf(nodePath.join(d, f), 'const price = x.toFixed(2);\nconst fee = parseFloat(s);\n');
  }
  const r = moneyFindings({ dir: d, files: ['apps/web/src/a.ts', 'apps/server/src/b.ts', 'apps/server/src/c.test.ts', 'apps/server/lib/d.ts'] });
  assert.deepEqual(r.map((f) => [f.file, f.line]), [['apps/web/src/a.ts', 2], ['apps/server/src/b.ts', 1]]);
  assert.match(r[1].detail, /2 lines/);
});

test('ordinary repo: exactly the Plan 5 checks', async () => {
  const runs = await CORRECTNESS.collect({ files: ['src/a.js'], tests: { ran: true, passed: true, code: 0, output: '' } });
  assert.deepEqual(runs.map((r) => r.tool), ['tests', 'test-files']);
  assert.deepEqual(runs[0], { tool: 'tests', label: 'the test command', status: 'ran', findings: [], note: null });
});

test('fix 1: an empty crossing failures list does not hide a failed crossing test from Correctness', () => {
  const t = [{ file: 'apps/server/test/crossing/c.test.ts', title: 'c', status: 'failed', message: 'm' }];
  const g = { steps: {}, logs: {}, browser: null, source: { verify: 'build' }, verify: { status: 'failed', summary: 's', output: '' }, tests: t };
  assert.deepEqual(verifyFindings({ ...g, crossing: { routes: 1, checks: 1, failures: [] } }).map((f) => f.title), ['The tests fail']);
  assert.deepEqual(verifyFindings({ ...g, crossing: { routes: 1, checks: 1, failures: ['x'] } }), []);
});

test('fix 4: council vitest non-zero with no failed test in the report is "The tests fail"; money rejects paths leaving the allowed dirs', () => {
  const g = { steps: { vitest: 1 }, logs: { vitest: 'boom' }, source: { verify: 'council' }, crossing: null,
    tests: [{ file: 'apps/server/test/a.test.ts', title: 'a', status: 'passed', message: '' }] };
  assert.deepEqual(verifyFindings(g).map((f) => f.title), ['The tests fail']);
  const d = mkdtempSync(nodePath.join(tmpdir(), 'cmoney-'));
  wf(nodePath.join(d, 'evil.ts'), 'const price = parseFloat(s);\n');
  mkdirSync(nodePath.join(d, 'apps/server/src'), { recursive: true });
  assert.deepEqual(moneyFindings({ dir: d, files: ['apps/server/src/../../../evil.ts', 'apps/server/src/../../evil.ts'] }), []);
});
