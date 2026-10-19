// src/health.js
import { runCommand } from './exec.js';

export function classifyFailure(stderr = '') {
  const s = stderr.toLowerCase();
  if (/\b401\b|unauthorized|authentication token|\bsign in\b/.test(s)) return 'unauthorized';
  if (/unknown variant|unknown field|invalid value/.test(s)) return 'version-skew';
  if (/\b429\b|rate limit|limit reached/.test(s)) return 'rate-limit';
  return 'unavailable';
}

// The backend or the CLI's connection to it is broken (not the model's work):
// another attempt against the same participant will fail the same way.
const INFRASTRUCTURE = /stream disconnected|response\.failed|connection refused|econnrefused|error sending request|failed to connect|could not resolve host|service unavailable|\b50[234]\b|\b401\b|unauthorized|\b429\b|rate limit/i;

export function isInfrastructureFailure(text = '') {
  return INFRASTRUCTURE.test(String(text));
}

// The prompt did not fit the model's context window: sending it again cannot help.
const CONTEXT_OVERFLOW = /context (length|window|size)|maximum context|exceeds? the (available )?context|n_ctx|too many tokens|prompt is too long/i;

export function isContextOverflow(text = '') {
  return CONTEXT_OVERFLOW.test(String(text));
}

const LINE_MAX = 300;

// A short, readable reason from a failed CLI run: its last distinct `ERROR:` lines
// (Codex retry chatter dropped), else its last non-empty line. Never the banner or
// the echoed prompt, so a retry note cannot grow by nesting earlier output.
export function summarizeFailure(text = '') {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const errors = [...new Set(lines.filter((l) => /^error:/i.test(l) && !/reconnecting\.\.\./i.test(l)))];
  const picked = errors.length ? errors.slice(-2) : lines.slice(-1);
  return picked.map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l)).join(' / ');
}

export async function checkHealth(adapter, { timeoutMs = 15000 } = {}) {
  const bin = adapter.bin ?? adapter.kind;
  const { stderr, code, timedOut } = await runCommand({ cmd: bin, args: ['--version'], timeoutMs });
  if (code === 0 && !timedOut) return { ok: true, reason: '' };
  if (timedOut) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: classifyFailure(stderr) };
}
