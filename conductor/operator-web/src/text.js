// Model output, file names, diffs and logs are untrusted. They are only ever rendered as
// React text (never as HTML), with terminal escapes and control characters removed.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g; // also bidi overrides

const clean = (value) => String(value ?? '').replace(ANSI, '').replace(CONTROL, '');

export function plain(value, max = 20000) {
  const s = clean(value);
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters not shown here)` : s;
}

/** True when plain(value, max) shows all of value: decided from the text itself, never from what was rendered. */
export const shownInFull = (value, max) => clean(value).length <= max;

export const shortSha = (sha) => (typeof sha === 'string' && /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 10) : 'none');

export function when(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown time' : d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Plain-English run status: what it means for the operator, not the internal label. */
export const STATUS_TEXT = {
  queued: 'Waiting to start',
  running: 'Working',
  'awaiting-decision': 'Needs your decision',
  cancelling: 'Stopping (not yet confirmed)',
  paused: 'Paused',
  interrupted: 'Interrupted',
  completed: 'Branch created',
  rejected: 'Rejected — no branch created',
  failed: 'Failed',
};
export const statusText = (s) => STATUS_TEXT[s] ?? `Unknown state (${plain(s, 40)})`;

/** What a run is busy with, from the service's `phase`, which is often the engine's latest internal step. */
const PHASE_TEXT = {
  checking: 'getting ready', start: 'starting', resume: 'resuming',
  plan: 'planning', 'plan-agreed': 'planning', 'split-agreed': 'planning',
  chunks: 'coding', chunk: 'coding', 'chunk-done': 'coding', 'chunk-fallback': 'coding',
  call: 'working', result: 'working', phase: 'moving to the next stage',
  final: 'final review', landing: 'creating the branch',
  gate: 'checking the step', 'scope-flag': 'checking the step', 'protected-path': 'checking the step',
};
/** Plain words for a phase, or null when there is nothing meaningful to say (never the internal label). */
export const phaseText = (p) => PHASE_TEXT[p] ?? null;

// When the engine sends no sentence, the service falls back to the engine's internal event name
// (first live run, 31 October 2026: "chunk", "phase", "plan-agreed"…). Those become plain words here.
const ENGINE_TEXT = {
  start: 'Started.',
  resume: 'Resumed.',
  phase: 'Moved on to the next stage.',
  'plan-agreed': 'The plan was agreed.',
  'split-agreed': 'The models agreed how to split the work.',
  chunk: 'Started the next coding step.',
  'chunk-done': 'Finished a coding step.',
  'chunk-fallback': 'The local model could not finish this step, so a subscription model is taking over.',
  'local-fallback-approved': 'You allowed subscription models to cover for the local model.',
  'local-fallback-declined': 'You chose not to use subscription models, so the run paused.',
  'local-recheck': 'Checked whether the local model is available again.',
  'same-vendor-review': 'This step was reviewed by a model from the same company that wrote it.',
  deadlock: 'The models could not agree on this step.',
  escalation: 'The models disagree, so your decision is needed.',
  decision: 'Your decision was recorded.',
  'gate-note': 'A note was added for your final review.',
  'landed-before-crash': 'The branch had already been created before the interruption.',
  // K8 knowledge-base evidence (the engine's knowledge/run.js). Never names documents or passages.
  'evidence-used': 'Evidence from the company knowledge base was given to the models.',
  'evidence-withheld': 'Some knowledge-base evidence was kept from the models by its data policy.',
  'evidence-dropped': 'Knowledge-base evidence was dropped because its policy could not be confirmed; the run carried on without it.',
  'evidence-stopped': 'The knowledge-base policy could not be confirmed after its evidence was used, so nothing built from it was passed on.',
  'evidence-unavailable': 'The knowledge base was not available, so the run carried on without its evidence.',
  interrupted: 'Interrupted.',
  finish: 'Finished.',
};
const DECISION_TEXT = {
  approve: 'You approved it.',
  reject: 'You rejected it.',
  pause: 'You chose to pause.',
  continue: 'You chose to use your subscriptions.',
  // Item 7: the service resolves the question itself once the worker's readiness URL answers; the operator chose
  // nothing here. The same line follows a worker that was already up (the command did not run), so it claims only
  // that the worker is ready; the line before it says which case it was.
  'Worker started; re-probing the local model.': 'The local worker is ready. Checking the local model again.',
};
const FINISH_TEXT = {
  landed: 'The branch was created.', // not "Branch created": that is the status label, and it stays unique on the page
  rejected: 'Rejected. No branch was created.',
  stopped: 'Stopped.',
  paused: 'Paused.',
  failed: 'Failed.',
};
/** The engine's reason sentence from the last `finished` event, or null when it was only a status word. */
export function finishReason(events) {
  const e = [...(events ?? [])].reverse().find((x) => x?.type === 'finished');
  const message = e ? plain(e.message, 1000).trim() : '';
  return message && !FINISH_TEXT[message] ? message : null;
}
// G4 step checks (interface.md, "G4 step activity"): the activity line is built from the fields, so it can name the
// attempt. Without usable fields the service's own sentence is kept.
const STEP_TYPES = new Set(['gate', 'scope-flag', 'protected-path']);
const positive = (n) => Number.isSafeInteger(n) && n > 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
/** The activity-log sentence for a step-check event, or null to keep the service's sentence. */
export function stepEventText(d) {
  if (!STEP_TYPES.has(d?.engineType)) return null;
  const step = Number.isSafeInteger(d.index) && d.index >= 0 ? `Step ${d.index + 1}` : 'A step';
  if (d.engineType === 'gate') {
    if (d.result !== 'passed' && d.result !== 'failed') return null;
    const attempt = positive(d.attempt) ? `attempt ${d.attempt}${positive(d.of) ? ` of ${d.of}` : ''}` : 'an attempt';
    if (d.result === 'passed') return `${step}: ${attempt} passed its checks.`;
    return `${step}: ${attempt} failed${typeof d.failedStage === 'string' && d.failedStage ? ` at the “${plain(d.failedStage, 256)}” check` : ''}.`;
  }
  const files = Array.isArray(d.engineType === 'scope-flag' ? d.outside : d.files) ? (d.engineType === 'scope-flag' ? d.outside : d.files).filter((f) => typeof f === 'string') : [];
  const total = d.engineType === 'scope-flag' ? d.outsideCount : d.fileCount;
  const n = Number.isSafeInteger(total) && total >= files.length ? total : files.length;
  if (!n) return null;
  return d.engineType === 'scope-flag'
    ? `${step} changed ${plural(n, 'file')} outside the plan's list.`
    : `${step} changed ${plural(n, 'protected file')}; the attempt was blocked before review.`;
}

const INTERNAL_NAME = /^[a-z]+(?:-[a-z]+)*$/; // a sentence always has a space or a full stop
const humanise = (name) => { const s = name.replace(/[-_]+/g, ' '); return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`; };

/**
 * The activity-log line for one event. A sentence from the service is kept as it is; an internal name is
 * translated, and an unknown one is at least shown as words rather than as a code.
 */
export function eventText(e) {
  const message = plain(e?.message, 1000);
  const engineType = e?.data?.engineType;
  if (e?.type === 'decision-resolved') return DECISION_TEXT[message] ?? `You chose: ${message}.`;
  if (e?.type === 'finished' && FINISH_TEXT[message]) return FINISH_TEXT[message];
  if (e?.type === 'progress') { const step = stepEventText(e.data); if (step) return step; }
  if (e?.type === 'progress' && (message === engineType || INTERNAL_NAME.test(message))) {
    return ENGINE_TEXT[message] ?? humanise(message);
  }
  return message;
}

/**
 * The activity-log lines for a run, one per event. The service sends an escalation's summary twice: as a progress
 * event and as the decision-pending event right after it (Windows round 2, Part E2). A progress line that repeats the
 * next question word for word is replaced by a short sentence, so the question is shown once.
 */
export function activityText(events) {
  const list = events ?? [];
  const same = (a, b) => plain(a?.message, 1000).trim() === plain(b?.message, 1000).trim();
  return list.map((e, i) => {
    if (e?.type === 'progress' && plain(e.message, 1000).trim()) {
      const question = list.slice(i + 1).find((x) => x?.type !== 'progress');
      if (question?.type === 'decision-pending' && same(e, question)) {
        return ENGINE_TEXT[e.data?.engineType] ?? 'Your decision is needed; the question follows.';
      }
    }
    return eventText(e);
  });
}
