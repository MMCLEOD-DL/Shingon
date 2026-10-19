// src/prompts.js
// Every prompt the loop sends. Role system prompts and the VERDICT line format
// come from roles.js; these are the task bodies.
import { clip } from './text.js';
import { redact } from './secrets.js';

// Redact before clipping: a key split by the clip point would otherwise survive as a fragment.
const show = (text, max) => clip(redact(typeof text === 'string' ? text : ''), max);

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

function planBlock(plan) {
  return `Plan summary: ${plan.summary || '(none)'}\n` +
    plan.chunks.map((c, i) => `${i + 1}. ${c.title}`).join('\n');
}

export function planAuthor({ request, maxChunks, feedback }) {
  return [
    `User request:\n${request}`,
    'You are planning work in the repository in your current directory. Read what you need; do not edit files.',
    'Write a short architecture summary, then an ordered list of small chunks. Each chunk must be small enough ' +
      'for a modest local coding model to finish in one run: one focused change plus its tests. ' +
      `At most ${maxChunks} chunks.`,
    'End your reply with one ```json block of exactly this shape:\n' +
      '{"summary": "...", "chunks": [{"title": "...", "instructions": "..."}]}',
    feedback ? `A reviewer blocked your previous plan:\n${feedback}\nRevise the plan to address it.` : '',
  ].filter(Boolean).join('\n\n');
}

export function planReview({ request, planText }) {
  return [
    `User request:\n${request}`,
    `Proposed plan:\n${show(planText, 20000)}`,
    'Review this plan. Check: wrong approach, missing requirements, chunks too large or in the wrong order, unsafe changes.',
    BLOCK_RULES,
  ].join('\n\n');
}

export function chunkExec({ request, plan, chunk, index, total, feedback }) {
  return [
    `Overall request:\n${request}`,
    planBlock(plan),
    `You are doing chunk ${index + 1} of ${total}: ${chunk.title}\n${chunk.instructions}`,
    'Work only inside the current directory. Make the edits, run the tests if there are any, then stop. ' +
      'Do not start other chunks. Do not commit; Conductor commits for you.',
    feedback ? `Your previous attempt was blocked by the reviewer:\n${feedback}\nFix it. Your earlier edits are still in place.` : '',
  ].filter(Boolean).join('\n\n');
}

export function chunkReview({ request, plan, chunk, index, total, diff, tests }) {
  return [
    `Overall request:\n${request}`,
    planBlock(plan),
    `Review chunk ${index + 1} of ${total}: ${chunk.title}\nInstructions given:\n${chunk.instructions}`,
    `Diff for this chunk:\n${show(diff, 30000) || '(no changes)'}`,
    formatTests(tests),
    'Check: does the diff complete this chunk, is it correct, are tests present and passing, is anything out of scope or unsafe?',
    BLOCK_RULES,
  ].join('\n\n');
}

export function finalReview({ request, plan, diff, tests }) {
  return [
    `Overall request:\n${request}`,
    planBlock(plan),
    `Full diff of the finished branch:\n${show(diff, 40000) || '(no changes)'}`,
    formatTests(tests),
    'Review the whole branch: does it meet the request, do the chunks fit together, is anything missing, broken or unsafe?',
    BLOCK_RULES,
  ].join('\n\n');
}
