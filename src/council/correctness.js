// src/council/correctness.js
// Correctness member: the test command as locked evidence, plus a test-coverage check.
// Whether the change does what was asked is the interpreter's job (alwaysInterpret).
import { makeFinding } from './findings.js';
import { TOOL_LABEL } from './tools.js';
import { redact } from '../secrets.js';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { coverageFindings } from './coverage.js';
import { WIDTH } from './design.js';

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const DOC_FILE = /\.(md|txt|rst|adoc)$|(^|\/)docs?\//i;

const howFailed = (tests) => (tests.code === -1 || tests.code === null || tests.code === undefined ? 'the test command timed out' : `exit code ${tests.code}`);

export function testFindings(tests, baseTests = null) {
  if (!tests?.ran) {
    return [makeFinding({
      member: 'correctness', tool: 'tests', grade: 'note',
      title: 'No test command is set, so Correctness could only judge the change by reading it',
      detail: 'Set a test command for the project so the council can run the tests as evidence.',
    })];
  }
  if (tests.passed) return [];
  if (baseTests?.ran && baseTests.passed === false) {
    return [makeFinding({
      member: 'correctness', tool: 'tests', grade: 'warning', locked: true, preExisting: true,
      title: 'The tests fail, but they already failed before this change', // the exit code is in the detail
      detail: `${howFailed(tests)}\nThey also failed on the starting commit, so Conductor cannot tell whether this change broke anything more. Read the output:\n${tests.output}`,
    })];
  }
  return [makeFinding({
    member: 'correctness', tool: 'tests', grade: 'blocking', locked: true,
    title: 'The tests fail', // stable key across rounds; the exit code is in the detail
    detail: `${howFailed(tests)}\n${tests.output}`,
  })];
}

export function testFilesFinding(files) {
  const code = files.filter((f) => !TEST_FILE.test(f) && !DOC_FILE.test(f));
  if (code.length && !files.some((f) => TEST_FILE.test(f))) {
    return [makeFinding({
      member: 'correctness', tool: 'test-files', grade: 'warning',
      title: 'The change adds or edits no tests',
      detail: `Changed without tests: ${code.slice(0, 10).join(', ')}`,
    })];
  }
  return [];
}

// A failing test under here is Security's (the role-crossing harness), not Correctness's.
export const CROSSING_TEST = /^apps\/server\/test\/crossing\//;

const STEP_TITLE = Object.freeze({
  'npm-ci': "The app's packages could not be installed (npm ci failed)",
  lint: 'The lint check fails',
  typecheck: 'The type check fails',
  licences: 'The licence check fails',
  vitest: 'The tests fail',
  build: 'The web app does not build',
});
const COUNCIL_STEPS = ['npm-ci', 'lint', 'typecheck', 'licences', 'vitest', 'build'];
const GENERIC = "The foundation's checks fail (install, lint, types, licences or tests)";

const vfinding = (spec) => makeFinding({ member: 'correctness', tool: 'verify', grade: 'blocking', locked: true, ...spec });
const lastLines = (s, n) => String(s ?? '').split('\n').slice(-n).join('\n').trim();

// Ruling R9: crossing-only failures leave Correctness only when the crossing report is present.
// Without it Security has nothing to show for them, so they stay here.
function nonCrossingFailures(gates) {
  const failed = (gates.tests ?? []).filter((t) => t.status === 'failed');
  return gates.crossing ? failed.filter((t) => !CROSSING_TEST.test(t.file ?? '')) : failed;
}

export function verifyFindings(gates) {
  if (!gates?.source?.verify) return [];
  const out = [];
  if (gates.source.verify === 'council') {
    for (const step of COUNCIL_STEPS) {
      const code = gates.steps?.[step];
      if (code === null || code === undefined || code === 0) continue;
      if (step === 'vitest' && Array.isArray(gates.tests)) {
        const failed = gates.tests.filter((t) => t.status === 'failed');
        // Only crossing tests failed (and their report is present): Security's.
        if (failed.length && !nonCrossingFailures(gates).length) continue;
      }
      out.push(vfinding({ title: STEP_TITLE[step], detail: gates.logs?.[step] || 'The step failed with no output.' }));
    }
    return out;
  }
  const v = gates.verify;
  if (!v || v.status !== 'failed') return [];
  const anyFailed = Array.isArray(gates.tests) && gates.tests.some((t) => t.status === 'failed');
  if (anyFailed) {
    const bad = nonCrossingFailures(gates);
    if (!bad.length) return [];
    return [vfinding({ title: 'The tests fail', detail: bad.slice(0, 10).map((t) => `${t.title}: ${t.message ?? ''}`).join('\n') })];
  }
  return [vfinding({ title: GENERIC, detail: [v.summary, lastLines(redact(String(v.output ?? '')), 40)].filter(Boolean).join('\n') })];
}

export function journeyFindings(browser) {
  return (browser ?? [])
    .filter((c) => path.basename(String(c.file ?? '')) === 'flows.spec.ts' && !c.ok && !c.skipped)
    .map((c) => makeFinding({
      member: 'correctness', tool: 'journeys', grade: 'blocking', locked: true,
      title: `A user journey fails in the browser: ${c.title} (${WIDTH[c.project] ?? String(c.project)})`,
      detail: c.message || 'The journey failed.',
    }));
}

const MONEY_DIRS = /^(apps\/server\/src|packages\/shared\/src|apps\/web\/src)\//;
const MONEY_WORD = /\b(amount|price|total|subtotal|vat|tax|cost|net|gross|fee|mileage|pence|pounds)\w*/i;
const FLOAT_OP = /parseFloat\(|\*\s*\d*\.\d+/;
const TO_FIXED = /\.toFixed\(/;
const MAX_MONEY_FILE = 1024 * 1024;

export function moneyFindings({ dir, files }) {
  const out = [];
  for (const file of files ?? []) {
    if (out.length >= 10) break;
    if (!MONEY_DIRS.test(file) || !/\.tsx?$/.test(file) || TEST_FILE.test(file)) continue;
    let text;
    try {
      const p = path.join(dir, file);
      const st = lstatSync(p);
      if (!st.isFile() || st.size > MAX_MONEY_FILE) continue;
      text = readFileSync(p, 'utf8');
    } catch { continue; }
    const web = file.startsWith('apps/web/');
    const hits = [];
    text.split('\n').forEach((l, i) => {
      if (MONEY_WORD.test(l) && (FLOAT_OP.test(l) || (!web && TO_FIXED.test(l)))) hits.push(i + 1);
    });
    if (!hits.length) continue;
    out.push(makeFinding({
      member: 'correctness', tool: 'money', grade: 'warning', maxGrade: 'warning', file, line: hits[0],
      title: `${file} may work out money in floating point instead of whole pence`,
      detail: `${hits.length} line${hits.length === 1 ? '' : 's'} (first at line ${hits[0]}). Keep money in whole pence as integers.`,
    }));
  }
  return out;
}

const run = (tool, status, findings = [], extra = {}) => ({ tool, label: TOOL_LABEL[tool], status, findings, note: null, ...extra });

function projectRuns(input) {
  const ev = input.evidence ?? {};
  const gates = ev.gates ?? null;
  const out = [];
  if (!gates || !gates.source?.verify) {
    const why = ev.gatesNote || gates?.note || 'no reason was given';
    out.push(run('verify', 'skipped', [], { note: `The foundation's checks did not run in the council (${why}).` }));
  } else {
    out.push(run('verify', 'ran', verifyFindings(gates), {
      context: `The foundation's checks came from ${gates.source.verify === 'build' ? "the build's whole-app run" : "the council's own run"}.`,
    }));
  }
  out.push(run('test-files', 'ran', testFilesFinding(input.files ?? [])));

  if (!Array.isArray(gates?.tests) && !Array.isArray(gates?.browser)) {
    out.push(run('coverage', 'skipped', [makeFinding({
      member: 'correctness', tool: 'coverage', grade: 'warning', locked: true,
      title: 'Brief coverage was not proven: there was no test report',
      detail: 'The tests did not produce a report, so no worked example could be matched to a passing test.',
    })], { note: 'Brief coverage was not proven: there was no test report.' }));
  } else {
    const cases = [
      ...(gates.tests ?? []).map(({ title, status, message }) => ({ title, status, message })),
      ...(gates.browser ?? []).map((c) => ({ title: c.title, status: c.skipped ? 'skipped' : c.ok ? 'passed' : 'failed', message: c.message })),
    ];
    const r = coverageFindings(input.brief, cases);
    out.push(run('coverage', 'ran', r.findings, { context: r.lines, coverage: { proven: r.proven, total: r.total } }));
  }

  if (!Array.isArray(gates?.browser)) out.push(run('journeys', 'skipped', [], { note: 'The browser tests did not run, so no user journey was checked.' }));
  else out.push(run('journeys', 'ran', journeyFindings(gates.browser)));

  out.push(run('money', 'ran', moneyFindings({ dir: input.dir, files: input.files })));
  return out;
}

export const CORRECTNESS = {
  member: 'correctness',
  label: 'Correctness',
  alwaysInterpret: true,
  async collect(input) {
    if (input.brief) return projectRuns(input);
    return [
      {
        tool: 'tests', label: TOOL_LABEL.tests, status: input.tests?.ran ? 'ran' : 'skipped',
        findings: testFindings(input.tests, input.baseTests ?? null), note: null,
      },
      {
        tool: 'test-files', label: TOOL_LABEL['test-files'], status: 'ran',
        findings: testFilesFinding(input.files ?? []), note: null,
      },
    ];
  },
};
