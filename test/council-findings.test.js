import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFinding, clampGrade, findingKey, tally, GRADES, MEMBER_LABEL } from '../src/council/findings.js';
import { DEFAULT_OPTIONS } from '../src/options.js';

test('council options: off by default, frozen containers', () => {
  assert.equal(DEFAULT_OPTIONS.council, false);
  assert.equal(DEFAULT_OPTIONS.councilFixRounds, 3);
  assert.equal(DEFAULT_OPTIONS.councilToolTimeoutMs, 600000);
  assert.deepEqual(DEFAULT_OPTIONS.councilTools, {});
  assert.deepEqual(DEFAULT_OPTIONS.councilAcceptLicences, []);
  assert.equal(DEFAULT_OPTIONS.councilSemgrepConfig, 'p/default');
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS.councilTools));
  assert.ok(Object.isFrozen(DEFAULT_OPTIONS.councilAcceptLicences));
});

test('grades run blocking > warning > note; clamp only ever lowers', () => {
  assert.deepEqual(GRADES, ['blocking', 'warning', 'note']);
  assert.deepEqual(MEMBER_LABEL, { security: 'Security', legal: 'Legal', correctness: 'Correctness', foundation: 'Foundation rules', design: 'Design', reliability: 'Reliability' });
  assert.equal(clampGrade('blocking', 'warning'), 'warning');
  assert.equal(clampGrade('note', 'warning'), 'note');
  assert.equal(clampGrade('warning', 'blocking'), 'warning');
});

test('no tool evidence, or already there before the change: at most a warning', () => {
  assert.equal(makeFinding({ member: 'security', grade: 'blocking', title: 't' }).grade, 'warning');
  assert.equal(makeFinding({ member: 'security', tool: 'semgrep', grade: 'blocking', title: 't', preExisting: true }).grade, 'warning');
  assert.deepEqual(makeFinding({ member: 'security', tool: 'semgrep', grade: 'blocking', title: 't', file: 'a.js', line: 3 }), {
    member: 'security', tool: 'semgrep', grade: 'blocking', maxGrade: 'blocking', title: 't', detail: '', file: 'a.js', line: 3,
    evidence: true, locked: false, preExisting: false, dismissed: false, why: null, fix: null,
  });
  assert.throws(() => makeFinding({ member: 'marketing', tool: 'x', grade: 'note', title: 't' }), /unknown council member/);
  assert.throws(() => makeFinding({ member: 'legal', tool: 'x', grade: 'fatal', title: 't' }), /unknown grade/);
});

test('the ceiling (maxGrade): only a finding its tool graded blocking can ever block (Ruling 6)', () => {
  const ceiling = (o) => makeFinding({ member: 'security', tool: 'semgrep', title: 't', ...o }).maxGrade;
  assert.equal(ceiling({ grade: 'blocking' }), 'blocking');
  assert.equal(ceiling({ grade: 'warning' }), 'warning');
  assert.equal(ceiling({ grade: 'note' }), 'warning', 'a note may be raised to a warning, never further');
  assert.equal(ceiling({ grade: 'blocking', preExisting: true }), 'warning');
  assert.equal(ceiling({ grade: 'blocking', tool: null }), 'warning');
  const f = makeFinding({ member: 'legal', tool: 'licences', grade: 'blocking', maxGrade: 'warning', title: 't' });
  assert.deepEqual([f.grade, f.maxGrade], ['warning', 'warning'], 'an explicit ceiling also caps the grade');
  assert.throws(() => makeFinding({ member: 'legal', tool: 'x', grade: 'note', maxGrade: 'fatal', title: 't' }), /unknown grade/);
});

test('a finding never carries a secret value; long text is clipped', () => {
  process.env.COUNCIL_TEST_TOKEN = 'sk-test-abcdefgh12345';
  try {
    const f = makeFinding({ member: 'security', tool: 'gitleaks', grade: 'blocking', title: 'leak sk-test-abcdefgh12345', detail: 'x sk-test-abcdefgh12345' });
    assert.doesNotMatch(JSON.stringify(f), /abcdefgh12345/);
  } finally { delete process.env.COUNCIL_TEST_TOKEN; }
  const long = makeFinding({ member: 'legal', tool: 'licences', grade: 'note', title: 'x'.repeat(500), detail: 'y'.repeat(5000) });
  assert.ok(long.title.length <= 260 && long.detail.length <= 2100);
});

test('findingKey ignores line numbers; tally skips set-aside findings', () => {
  const a = makeFinding({ member: 'security', tool: 'semgrep', grade: 'blocking', title: 'eval', file: 'a.js', line: 3 });
  const b = { ...a, line: 9 };
  assert.equal(findingKey(a), 'security|semgrep|a.js|eval');
  assert.equal(findingKey(a), findingKey(b));
  assert.equal(findingKey(makeFinding({ member: 'correctness', grade: 'warning', title: 'gap' })), 'correctness|ai||gap');
  assert.deepEqual(tally([a, { ...b, dismissed: true }, makeFinding({ member: 'legal', tool: 'x', grade: 'note', title: 'n' })]),
    { blocking: 1, warning: 0, note: 1 });
});

test('design and reliability are council members with their own labels', () => {
  assert.equal(MEMBER_LABEL.design, 'Design');
  assert.equal(MEMBER_LABEL.reliability, 'Reliability');
  assert.equal(makeFinding({ member: 'design', tool: 'page-gate', grade: 'blocking', title: 'x' }).maxGrade, 'blocking');
  assert.equal(makeFinding({ member: 'reliability', grade: 'blocking', title: 'no tool' }).grade, 'warning');
});
