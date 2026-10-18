// src/escalation.js
import { IRREVERSIBLE_MARK } from './prompts.js';

const WHAT_HAPPENED = {
  plan: 'The two AI reviewers could not agree on the plan within the allowed rounds.',
  chunk: 'The two AI reviewers could not agree on one step of the work within the allowed rounds.',
  final: 'The final check of the finished work raised a concern.',
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARK_RE = new RegExp(`${escapeRe(IRREVERSIBLE_MARK)}\\s*`, 'gi');

export function plainReason(reason) {
  return String(reason ?? '').replace(MARK_RE, '').trim();
}

export function buildEscalation({ kind, title, reason, recommendation }) {
  const message = [
    `Conductor needs your decision on: ${title}`,
    `What happened: ${WHAT_HAPPENED[kind] ?? WHAT_HAPPENED.chunk}`,
    `The concern: ${plainReason(reason)}`,
    `Recommendation: ${recommendation}`,
    'Approve to continue with the current version, or reject to stop the run. Nothing in your repository changes either way until the final approval.',
  ].join('\n\n');
  return { kind, title, message, options: ['approve', 'reject'] };
}

export function buildSummary({ request, plan, notes = [], files = [], tests = null }) {
  const steps = (plan?.chunks ?? []).map((c, i) => `  ${i + 1}. ${c.title}`);
  const shown = files.slice(0, 30).join(', ');
  const more = files.length > 30 ? ` + ${files.length - 30} more` : '';
  const testLine = !tests?.ran ? 'not configured' : tests.passed ? 'passing' : 'FAILING';
  const lines = [
    `Request: ${request}`,
    `What was done (${steps.length} steps):`,
    ...steps,
    `Files changed (${files.length}): ${shown}${more}`,
    `Tests: ${testLine}`,
  ];
  if (notes.length) lines.push('Notes:', ...notes.map((n) => `  - ${n}`));
  return lines.join('\n');
}
