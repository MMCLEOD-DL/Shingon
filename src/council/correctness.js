// src/council/correctness.js
// Correctness member: the test command as locked evidence, plus a test-coverage check.
// Whether the change does what was asked is the interpreter's job (alwaysInterpret).
import { makeFinding } from './findings.js';
import { TOOL_LABEL } from './tools.js';

export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[cm]?[jt]sx?$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
const DOC_FILE = /\.(md|txt|rst|adoc)$|(^|\/)docs?\//i;

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
      title: `The tests fail (exit code ${tests.code}), but they already failed before this change`,
      detail: `They also failed on the starting commit, so Conductor cannot tell whether this change broke anything more. Read the output:\n${tests.output}`,
    })];
  }
  return [makeFinding({
    member: 'correctness', tool: 'tests', grade: 'blocking', locked: true,
    title: 'The tests fail', // stable key across rounds; the exit code is in the detail
    detail: `${tests.code === -1 || tests.code === null || tests.code === undefined ? 'the test command timed out' : `exit code ${tests.code}`}\n${tests.output}`,
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

export const CORRECTNESS = {
  member: 'correctness',
  label: 'Correctness',
  alwaysInterpret: true,
  async collect(input) {
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
