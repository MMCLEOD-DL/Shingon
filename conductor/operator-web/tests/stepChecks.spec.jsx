import { describe, test, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { StepChecks, stepChecksSummary } from '../src/components/StepChecks.jsx';
import { eventText, phaseText } from '../src/text.js';

// Synthetic events in the shape the service sends (docs/operator-app/interface.md, "G4 step activity").
let seq = 0;
const progress = (data, message = 'Step activity.') => ({ schema: 1, runId: 'run-x', seq: ++seq, at: '2026-11-19T12:00:00.000Z', type: 'progress', phase: data.engineType, participant: null, message, data });
const gate = (index, attempt, of, result, failedStage = null, excerpt = null) => progress({ engineType: 'gate', index, attempt, of, result, failedStage, excerpt });

describe('step check summary', () => {
  test('groups attempts by step, in step order, and ignores other events', () => {
    const s = stepChecksSummary([
      gate(1, 1, 3, 'failed', 'types', 'src/a.ts(3,1): error TS2322'),
      progress({ engineType: 'chunk' }),
      gate(0, 1, 3, 'passed'),
      gate(1, 2, 3, 'passed'),
    ]);
    expect(s.map((x) => x.index)).toEqual([0, 1]);
    expect(s[1].attempts.map((a) => [a.attempt, a.result, a.failedStage])).toEqual([[1, 'failed', 'types'], [2, 'passed', null]]);
  });
  test('is null when a run has no step-check events', () => {
    expect(stepChecksSummary([progress({ engineType: 'chunk' })])).toBeNull();
    expect(stepChecksSummary(undefined)).toBeNull();
  });
});

describe('step checks section', () => {
  test('a failed attempt names its stage and attempt, and keeps the output behind a disclosure', () => {
    render(<StepChecks events={[gate(1, 1, 3, 'failed', 'types', 'src/a.ts(3,1): error TS2322'), gate(1, 2, 3, 'passed')]} />);
    const section = screen.getByRole('region', { name: 'Step checks' });
    expect(within(section).getByText('Step 2')).toBeTruthy();
    expect(within(section).getByText(/Attempt 1 of 3: failed at the “types” check\./)).toBeTruthy();
    expect(within(section).getByText(/Attempt 2 of 3: the checks passed\./)).toBeTruthy();
    expect(within(section).getByText('Output from the failed check')).toBeTruthy();
    expect(within(section).getByText('src/a.ts(3,1): error TS2322')).toBeTruthy();
  });
  test('a failure with no recorded output or stage says so instead of guessing', () => {
    render(<StepChecks events={[gate(0, 1, 2, 'failed', null, null)]} />);
    expect(screen.getByText(/Attempt 1 of 2: a check failed\. No output was recorded\./)).toBeTruthy();
  });
  test('files outside the expected set are a note for the reviewer, not a failure', () => {
    render(<StepChecks events={[progress({ engineType: 'scope-flag', index: 0, outside: ['src/b.js', 'src/c.js'], outsideCount: 2 })]} />);
    expect(screen.getByText(/Changed 2 files outside the plan's list for this step\. The reviewer was told; this alone does not fail the step\./)).toBeTruthy();
    expect(screen.getByText('src/b.js')).toBeTruthy();
    expect(screen.queryByText(/blocked/)).toBeNull();
  });
  test('a shortened file list says how many there were in all', () => {
    render(<StepChecks events={[progress({ engineType: 'scope-flag', index: 0, outside: ['a.js'], outsideCount: 140, truncated: true })]} />);
    expect(screen.getByText(/Showing 1 of 140 files; the rest were left out of the record\./)).toBeTruthy();
  });
  test('protected files block the attempt and name who changed them', () => {
    render(<StepChecks events={[progress({ engineType: 'protected-path', index: 2, files: ['app-profile.json'], fileCount: 1, participant: 'local' })]} />);
    const line = screen.getByText(/Changed 1 protected file, so this attempt was blocked before review \(local\)\./);
    expect(line.closest('li').className).toContain('warn');
    expect(screen.getByText('app-profile.json')).toBeTruthy();
  });
  test('an event without a step number is shown under "A step", not dropped', () => {
    render(<StepChecks events={[progress({ engineType: 'gate' })]} />);
    expect(screen.getByText('A step')).toBeTruthy();
    expect(screen.getByText(/An attempt: no result was recorded\./)).toBeTruthy();
  });
  test('hostile output and file names stay literal text: no markup, links or terminal codes', () => {
    const { container } = render(<StepChecks events={[
      gate(0, 1, 1, 'failed', '<b>lint</b>', '\x1b[31m<img src=x onerror=alert(1)> https://evil.example\x1b[0m'),
      progress({ engineType: 'scope-flag', index: 0, outside: ['<script>alert(1)</script>.js'], outsideCount: 1 }),
    ]} />);
    expect(container.querySelector('img, script, a, b')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)> https://evil.example')).toBeTruthy();
    expect(screen.getByText(/failed at the “<b>lint<\/b>” check/)).toBeTruthy();
    expect(screen.getByText('<script>alert(1)</script>.js')).toBeTruthy();
  });
  test('renders nothing for a run with no step checks', () => {
    const { container } = render(<StepChecks events={[progress({ engineType: 'chunk' })]} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('activity log and status line wording for step checks', () => {
  test('gate events read as plain sentences with the attempt', () => {
    expect(eventText(gate(1, 2, 3, 'failed', 'types', 'x'))).toBe('Step 2: attempt 2 of 3 failed at the “types” check.');
    expect(eventText(gate(0, 1, 3, 'passed'))).toBe('Step 1: attempt 1 of 3 passed its checks.');
    expect(eventText(progress({ engineType: 'scope-flag', index: 0, outside: ['a'], outsideCount: 1 }))).toBe("Step 1 changed 1 file outside the plan's list.");
    expect(eventText(progress({ engineType: 'protected-path', index: 0, files: ['a', 'b'], fileCount: 2 }))).toBe('Step 1 changed 2 protected files; the attempt was blocked before review.');
  });
  test("a gate event without usable fields keeps the service's own sentence", () => {
    expect(eventText(progress({ engineType: 'gate' }, 'Step gate activity.'))).toBe('Step gate activity.');
  });
  test('the status line says the step is being checked', () => {
    expect(phaseText('gate')).toBe('checking the step');
    expect(phaseText('scope-flag')).toBe('checking the step');
    expect(phaseText('protected-path')).toBe('checking the step');
  });
});
