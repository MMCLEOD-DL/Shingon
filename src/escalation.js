// src/escalation.js
import { IRREVERSIBLE_MARK } from './prompts.js';

// What happened, by kind and by the settlement's situation (see settleDeadlock).
const WHAT_HAPPENED = {
  plan: {
    disagree: 'The two AI reviewers could not agree on the plan within the allowed rounds.',
    unreviewed: 'The AI reviewer could not check the plan (it failed or gave no clear answer).',
    irreversible: 'The two AI reviewers could not agree on the plan, and the open concern is about something hard to undo.',
  },
  chunk: {
    disagree: 'The two AI reviewers could not agree on one step of the work within the allowed rounds.',
    unreviewed: 'The AI reviewer could not check this step (it failed or gave no clear answer).',
    'tests-failing': 'The tests are failing, and the AI reviewers could not agree on this step within the allowed rounds.',
    irreversible: 'The two AI reviewers could not agree on one step of the work, and the open concern is about something hard to undo.',
    unproduced: 'Neither AI produced a usable version of this step.',
  },
  final: {
    disagree: 'The final check of the finished work raised a concern.',
  },
};

function whatHappened(kind, situation) {
  const byKind = WHAT_HAPPENED[kind] ?? WHAT_HAPPENED.chunk;
  return byKind[situation] ?? byKind.disagree;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARK_RE = new RegExp(`${escapeRe(IRREVERSIBLE_MARK)}\\s*`, 'gi');

export function plainReason(reason) {
  return String(reason ?? '').replace(MARK_RE, '').trim();
}

export function buildEscalation({ kind, title, reason, recommendation, situation = 'disagree' }) {
  const message = [
    `Conductor needs your decision on: ${title}`,
    `What happened: ${whatHappened(kind, situation)}`,
    `The concern: ${plainReason(reason)}`,
    `Recommendation: ${recommendation}`,
    'Approve to continue with the current version, or reject to stop the run. Nothing in your repository changes either way until the final approval.',
  ].join('\n\n');
  return { kind, title, message, options: ['approve', 'reject'] };
}

export function buildSummary({ request, plan, notes = [], files = [], tests = null, source = null, warnings = [] }) {
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
  if (source?.sha) {
    // The workspace is a clone of committed HEAD: say so, and say what was left out (m5).
    const where = source.branch ? `on branch ${source.branch}` : 'on a detached HEAD';
    lines.push(`Started from commit ${source.sha.slice(0, 7)} ${where}${source.dirty ? '; your uncommitted changes were not included.' : '.'}`);
  }
  lines.push(...warnings);
  if (notes.length) lines.push('Notes:', ...notes.map((n) => `  - ${plainReason(n)}`));
  return lines.join('\n');
}
