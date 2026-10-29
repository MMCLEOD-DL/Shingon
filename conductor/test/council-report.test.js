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

test('fixChunk tells the fixer to fix the problem itself, never silence a scanner', () => {
  const c = fixChunk({ blocking: [] }, 1);
  assert.match(c.instructions, /Fix the problem itself\. Do not silence a scanner: no nosemgrep, nosec or gitleaks:allow comments, and no edits to scanner settings or ignore files\./);
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

test('"fixed during the review" needs the check to have run and the finding to be gone entirely', () => {
  const prior = { round: 1, blocking: [{ key: findingKey(evalF), title: evalF.title, member: 'security' }] };
  const run = (status) => [{ tool: 'semgrep', status, note: null }];
  const resolvedFor = (findings, toolRuns) => buildReport({ round: 2, findings, toolRuns, by: null, history: [prior] }).resolved;
  assert.deepEqual(resolvedFor([], run('ran')), ['[Security] Untrusted input reaches eval()'], 'genuinely fixed');
  assert.deepEqual(resolvedFor([], run('error')), [], 'the scanner errored: proves nothing');
  assert.deepEqual(resolvedFor([], []), [], 'the scanner is missing from this round');
  assert.deepEqual(resolvedFor([{ ...evalF, grade: 'warning' }], run('ran')), [], 'only downgraded');
  assert.deepEqual(resolvedFor([{ ...evalF, grade: 'blocking', dismissed: true }], run('ran')), [], 'set aside as a false alarm is not "fixed"');
});

test('fixChunk says "is" for one leftover problem and "are" for several', () => {
  const mk = (n) => buildReport({ round: 1, findings: Array.from({ length: n }, (_, i) => F({ member: 'security', grade: 'blocking', title: `b${i}`, detail: 'x'.repeat(2000) })), toolRuns: [], by: null });
  const t = fixChunk(mk(60), 1).instructions;
  assert.match(t, /\(\d+ more problems are listed in the council report\.\)$/);
});

test('an errored check is listed once, as its warning', () => {
  const run = { tool: 'gitleaks', label: 'Gitleaks (secret scanner)', status: 'error', note: 'Gitleaks (secret scanner) did not finish (it wrote no report), so this check gave no answer.',
    findings: [makeFinding({ member: 'security', tool: 'gitleaks', grade: 'warning', title: 'Gitleaks (secret scanner) could not run (it wrote no report)' })] };
  const r = buildReport({ round: 1, findings: run.findings, toolRuns: [run], by: null });
  assert.deepEqual(r.toolNotes, []);
  assert.equal(r.text.split('Gitleaks').length - 1, 1);
});

// ---------- Plan 9 Task 12: project rounds ----------
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeCouncilReport } from '../src/council/reportFile.js';

const projectReport = () => {
  const other = F({ member: 'legal', tool: 'data-policy', grade: 'warning', title: 'Personal data is held' });
  const notProven = F({ member: 'reliability', tool: 'smoke', grade: 'warning', locked: true, title: 'Reliability was not proven: no machine' });
  return buildReport({
    round: 1, findings: [other, notProven], toolRuns: [], by: 'codex',
    checked: ['Security: Semgrep (code scanner)', 'Reliability: nothing could run'],
    coverage: { proven: 2, total: 3 },
    files: { md: '/p/builds/r1/council-report.md', json: '/p/builds/r1/council-report.json', screenshots: '/p/builds/r1/council/round-1/screenshots' },
  });
};

test('project report: what was checked, worked examples proven, "not proven" first, and where the files are', () => {
  const r = projectReport();
  assert.ok(r.text.includes('What was checked:\n  - Security: Semgrep (code scanner)\n  - Reliability: nothing could run'));
  assert.ok(r.text.includes('  Worked examples proven: 2 of 3'));
  assert.ok(r.text.indexOf('Reliability was not proven: no machine') < r.text.indexOf('Personal data is held'));
  assert.equal(r.warnings[0].title, 'Reliability was not proven: no machine');
  assert.ok(r.text.endsWith('  Full report: /p/builds/r1/council-report.md\n  Screenshots: /p/builds/r1/council/round-1/screenshots'), r.text);
  assert.deepEqual(r.coverage, { proven: 2, total: 3 });
});

test('project report: no coverage line without coverage, no screenshots line without screenshots', () => {
  const r = buildReport({ round: 1, findings: [], toolRuns: [], by: null, checked: ['Design: nothing could run'], coverage: null,
    files: { md: '/p/m.md', json: '/p/m.json', screenshots: null } });
  assert.doesNotMatch(r.text, /Worked examples proven/);
  assert.ok(r.text.endsWith('What was checked:\n  - Design: nothing could run\n  Full report: /p/m.md'), r.text);
});

test('ordinary report: none of the project sections', () => {
  const r = buildReport({ round: 1, findings: [], toolRuns: [], by: null });
  assert.equal(r.checked, undefined);
  assert.equal(r.files, undefined);
  assert.doesNotMatch(r.text, /What was checked|Full report|Worked examples/);
});

test('fixChunk takes an optional size limit (Plan 8 clips fix instructions to 3000)', () => {
  const blocking = Array.from({ length: 40 }, (_, i) => F({ member: 'security', grade: 'blocking', title: `problem ${i}`, detail: 'x'.repeat(300) }));
  const c = fixChunk({ blocking }, 1, 3000);
  assert.ok(c.instructions.length <= 3000, String(c.instructions.length));
  assert.match(c.instructions, /more problems are listed in the council report/);
});

test('writeCouncilReport writes the text and the JSON (no text key) atomically, leaving no temp file', async () => {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'crep-')), 'builds', '20261027-100000-abcd');
  const r = projectReport();
  const out = await writeCouncilReport(dir, r);
  assert.deepEqual(out, { md: path.join(dir, 'council-report.md'), json: path.join(dir, 'council-report.json') });
  assert.equal(readFileSync(out.md, 'utf8'), r.text);
  const j = JSON.parse(readFileSync(out.json, 'utf8'));
  assert.equal(j.verdict, 'approved-with-warnings');
  assert.equal('text' in j, false);
  assert.deepEqual(j.coverage, { proven: 2, total: 3 });
  assert.deepEqual(j.checked, r.checked);
  assert.equal(j.files.md, '/p/builds/r1/council-report.md');
  assert.deepEqual(readdirSync(dir).sort(), ['council-report.json', 'council-report.md']);
});
