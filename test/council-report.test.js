import { test } from 'node:test';
import assert from 'node:assert/strict';
import { councilVerdict, buildReport, reportText, fixChunk } from '../src/council/report.js';
import { makeFinding, findingKey } from '../src/council/findings.js';

const F = (o) => Object.assign(makeFinding({ tool: 'semgrep', grade: 'warning', ...o }), o.extra ?? {});
const evalF = F({ member: 'security', grade: 'blocking', title: 'Untrusted input reaches eval()', file: 'src/a.js', line: 4, detail: 'rule js.eval',
  extra: { why: 'anyone could run code on the server', fix: 'parse the value with JSON.parse instead' } });
const testsF = F({ member: 'correctness', tool: 'tests', grade: 'blocking', locked: true, title: 'The tests fail (exit code 1)', detail: 'not ok 3' });
const oldF = F({ member: 'security', grade: 'warning', title: 'old eval', file: 'old.js', line: 2, preExisting: true });
const noteF = F({ member: 'legal', tool: null, grade: 'note', title: 'licence file looks fine' });
const fpF = F({ member: 'security', grade: 'warning', title: 'key in fixture', file: 'test/x.js', extra: { dismissed: true, why: 'it is a test fixture' } });
const RUNS = [
  { tool: 'gitleaks', status: 'missing', note: 'Gitleaks (secret scanner) is not installed, so this check did not run.' },
  { tool: 'semgrep', status: 'ran', note: null },
  { tool: 'tests', status: 'skipped', note: null },   // no test command: its note finding says so; no empty line here
];

test('councilVerdict: any blocking blocks; set-aside findings do not count', () => {
  assert.equal(councilVerdict([evalF, oldF]), 'blocked');
  assert.equal(councilVerdict([oldF, fpF]), 'approved-with-warnings');
  assert.equal(councilVerdict([noteF, { ...evalF, dismissed: true }]), 'approved');
});

test('the report reads as plain English for the operator', () => {
  const r = buildReport({ round: 2, findings: [testsF, evalF, oldF, noteF, fpF], toolRuns: RUNS, by: 'codex',
    history: [{ round: 1, blocking: [{ key: 'security|semgrep|src/b.js|SQL built from user input', title: 'SQL built from user input', member: 'security' }] }] });
  assert.equal(r.verdict, 'blocked');
  assert.deepEqual(r.resolved, ['[Security] SQL built from user input']);
  assert.equal(r.text, [
    'Council report: NOT approved: 2 blocking problems remain',
    '  Round 2 · checked by codex',
    'Fixed during the review (1):',
    '  - [Security] SQL built from user input',
    'Still blocking (2):',
    '  - [Security] Untrusted input reaches eval(): anyone could run code on the server (found by Semgrep (code scanner), src/a.js:4)',
    '  - [Correctness] The tests fail (exit code 1) (found by the test command)',
    'Warnings (1):',
    '  - [Security] old eval (found by Semgrep (code scanner), old.js:2) — already there before this change',
    'Notes (1):',
    '  - [Legal] licence file looks fine',
    'Set aside as false alarms (1):',
    '  - [Security] key in fixture: it is a test fixture (found by Semgrep (code scanner), test/x.js)',
    'Checks that did not run:',
    '  - Gitleaks (secret scanner) is not installed, so this check did not run.',
  ].join('\n'));
  assert.equal(reportText({ ...r, overridden: true }).split('\n')[0], 'Council report: NOT approved: 2 blocking problems remain, and you chose to continue');
  assert.deepEqual(r.toolNotes, ['Gitleaks (secret scanner) is not installed, so this check did not run.']);
  assert.doesNotMatch(r.text, /null/);
});

test('approved headings, the tools-only line, and long sections are capped', () => {
  assert.equal(buildReport({ round: 1, findings: [], toolRuns: [], by: null }).text, 'Council report: approved, nothing to fix\n  Round 1 · checked by the tools only');
  assert.equal(buildReport({ round: 1, findings: [oldF], toolRuns: [], by: 'codex' }).text.split('\n')[0], 'Council report: approved, with 1 warning to read');
  const many = Array.from({ length: 25 }, (_, i) => F({ member: 'security', title: `w${i}` }));
  const text = buildReport({ round: 1, findings: many, toolRuns: [], by: 'codex' }).text;
  assert.match(text, /^Warnings \(25\):$/m);
  assert.match(text, /^ {2}… and 5 more \(see the run log\)$/m);
});

test('a problem that blocked earlier and still blocks is not "fixed"', () => {
  const r = buildReport({ round: 2, findings: [evalF], toolRuns: [], by: 'codex', history: [{ round: 1, blocking: [{ key: findingKey(evalF), title: evalF.title, member: 'security' }] }] });
  assert.deepEqual(r.resolved, []);
});

test('fixChunk carries every blocking finding with its evidence, and nothing else', () => {
  const r = buildReport({ round: 1, findings: [evalF, testsF, oldF], toolRuns: [], by: 'codex' });
  const c = fixChunk(r, 1);
  assert.equal(c.title, 'Council fixes, round 1');
  assert.equal(c.councilFix, 1, 'marks a council fix step in the plan');
  assert.match(c.instructions, /^The review council found problems that must be fixed before this change can ship\./);
  assert.match(c.instructions, /1\. \[Security\] Untrusted input reaches eval\(\) — src\/a\.js:4\n {3}Evidence \(Semgrep \(code scanner\)\): rule js\.eval\n {3}Why it matters: anyone could run code on the server\n {3}Suggested fix: parse the value with JSON\.parse instead/);
  assert.match(c.instructions, /2\. \[Correctness\] The tests fail \(exit code 1\)\n {3}Evidence \(the test command\): not ok 3/);
  assert.doesNotMatch(c.instructions, /old eval/);
  const huge = buildReport({ round: 1, findings: Array.from({ length: 60 }, (_, i) => F({ member: 'security', grade: 'blocking', title: `b${i}`, detail: 'x'.repeat(2000) })), toolRuns: [], by: null });
  assert.ok(fixChunk(huge, 2).instructions.length <= 7100);
});
