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
};
const FINISH_TEXT = {
  landed: 'The branch was created.', // not "Branch created": that is the status label, and it stays unique on the page
  rejected: 'Rejected. No branch was created.',
  stopped: 'Stopped.',
  paused: 'Paused.',
  failed: 'Failed.',
};
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
  if (e?.type === 'progress' && (message === engineType || INTERNAL_NAME.test(message))) {
    return ENGINE_TEXT[message] ?? humanise(message);
  }
  return message;
}
