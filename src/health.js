// src/health.js
import { runCommand } from './exec.js';

export function classifyFailure(stderr = '') {
  const s = stderr.toLowerCase();
  if (/\b401\b|unauthorized|authentication token|\bsign in\b/.test(s)) return 'unauthorized';
  if (/unknown variant|unknown field|invalid value/.test(s)) return 'version-skew';
  if (/\b429\b|rate limit|limit reached/.test(s)) return 'rate-limit';
  return 'unavailable';
}

export async function checkHealth(adapter, { timeoutMs = 15000 } = {}) {
  const bin = adapter.bin ?? adapter.kind;
  const { stderr, code, timedOut } = await runCommand({ cmd: bin, args: ['--version'], timeoutMs });
  if (code === 0 && !timedOut) return { ok: true, reason: '' };
  if (timedOut) return { ok: false, reason: 'unavailable' };
  return { ok: false, reason: classifyFailure(stderr) };
}
