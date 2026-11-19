import { describe, test, expect } from 'vitest';
import { activityText, eventText, phaseText, finishReason } from '../src/text.js';

// First live run, 31 October 2026: the activity log and status line showed the engine's internal names.
describe('plain words for engine steps', () => {
  const progress = (message, engineType) => ({ type: 'progress', message, data: engineType ? { engineType } : {} });

  test('internal step names become sentences', () => {
    expect(eventText(progress('chunk', 'chunk'))).toBe('Started the next coding step.');
    expect(eventText(progress('plan-agreed', 'plan-agreed'))).toBe('The plan was agreed.');
    expect(eventText(progress('phase', 'phase'))).toBe('Moved on to the next stage.');
    expect(eventText(progress('chunk-done'))).toBe('Finished a coding step.');
  });
  test('an unknown internal name is still shown as words, not as a code', () => {
    expect(eventText(progress('council-base-tests', 'council-base-tests'))).toBe('Council base tests.');
  });
  test("the service's own sentences are kept exactly", () => {
    expect(eventText(progress('claude is working as author.', 'call'))).toBe('claude is working as author.');
    expect(eventText({ type: 'cancel-requested', message: 'Stopping the owned worker; cancellation is not yet confirmed.' }))
      .toBe('Stopping the owned worker; cancellation is not yet confirmed.');
  });
  test('answers and outcomes read as what happened', () => {
    expect(eventText({ type: 'decision-resolved', message: 'approve' })).toBe('You approved it.');
    expect(eventText({ type: 'decision-resolved', message: 'pause' })).toBe('You chose to pause.');
    expect(eventText({ type: 'finished', message: 'landed' })).toBe('The branch was created.');
    expect(eventText({ type: 'finished', message: 'You did not approve the plan, so nothing was changed.' }))
      .toBe('You did not approve the plan, so nothing was changed.');
  });
  // K8: knowledge-base evidence events (conductor/src/knowledge/run.js). The service forwards them as progress events
  // with no sentence of their own; the run's activity log says what happened, never which documents or passages.
  test('the knowledge-base evidence events read as what happened', () => {
    expect(eventText(progress('evidence-used', 'evidence-used'))).toBe('Evidence from the company knowledge base was given to the models.');
    expect(eventText(progress('evidence-withheld', 'evidence-withheld'))).toBe('Some knowledge-base evidence was kept from the models by its data policy.');
    expect(eventText(progress('evidence-dropped', 'evidence-dropped'))).toBe('Knowledge-base evidence was dropped because its policy could not be confirmed; the run carried on without it.');
    expect(eventText(progress('evidence-stopped', 'evidence-stopped'))).toBe('The knowledge-base policy could not be confirmed after its evidence was used, so nothing built from it was passed on.');
    expect(eventText(progress('evidence-unavailable', 'evidence-unavailable'))).toBe('The knowledge base was not available, so the run carried on without its evidence.');
    expect(phaseText('evidence-used')).toBeNull();
  });
  test('untrusted text is still cleaned', () => {
    expect(eventText({ type: 'progress', message: 'done \x1b[31mred', data: {} })).toBe('done red');
  });
  test('the status line names the stage in plain words, or says nothing', () => {
    expect(phaseText('checking')).toBe('getting ready');
    expect(phaseText('chunk')).toBe('coding');
    expect(phaseText('landing')).toBe('creating the branch');
    expect(phaseText('something-new')).toBeNull();
  });
});

describe('the engine reason for a finished run', () => {
  const BASELINE = 'The configured tests already fail or could not run before any changes. Fix the tests or test command, then start a new run. See the run transcript for the test output.';
  const finished = (message) => ({ type: 'finished', message });
  test('a bare status word is not a reason', () => {
    expect(finishReason([finished('stopped')])).toBeNull();
  });
  test('a sentence from the last finished event is the reason', () => {
    expect(finishReason([{ type: 'progress', message: 'start' }, finished(BASELINE)])).toBe(BASELINE);
  });
  test('no finished event gives no reason', () => {
    expect(finishReason([{ type: 'progress', message: 'start' }])).toBeNull();
    expect(finishReason([])).toBeNull();
  });
});

// Windows round 2, Part E2 (19 Nov 2026): the service sends the escalation's summary twice, once as a
// progress/escalation event and once as the decision-pending event, so the activity log said the same thing twice.
describe('activity log lines', () => {
  const summary = 'The tests are failing after the allowed attempts to fix this step.';
  const ev = (seq, type, message, data = null) => ({ seq, type, message, data });
  test('a progress line that repeats the question that follows it is replaced by a short sentence', () => {
    const lines = activityText([
      ev(1, 'progress', 'deadlock', { engineType: 'deadlock' }),
      ev(2, 'progress', summary, { engineType: 'escalation' }),
      ev(3, 'decision-pending', summary, { decisionId: 'd1' }),
    ]);
    expect(lines).toEqual(['The models could not agree on this step.', 'The models disagree, so your decision is needed.', summary]);
  });
  test('the same text is kept when no question follows, or a different one does', () => {
    expect(activityText([ev(1, 'progress', summary, { engineType: 'escalation' })])).toEqual([summary]);
    expect(activityText([
      ev(1, 'progress', summary, { engineType: 'escalation' }),
      ev(2, 'decision-pending', 'Review this step.', {}),
    ])).toEqual([summary, 'Review this step.']);
  });
  test('only the question right after it counts, and an unknown event type gets a generic sentence', () => {
    expect(activityText([
      ev(1, 'progress', summary, { engineType: 'something-new' }),
      ev(2, 'decision-pending', summary, {}),
      ev(3, 'decision-resolved', 'reject', {}),
      ev(4, 'decision-pending', summary, {}),
    ])).toEqual(['Your decision is needed; the question follows.', summary, 'You rejected it.', summary]);
  });
  test('one line per event, so the count matches', () => {
    expect(activityText(undefined)).toEqual([]);
  });
});
