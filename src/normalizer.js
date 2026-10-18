// src/normalizer.js

// First ```diff ... ``` fenced block.
const DIFF_FENCE = /```diff\s*\n([\s\S]*?)```/i;
// VERDICT: APPROVE | BLOCK  (optional separator + reason), case-insensitive, one line.
const VERDICT_LINE = /^\s*VERDICT\s*:\s*(APPROVE|BLOCK)\s*(?:[-—:]\s*)?(.*)$/im;

function stripOuterFence(s) {
  // Remove a fence that opens at the very start and closes at the very end.
  const m = s.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return m ? m[1] : s;
}

export function normalize(rawText) {
  const raw = typeof rawText === 'string' ? rawText : '';

  const diffMatch = raw.match(DIFF_FENCE);
  const diff = diffMatch ? diffMatch[1].replace(/\s+$/, '') : null;

  const vMatch = raw.match(VERDICT_LINE);
  const verdict = vMatch
    ? { decision: vMatch[1].toUpperCase(), reason: vMatch[2].trim() }
    : null;

  // text is prose only: the extracted diff block and verdict line are control
  // data, so remove them from the human-readable text.
  let body = raw;
  if (diffMatch) body = body.replace(diffMatch[0], '');
  if (vMatch) body = body.replace(vMatch[0], '');
  const text = stripOuterFence(body.trim()).trim();
  return { text, diff, verdict };
}
