// Model output, file names, diffs and logs are untrusted. They are only ever rendered as
// React text (never as HTML), with terminal escapes and control characters removed.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f‪-‮⁦-⁩]/g; // also bidi overrides

export function plain(value, max = 20000) {
  const s = String(value ?? '').replace(ANSI, '').replace(CONTROL, '');
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters not shown here)` : s;
}

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
