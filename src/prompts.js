// src/prompts.js
// Every prompt the loop sends. Role system prompts and the VERDICT line format
// come from roles.js; these are the task bodies.
import { clip } from './text.js';
import { redact } from './secrets.js';
import { TOOL_LABEL } from './council/tools.js';
import { OUTBOUND_SERVICES } from './factory/outbound.js';

// Redact before clipping: a key split by the clip point would otherwise survive as a fragment.
const show = (text, max) => clip(redact(typeof text === 'string' ? text : ''), max);
const TEXT_MAX = 8000; // request, chunk instructions, feedback
const FAILURE_MAX = 600; // a failed attempt's reason: the agent needs the gist, not a log

export const IRREVERSIBLE_MARK = 'IRREVERSIBLE:';

const BLOCK_RULES =
  'Block only for substantive problems, each with a concrete reason. Not for style or preference. ' +
  `If a concern is about something hard to undo (data loss, deleting user work, a public API break, ` +
  `a schema or data migration), start your reason with "${IRREVERSIBLE_MARK}".`;

export function formatTests(tests) {
  if (!tests?.ran) return 'Tests: not configured for this project.';
  if (tests.passed) return 'Tests: PASSED';
  return `Tests: FAILED (exit ${tests.code})\n${show(tests.output, 4000)}`;
}

const PRODUCE_FAILED = /^could not produce a result: /;

// feedbackKind: 'blocked' (a reviewer objected) or 'failed' (the attempt itself did not work).
function feedbackText(feedback, feedbackKind, say) {
  if (!feedback) return '';
  // Clip the combined feedback (reason + reviewer's full notes).
  const raw = feedbackKind === 'failed' ? String(feedback).replace(PRODUCE_FAILED, '') : String(feedback);
  const f = show(raw, feedbackKind === 'failed' ? FAILURE_MAX : TEXT_MAX);
  return feedbackKind === 'failed' ? say.failed(f) : say.blocked(f);
}

// A diff the reviewer only sees part of: tell it where the rest is, and to BLOCK if it cannot judge (T8-M5).
function diffBlock(label, diff, max, base) {
  const d = typeof diff === 'string' ? diff : '';
  if (!d) return `${label}\n(no changes)`;
  const note = d.length > max
    ? '\n\nThe diff above was shortened. The full change is in your current directory: ' +
      `run \`git diff ${base ?? 'HEAD'}\` to see it. If you still cannot judge it, BLOCK and say so.`
    : '';
  return `${label}\n${show(d, max)}${note}`;
}

function planBlock(plan) {
  return `Plan summary: ${plan.summary || '(none)'}\n` +
    plan.chunks.map((c, i) => `${i + 1}. ${c.title}`).join('\n');
}

export function planAuthor({ request, maxChunks, feedback, feedbackKind = 'blocked', firstChunk = null }) {
  return [
    `User request:\n${show(request, TEXT_MAX)}`,
    'You are planning work in the repository in your current directory. Read what you need; do not edit files.',
    firstChunk && `Step 1 is already fixed and runs first:\n${firstChunk.title}: ${show(firstChunk.instructions, 3000)}\nPlan only the steps after it; do not repeat it.`,
    'Write a short architecture summary, then an ordered list of small chunks. Each chunk must be small enough ' +
      'for a modest local coding model to finish in one run: one focused change plus its tests. ' +
      `At most ${maxChunks} chunks.`,
    'End your reply with one ```json block of exactly this shape:\n' +
      '{"summary": "...", "chunks": [{"title": "...", "instructions": "..."}]}',
    feedbackText(feedback, feedbackKind, {
      blocked: (f) => `A reviewer blocked your previous plan:\n${f}\nRevise the plan to address it.`,
      failed: (f) => `Your previous reply could not be used as a plan: ${f}\nReply again, ending with the \`\`\`json block described above.`,
    }),
  ].filter(Boolean).join('\n\n');
}

export function planReview({ request, planText, firstChunk = null }) {
  return [
    `User request:\n${show(request, TEXT_MAX)}`,
    firstChunk && `Step 1, fixed in advance: ${firstChunk.title}\n${show(firstChunk.instructions, 3000)}`,
    `Proposed plan:\n${show(planText, 20000)}`,
    'Review this plan. Check: wrong approach, missing requirements, chunks too large or in the wrong order, unsafe changes.',
    BLOCK_RULES,
  ].filter(Boolean).join('\n\n');
}

export function chunkExec({ request, plan, chunk, index, total, feedback, feedbackKind = 'blocked' }) {
  return [
    `Overall request:\n${show(request, TEXT_MAX)}`,
    planBlock(plan),
    `You are doing chunk ${index + 1} of ${total}: ${chunk.title}\n${show(chunk.instructions, TEXT_MAX)}`,
    'Work only inside the current directory. Make the edits, run the tests if there are any, then stop. ' +
      'Do not start other chunks. Do not commit; Conductor commits for you.',
    feedbackText(feedback, feedbackKind, {
      blocked: (f) => `Your previous attempt was blocked by the reviewer:\n${f}\nFix it. Your earlier edits are still in place.`,
      failed: (f) => `Your previous attempt did not finish (${f}).\nSome earlier edits may still be in place: check the files, then complete the chunk.`,
    }),
  ].filter(Boolean).join('\n\n');
}

export function chunkReview({ request, plan, chunk, index, total, diff, tests, base }) {
  return [
    `Overall request:\n${show(request, TEXT_MAX)}`,
    planBlock(plan),
    `Review chunk ${index + 1} of ${total}: ${chunk.title}\nInstructions given:\n${show(chunk.instructions, TEXT_MAX)}`,
    diffBlock('Diff for this chunk:', diff, 30000, base),
    formatTests(tests),
    'Check: does the diff complete this chunk, is it correct, are tests present and passing, is anything out of scope or unsafe?',
    BLOCK_RULES,
  ].join('\n\n');
}

export function finalReview({ request, plan, diff, tests, base }) {
  return [
    `Overall request:\n${show(request, TEXT_MAX)}`,
    planBlock(plan),
    diffBlock('Full diff of the finished branch:', diff, 40000, base),
    formatTests(tests),
    'Review the whole branch: does it meet the request, do the chunks fit together, is anything missing, broken or unsafe?',
    BLOCK_RULES,
  ].join('\n\n');
}

const FOCUS = {
  security: 'Check the security findings below. Set aside false alarms (for example test fixtures, example keys, code that never sees outside input), explain the real problems and propose fixes.',
  legal: 'Check the licence findings below against this rule: apps handed to clients may only use permissively licensed code and dependencies (MIT, Apache-2.0, BSD, ISC); copyleft (GPL, AGPL, LGPL, MPL and similar) and unknown or missing licences are blocking. Explain each risk in plain English. Only the operator can accept a licence.',
  correctness: 'Check that the change fully does what the request asks, and look for untested paths, especially around money, totals and permissions.',
  foundation: 'Check the foundation rule findings below. Code found them and they are facts: explain each one in plain English and say exactly how to fix it without weakening, skipping or editing any check.',
  design: 'Judge the screenshots of every page, at desktop and phone width, against the house visual system: pages built from the house components (PageHeader, ResponsiveList, FormCard, EmptyState, ConfirmAction, FileDropzone, ErrorNotice), one ten-shade palette from theme.ts, the system font stack (no web fonts), every button and field big enough to tap on a phone, nothing scrolls sideways, and phone pages that look finished enough to charge for. The page checks (sideways scrolling, buttons too small to tap, script errors, a page that does not load) are facts. The accessibility results are measurements; if accessibility was not measured, say it is not proven, never that it is clean. A problem you see only in a screenshot can be a warning, never blocking. Flag clunky flows (too many steps, unclear labels, nothing that says what to do next).',
  reliability: "Check the reliability test of the deployed app: deploy, backup, restore, alerts and updates (an update that fails must undo itself). A failed step is a fact: explain what it means for the client's data and what to fix.",
};

// Added to a member's focus only on a client-app round (when a brief is present).
const FOCUS_PROJECT = {
  legal: 'Also check the app\'s outside services, residency, retention and personal data against the data policy and UK GDPR basics. A destination the policy does not allow is blocking unless it is a false alarm (a link in a comment, an example address): say why if you set it aside. Retention and personal-data concerns are warnings or notes.',
  correctness: 'Also check every feature and worked example in the brief is built and proven by a passing test, and look for untested paths around money (totals, VAT, rounding, pence) and permissions (who may see, edit or approve).',
};

const RESIDENCY = { uk: 'in the UK', 'uk-eu': 'in the UK or EU', any: 'anywhere' };

export function POLICY_LINES(policy) {
  const p = policy ?? {};
  const lines = [];
  if (p.hosting === 'client-box') lines.push("Hosting: the client's own box");
  else if (p.hosting === 'operator-server') lines.push('Hosting: a server the operator runs');
  const out = Array.isArray(p.outbound) ? p.outbound : [];
  lines.push('Outside services allowed: ' + (out.length ? out.map((id) => {
    const svc = typeof id === 'string' && Object.hasOwn(OUTBOUND_SERVICES, id) ? OUTBOUND_SERVICES[id] : null;
    return svc ? `${svc.label} (${svc.hosts.join(', ')}; carries ${svc.carries})` : String(id);
  }).join('; ') : 'none'));
  if (RESIDENCY[p.residency]) lines.push(`Data may be kept: ${RESIDENCY[p.residency]}`);
  if (p.retention && typeof p.retention.text === 'string') lines.push(`Retention: ${p.retention.text}${typeof p.retention.days === 'number' ? ` (${p.retention.days} days)` : ''}`);
  if (p.backupDestination) lines.push(`Backups go to: ${p.backupDestination.kind} (${p.backupDestination.detail})`);
  if (p.operatorAccess === true) lines.push('Operator remote access: agreed');
  return lines.map((l) => show(l, 600)).join('\n');
}

const councilItem = ({ id, finding: f }) => {
  const head = `${id} [${f.grade}] ${TOOL_LABEL[f.tool] ?? f.tool ?? 'reviewer'}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.title}${f.preExisting ? ' (already there before this change)' : ''}${f.locked ? ' (a fact: you cannot set it aside or lower it)' : ''}`;
  return f.detail ? `${head}\n    ${show(f.detail, 600)}` : head;
};

export function councilMember({ member, label, request, plan, diff, base, tests, items, notes, briefText = null, policy = null, context = [], attachments = [] }) {
  const project = typeof briefText === 'string' && briefText !== '';
  const focus = FOCUS[member] + (project && FOCUS_PROJECT[member] ? ` ${FOCUS_PROJECT[member]}` : '');
  return [
    `You are the ${label} member of a review council. You review independently: you do not see the other members' views. ${focus}`,
    `Overall request:\n${show(request, TEXT_MAX)}` + (plan ? `\n\n${planBlock(plan)}` : ''),
    project ? `The client's approved brief:\n${show(briefText, 8000)}` : '',
    policy ? `The client's data policy:\n${POLICY_LINES(policy)}` : '',
    diffBlock('The change under review:', diff, 30000, base),
    member === 'correctness' && !project ? formatTests(tests) : '',
    'What the checking tools found:\n' + (items.length ? items.map(councilItem).join('\n') : '(the tools found nothing)'),
    context?.length ? 'What the checks measured:\n' + context.map((c) => `- ${show(c, 600)}`).join('\n') : '',
    attachments?.length ? 'Screenshots you can open (read them, do not change them):\n' + attachments.map((a) => `- ${show(a, 300)}`).join('\n') : '',
    notes?.length ? 'Checks that did not run:\n' + notes.map((n) => `- ${n}`).join('\n') : '',
    [
      'Rules:',
      '- Work only from the evidence above and the files in your current directory. Do not edit anything.',
      '- For each finding decide "keep" or "dismiss". Dismiss only a false alarm, and always say why.',
      '- You may change a finding\'s grade: "blocking" (must be fixed before this ships), "warning" (the operator should know), "note" (for the record).',
      '- A finding marked as a fact cannot be dismissed or lowered: explain it and say how to fix it.',
      '- You may add problems the tools missed under "extra". Without tool evidence they can only be warnings or notes.',
      '- Write "why" and "fix" in plain English for a business owner who does not read code: what is wrong, why it matters, what to change.',
    ].join('\n'),
    [
      'End your reply with one ```json block of exactly this shape, then the VERDICT line:',
      '{"findings": [{"id": "S1", "decision": "keep", "grade": "blocking", "why": "...", "fix": "..."}], "extra": [{"title": "...", "why": "...", "grade": "warning", "file": "..."}]}',
      'Use VERDICT: BLOCK if any finding you keep is blocking, otherwise VERDICT: APPROVE.',
    ].join('\n'),
  ].filter(Boolean).join('\n\n');
}
