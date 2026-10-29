// First ```diff ... ``` fenced block (closing fence line-anchored).
const DIFF_FENCE = /```diff[ \t]*\n([\s\S]*?)\n```/i;
// VERDICT line: horizontal-whitespace only (no ReDoS), tolerant of leading
// markdown/quote decoration and trailing emphasis; APPROVED/BLOCKED accepted.
// Global: the LAST VERDICT line wins (Ruling 12), so a reviewer quoting "VERDICT: APPROVE"
// from an agent-written diff earlier in its reply cannot approve the work.
const VERDICT_LINE = /^[>*_#\t ]*VERDICT[ \t]*:[ \t]*(APPROVED?|BLOCK(?:ED)?)[ \t]*(?:[-—:][ \t]*)?(.*?)[*_\t ]*$/gim;

function stripOuterFence(s) {
  const m = s.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  if (!m) return s;
  // only strip when ONE fence wraps the whole reply (no other fence line inside)
  if (/^```/m.test(m[1])) return s;
  return m[1];
}

export function normalize(rawText) {
  const raw = typeof rawText === 'string' ? rawText : '';

  const diffMatch = raw.match(DIFF_FENCE);
  const diff = diffMatch ? diffMatch[1].replace(/\s+$/, '') : null;

  // Remove the diff block before scanning for the verdict/prose, so a context
  // line inside the diff cannot be mistaken for the verdict.
  let body = diffMatch ? raw.replace(diffMatch[0], '') : raw;

  const vMatch = [...body.matchAll(VERDICT_LINE)].at(-1);
  let verdict = null;
  if (vMatch) {
    const decision = vMatch[1].toUpperCase().startsWith('APPROVE') ? 'APPROVE' : 'BLOCK';
    verdict = { decision, reason: vMatch[2].trim() };
    body = body.slice(0, vMatch.index) + body.slice(vMatch.index + vMatch[0].length);
  }

  const text = stripOuterFence(body.trim()).trim();
  return { text, diff, verdict };
}
