# Task 3: Plan parsing & prompts

The frontier author returns a plan whose machine-readable part is a JSON block. `parsePlan` turns it into chunks or a clear error (which the loop feeds back to the author, never crashes on). `prompts.js` holds every prompt string so wording lives in one place.

**Files:**
- Create: `src/plan.js`, `src/prompts.js`
- Test: `test/plan.test.js`, `test/prompts.test.js`

**Interfaces:**
- Consumes: `clip` from `src/text.js` (Task 2).
- Produces:
  - `parsePlan(text, { maxChunks = 12 } = {}) -> { ok: true, plan: { summary: string, chunks: [{ title, instructions }] } } | { ok: false, error: string }`. Uses the **last** ` ```json ` fenced block; if none, tries the whole text as JSON (the Plan 1 normalizer strips a fence that wraps the entire reply).
  - `formatTests(tests) -> string` for `{ ran, passed, code, output }`.
  - `planAuthor({ request, maxChunks, feedback })`, `planReview({ request, planText })`, `chunkExec({ request, plan, chunk, index, total, feedback })`, `chunkReview({ request, plan, chunk, index, total, diff, tests })`, `finalReview({ request, plan, diff, tests })` — each returns a string. `index` is 0-based; prompts show `index + 1`.
  - `IRREVERSIBLE_MARK = 'IRREVERSIBLE:'` — reviewers are told to start a reason with it for hard-to-undo concerns (used by Task 5).

- [ ] **Step 1: Write the failing tests**

`test/plan.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan } from '../src/plan.js';

const good = { summary: 'S', chunks: [{ title: 'A', instructions: 'do a' }, { title: 'B', instructions: 'do b' }] };
const fenced = (o) => 'Here is the plan.\n```json\n' + JSON.stringify(o) + '\n```\n';

test('parses the json block', () => {
  const r = parsePlan(fenced(good));
  assert.equal(r.ok, true);
  assert.equal(r.plan.summary, 'S');
  assert.deepEqual(r.plan.chunks.map((c) => c.title), ['A', 'B']);
});

test('uses the last json block when there are several', () => {
  const r = parsePlan(fenced({ summary: 'old', chunks: [{ title: 'X', instructions: 'x' }] }) + fenced(good));
  assert.equal(r.plan.summary, 'S');
});

test('accepts bare JSON (outer fence already stripped by the normalizer)', () => {
  assert.equal(parsePlan(JSON.stringify(good)).ok, true);
});

test('trims strings and defaults a missing summary', () => {
  const r = parsePlan(fenced({ chunks: [{ title: '  A ', instructions: ' a ' }] }));
  assert.deepEqual(r.plan, { summary: '', chunks: [{ title: 'A', instructions: 'a' }] });
});

test('errors: no block, bad JSON, no chunks, too many, incomplete chunk', () => {
  assert.match(parsePlan('just prose').error, /no ```json plan block/);
  assert.match(parsePlan('```json\n{nope\n```').error, /not valid JSON/);
  assert.match(parsePlan(fenced({ summary: 's', chunks: [] })).error, /no chunks/);
  const many = { chunks: Array.from({ length: 4 }, (_, i) => ({ title: `t${i}`, instructions: 'i' })) };
  assert.match(parsePlan(fenced(many), { maxChunks: 3 }).error, /4 chunks \(max 3\)/);
  assert.match(parsePlan(fenced({ chunks: [{ title: 'A' }] })).error, /chunk 1 is missing/);
  assert.match(parsePlan(fenced([1, 2])).error, /must be an object/);
  assert.match(parsePlan(undefined).error, /no ```json plan block/);
});
```

`test/prompts.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/prompts.js';

const plan = { summary: 'Add export', chunks: [{ title: 'Backend', instructions: 'add route' }, { title: 'UI', instructions: 'add button' }] };

test('formatTests covers the three states', () => {
  assert.match(P.formatTests({ ran: false }), /not configured/);
  assert.match(P.formatTests({ ran: true, passed: true, code: 0, output: 'ok' }), /PASSED/);
  const f = P.formatTests({ ran: true, passed: false, code: 4, output: 'boom' });
  assert.match(f, /FAILED \(exit 4\)/);
  assert.match(f, /boom/);
});

test('planAuthor includes request, chunk cap, json shape, and feedback only when given', () => {
  const a = P.planAuthor({ request: 'CSV export', maxChunks: 7 });
  assert.match(a, /CSV export/);
  assert.match(a, /At most 7 chunks/);
  assert.match(a, /```json/);
  assert.doesNotMatch(a, /blocked your previous plan/);
  assert.match(P.planAuthor({ request: 'r', maxChunks: 7, feedback: 'too big' }), /blocked your previous plan[\s\S]*too big/);
});

test('review prompts explain the IRREVERSIBLE marker', () => {
  assert.match(P.planReview({ request: 'r', planText: 'p' }), new RegExp(P.IRREVERSIBLE_MARK));
  assert.match(P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: 'd', tests: { ran: false } }), /IRREVERSIBLE:/);
  assert.match(P.finalReview({ request: 'r', plan, diff: 'd', tests: { ran: false } }), /IRREVERSIBLE:/);
});

test('chunkExec numbers the chunk from 1 and carries feedback', () => {
  const e = P.chunkExec({ request: 'r', plan, chunk: plan.chunks[1], index: 1, total: 2, feedback: 'missing test' });
  assert.match(e, /chunk 2 of 2: UI/);
  assert.match(e, /add button/);
  assert.match(e, /missing test/);
  assert.match(e, /Do not commit/);
});

test('chunkReview includes the diff and test result, and clips huge diffs', () => {
  const r = P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: '+line', tests: { ran: true, passed: false, code: 1, output: 'F' } });
  assert.match(r, /\+line/);
  assert.match(r, /FAILED/);
  const big = P.chunkReview({ request: 'r', plan, chunk: plan.chunks[0], index: 0, total: 2, diff: 'x'.repeat(100000), tests: { ran: false } });
  assert.ok(big.length < 50000);
  assert.match(big, /chars clipped/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL — modules `../src/plan.js` and `../src/prompts.js` not found.

- [ ] **Step 3: Implement**

`src/plan.js`:

```js
// src/plan.js
const JSON_FENCE = /```json[ \t]*\n([\s\S]*?)\n```/gi;

function extractJson(text) {
  const blocks = [...text.matchAll(JSON_FENCE)];
  if (blocks.length) return blocks[blocks.length - 1][1];
  const t = text.trim();
  return t.startsWith('{') || t.startsWith('[') ? t : null;
}

export function parsePlan(text, { maxChunks = 12 } = {}) {
  const raw = extractJson(typeof text === 'string' ? text : '');
  if (raw == null) return { ok: false, error: 'no ```json plan block found in the reply' };

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `plan block is not valid JSON (${e.message})` };
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'plan JSON must be an object' };

  const chunks = Array.isArray(obj.chunks) ? obj.chunks : [];
  if (chunks.length === 0) return { ok: false, error: 'plan has no chunks' };
  if (chunks.length > maxChunks) return { ok: false, error: `plan has ${chunks.length} chunks (max ${maxChunks}); merge or drop some` };

  const out = [];
  for (const [i, c] of chunks.entries()) {
    const title = typeof c?.title === 'string' ? c.title.trim() : '';
    const instructions = typeof c?.instructions === 'string' ? c.instructions.trim() : '';
    if (!title || !instructions) return { ok: false, error: `chunk ${i + 1} is missing a title or instructions` };
    out.push({ title, instructions });
  }
  return { ok: true, plan: { summary: typeof obj.summary === 'string' ? obj.summary.trim() : '', chunks: out } };
}
```

`src/prompts.js`:

```js
// src/prompts.js
// Every prompt the loop sends. Role system prompts and the VERDICT line format
// come from roles.js; these are the task bodies.
import { clip } from './text.js';

export const IRREVERSIBLE_MARK = 'IRREVERSIBLE:';

const BLOCK_RULES =
  'Block only for substantive problems, each with a concrete reason. Not for style or preference. ' +
  `If a concern is about something hard to undo (data loss, deleting user work, a public API break, ` +
  `a schema or data migration), start your reason with "${IRREVERSIBLE_MARK}".`;

export function formatTests(tests) {
  if (!tests?.ran) return 'Tests: not configured for this project.';
  if (tests.passed) return 'Tests: PASSED';
  return `Tests: FAILED (exit ${tests.code})\n${clip(tests.output, 4000)}`;
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
    `Proposed plan:\n${clip(planText, 20000)}`,
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
    `Diff for this chunk:\n${clip(diff, 30000) || '(no changes)'}`,
    formatTests(tests),
    'Check: does the diff complete this chunk, is it correct, are tests present and passing, is anything out of scope or unsafe?',
    BLOCK_RULES,
  ].join('\n\n');
}

export function finalReview({ request, plan, diff, tests }) {
  return [
    `Overall request:\n${request}`,
    planBlock(plan),
    `Full diff of the finished branch:\n${clip(diff, 40000) || '(no changes)'}`,
    formatTests(tests),
    'Review the whole branch: does it meet the request, do the chunks fit together, is anything missing, broken or unsafe?',
    BLOCK_RULES,
  ].join('\n\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/plan.js src/prompts.js test/plan.test.js test/prompts.test.js
git commit -m "feat: plan JSON parser and loop prompt builders"
```
