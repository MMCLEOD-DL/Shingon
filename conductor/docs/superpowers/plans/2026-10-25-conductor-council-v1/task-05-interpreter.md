# Task 5: LLM interpreter

This task adds each member's LLM half. The model reads only its own member's tool findings, plus the request, the change and the files in the workspace (read-only). For each finding it replies with keep or set aside, a grade, a plain-English **why** and a **fix**. It may also add **extra** findings the tools missed.

**The code applies the rules, not the model** (spec §4.3):
- a locked finding can't be set aside or downgraded;
- setting a finding aside needs a reason;
- a finding is never raised above its ceiling (`maxGrade`, Task 1): only a finding its tool graded blocking can be blocking, so a Semgrep warning, a dev-only licence, the "no tests" check, a moderate audit result or an unrecognised ScanCode match can never become a fix round (index Ruling 6). A finding without tool evidence, or one that was already there, has a ceiling of warning;
- unknown ids are ignored, and at most 10 extras are accepted.

If the call fails or the reply can't be parsed, the tool findings stand exactly as graded, plus a note saying so (index Ruling 9). A `no-participant` failure pauses the run.

**Files:**
- Modify: `src/prompts.js` (add `councilMember`)
- Create: `src/council/interpret.js`
- Test: `test/prompts.test.js` (append), `test/council-interpret.test.js` (new)

**Interfaces:**
- Consumes:
  - `makeFinding`, `clampGrade`, `GRADES`, `MEMBER_LABEL` and `TOOL_LABEL` (Task 1);
  - `callAgent` and `noteSameVendor` (`src/runlog.js`);
  - `vendorOf` (`src/vendors.js`);
  - `clip` and `redact`;
  - the existing `show`, `diffBlock`, `planBlock` and `formatTests` helpers in `src/prompts.js`.
- Produces:
  - `prompts.councilMember({ member, label, request, plan, diff, base, tests, items, notes }) -> string`. Here `items` is `[{ id, finding }]` and `notes` is `string[]`.
  - `ID_PREFIX = { security: 'S', legal: 'L', correctness: 'C' }`, `MAX_SENT = 40`, `MAX_EXTRA = 10`.
  - `parseInterpretation(text)`, `applyInterpretation(findings, ids, reply, { member })` and `interpretMember(ctx, { member, label, findings, notes, input })`, as in the index.

- [ ] **Step 1: Write the failing tests**

Append to `test/prompts.test.js`:

```js
import { makeFinding as mkF } from '../src/council/findings.js';

test('councilMember: one member, its own evidence, the rules and the JSON shape', () => {
  const items = [
    { id: 'C1', finding: mkF({ member: 'correctness', tool: 'tests', grade: 'blocking', locked: true, title: 'The tests fail (exit code 1)', detail: 'not ok 3' }) },
    { id: 'C2', finding: mkF({ member: 'correctness', tool: 'test-files', grade: 'warning', title: 'The change adds or edits no tests', preExisting: true }) },
  ];
  const p = P.councilMember({ member: 'correctness', label: 'Correctness', request: 'Add VAT totals', plan: { summary: 'S', chunks: [{ title: 'One' }] },
    diff: '+x', base: 'abc', tests: { ran: true, passed: false, code: 1, output: 'not ok 3' }, items, notes: ['Semgrep (code scanner) is not installed, so this check did not run.'] });
  assert.match(p, /You are the Correctness member of a review council/);
  assert.match(p, /Add VAT totals/);
  assert.match(p, /C1 \[blocking\] the test command: The tests fail \(exit code 1\) \(a fact: you cannot set it aside or lower it\)/);
  assert.match(p, /C2 \[warning\] test coverage check: The change adds or edits no tests \(already there before this change\)/);
  assert.match(p, /Checks that did not run:\n- Semgrep/);
  assert.match(p, /"findings": \[\{"id": "S1", "decision": "keep"/);
  assert.match(p, /Without tool evidence they can only be warnings or notes/);
  assert.match(p, /Tests: FAILED/);
  assert.doesNotMatch(p, /Security member|Legal member/);
  const none = P.councilMember({ member: 'security', label: 'Security', request: 'r', plan: null, diff: '', base: 'abc', tests: null, items: [], notes: [] });
  assert.match(none, /\(the tools found nothing\)/);
  assert.doesNotMatch(none, /Tests:/, 'only Correctness is shown the test result');
});
```

(`test/prompts.test.js` already imports the module as `P`.)

Create `test/council-interpret.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInterpretation, applyInterpretation, interpretMember, MAX_SENT } from '../src/council/interpret.js';
import { makeFinding } from '../src/council/findings.js';
import { fakeParticipant, makeCtx } from './helpers/fakes.js';

const fence = (o) => 'Notes first.\n```json\n' + JSON.stringify(o) + '\n```\nVERDICT: APPROVE';
const sem = (over = {}) => makeFinding({ member: 'security', tool: 'semgrep', grade: 'warning', title: 'weak hash', file: 'a.js', ...over });

test('parseInterpretation: the last json block wins; bad entries are dropped; prose fails', () => {
  const text = '```json\n{"findings":[]}\n```\n' + fence({ findings: [{ id: 'S1', decision: 'dismiss', why: 'test fixture' }, { id: 7 }, { id: 'S2', decision: 'maybe' }],
    extra: [{ title: 'x', why: 'y', grade: 'note' }, { why: 'no title' }] });
  const r = parseInterpretation(text);
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings, [
    { id: 'S1', decision: 'dismiss', grade: null, why: 'test fixture', fix: null },
    { id: 'S2', decision: 'keep', grade: null, why: null, fix: null },
  ]);
  assert.deepEqual(r.extra, [{ title: 'x', why: 'y', grade: 'note', file: null }]);
  assert.equal(parseInterpretation('{"findings":[]}').ok, true, 'a bare JSON reply is fine');
  assert.equal(parseInterpretation('Everything looks fine.\nVERDICT: APPROVE').ok, false);
  assert.equal(parseInterpretation('```json\n{ nope\n```').ok, false);
});

test('applyInterpretation holds the line (Review Focus 3)', () => {
  const tests = makeFinding({ member: 'correctness', tool: 'tests', grade: 'blocking', locked: true, title: 'The tests fail (exit code 1)' });
  const pre = sem({ grade: 'warning', preExisting: true, title: 'old eval' });
  const fp = sem({ title: 'key in fixture' });
  const keepNoWhy = sem({ title: 'second' });
  const up = sem({ title: 'sql injection' });                       // a Semgrep WARNING: ceiling warning
  const devGpl = makeFinding({ member: 'legal', tool: 'licences', grade: 'warning', title: 'gpl-dev 1.0.0 uses GPL-3.0-only, a copyleft licence' });
  const info = sem({ title: 'fyi', grade: 'note' });
  const err = sem({ title: 'eval of input', grade: 'blocking' });
  const reply = { ok: true, findings: [
    { id: 'X1', decision: 'dismiss', grade: 'note', why: 'flaky', fix: 'rerun' },
    { id: 'X2', decision: 'keep', grade: 'blocking', why: 'old', fix: null },
    { id: 'X3', decision: 'dismiss', grade: null, why: 'it is a test fixture', fix: null },
    { id: 'X4', decision: 'dismiss', grade: null, why: null, fix: null },
    { id: 'X5', decision: 'keep', grade: 'blocking', why: 'user input reaches the query', fix: 'use parameters' },
    { id: 'X6', decision: 'keep', grade: 'blocking', why: 'copyleft', fix: null },
    { id: 'X7', decision: 'keep', grade: 'warning', why: 'worth knowing', fix: null },
    { id: 'X8', decision: 'keep', grade: 'note', why: 'only reachable from an admin script', fix: null },
    { id: 'NOPE', decision: 'dismiss', grade: null, why: 'ignored', fix: null },
  ], extra: [{ title: 'refunds are untested', why: 'money path', grade: 'blocking', file: 'src/refund.js' }] };
  const out = applyInterpretation([tests, pre, fp, keepNoWhy, up, devGpl, info, err], ['X1', 'X2', 'X3', 'X4', 'X5', 'X6', 'X7', 'X8'], reply, { member: 'security' });
  assert.deepEqual(out.map((f) => [f.title, f.grade, f.dismissed]), [
    ['The tests fail (exit code 1)', 'blocking', false],   // locked: cannot be set aside or lowered
    ['old eval', 'warning', false],                        // already there: capped at warning
    ['key in fixture', 'warning', true],                   // set aside, with a reason
    ['second', 'warning', false],                          // no reason given: not set aside
    ['sql injection', 'warning', false],                   // a tool warning cannot be raised to blocking (Ruling 6 ceiling)
    ['gpl-dev 1.0.0 uses GPL-3.0-only, a copyleft licence', 'warning', false], // dev-only licence: ceiling warning
    ['fyi', 'warning', false],                             // a note may be raised up to its ceiling
    ['eval of input', 'note', false],                      // lowering is always allowed on an unlocked finding
    ['refunds are untested', 'warning', false],            // no tool evidence: only a warning
  ]);
  assert.equal(out[0].why, 'flaky', 'a locked finding still gets the explanation');
  assert.equal(out[4].fix, 'use parameters');
  assert.equal(out[8].tool, null);
  assert.equal(out[8].evidence, false);
  const many = applyInterpretation([], [], { ok: true, findings: [], extra: Array.from({ length: 15 }, (_, i) => ({ title: `e${i}`, why: null, grade: 'note', file: null })) }, { member: 'legal' });
  assert.equal(many.length, 10);
});

function ctxWith(reviewerScript, authorKind = 'claude-code') {
  const team = {
    author: fakeParticipant({ name: 'claude', kind: authorKind, script: () => ({ text: 'x' }) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: reviewerScript }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: () => ({ text: 'x' }) }),
  };
  return makeCtx({ team });
}
const input = (ctx) => ({ dir: ctx.ws.dir, request: 'r', plan: null, diff: '+x', baseSha: 'abc', tests: null });

test('interpretMember: asks the reviewer seat read-only and applies its reply', async () => {
  const ctx = await ctxWith(() => ({ text: fence({ findings: [{ id: 'S1', decision: 'dismiss', why: 'example key in docs' }] }) }));
  const r = await interpretMember(ctx, { member: 'security', label: 'Security', findings: [sem()], notes: [], input: input(ctx) });
  assert.equal(r.status, 'ok');
  assert.equal(r.interpreted, true);
  assert.equal(r.by, 'codex');
  assert.equal(r.findings[0].dismissed, true);
  const call = ctx.team.reviewer.calls[0];
  assert.equal(call.role, 'reviewer');
  assert.equal(call.opts.write, false);
  assert.equal(call.opts.cwd, ctx.ws.dir);
  assert.match(call.task, /S1 \[warning\] Semgrep \(code scanner\) a\.js: weak hash/);
});

test('interpretMember: a failed or unreadable reply keeps every tool finding, with a note', async () => {
  for (const script of [() => ({ ok: false, error: 'boom' }), () => ({ text: 'All good!\nVERDICT: APPROVE' })]) {
    const ctx = await ctxWith(script);
    const r = await interpretMember(ctx, { member: 'security', label: 'Security', findings: [sem({ grade: 'blocking' })], notes: [], input: input(ctx) });
    assert.equal(r.status, 'ok');
    assert.equal(r.interpreted, false);
    assert.deepEqual(r.findings.map((f) => [f.grade, f.dismissed]), [['blocking', false], ['note', false]]);
    assert.equal(r.findings[1].title, 'The AI could not check the Security findings, so they are shown as the tools reported them');
  }
});

test('interpretMember: no model left pauses; same vendor is flagged; at most MAX_SENT findings, most severe first', async () => {
  const paused = await ctxWith(() => ({ ok: false, failure: 'no-participant', error: 'no AI model is available for codex (codex: rate-limited)' }));
  assert.deepEqual(await interpretMember(paused, { member: 'legal', label: 'Legal', findings: [sem()], notes: [], input: input(paused) }),
    { status: 'paused', reason: 'no AI model is available for codex (codex: rate-limited)' });

  const same = await ctxWith(() => ({ text: fence({ findings: [] }) }), 'codex');
  await interpretMember(same, { member: 'security', label: 'Security', findings: [sem()], notes: [], input: input(same) });
  assert.equal(same.state.flags?.sameVendor, true);

  // A council fix step written by the reviewer's vendor (the local model failed at an odd index) is flagged too.
  const fixedBySame = await ctxWith(() => ({ text: fence({ findings: [] }) }));
  fixedBySame.state.council = { round: 1, fixRounds: 1, secretSeen: false, history: [], fixVendors: ['openai'] };
  await interpretMember(fixedBySame, { member: 'security', label: 'Security', findings: [sem()], notes: [], input: input(fixedBySame) });
  assert.equal(fixedBySame.state.flags?.sameVendor, true);
  const fixedByLocal = await ctxWith(() => ({ text: fence({ findings: [] }) }));
  fixedByLocal.state.council = { round: 1, fixRounds: 1, secretSeen: false, history: [], fixVendors: ['local'] };
  await interpretMember(fixedByLocal, { member: 'security', label: 'Security', findings: [sem()], notes: [], input: input(fixedByLocal) });
  assert.equal(fixedByLocal.state.flags?.sameVendor, undefined);

  const ctx = await ctxWith(() => ({ text: fence({ findings: [] }) }));
  const lots = [...Array.from({ length: 45 }, (_, i) => sem({ title: `n${i}`, grade: 'note' })), sem({ title: 'the bad one', grade: 'blocking' })];
  const r = await interpretMember(ctx, { member: 'security', label: 'Security', findings: lots, notes: [], input: input(ctx) });
  assert.equal(r.findings.length, 46, 'unsent findings stay as the tools graded them');
  const task = ctx.team.reviewer.calls[0].task;
  assert.match(task, /S1 \[blocking\] .*the bad one/);
  assert.equal((task.match(/^S\d+ \[/gm) ?? []).length, MAX_SENT);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/prompts.test.js test/council-interpret.test.js`
Expected: FAIL with `councilMember is not a function` and `Cannot find module '../src/council/interpret.js'`.

- [ ] **Step 3: Implement `councilMember` in `src/prompts.js`**

- Import `TOOL_LABEL` from `./council/tools.js`.
- Define `const FOCUS = { security: …, legal: …, correctness: … }` with these exact strings:
  - security: `'Check the security findings below. Set aside false alarms (for example test fixtures, example keys, code that never sees outside input), explain the real problems and propose fixes.'`
  - legal: `'Check the licence findings below against this rule: apps handed to clients may only use permissively licensed code and dependencies (MIT, Apache-2.0, BSD, ISC); copyleft (GPL, AGPL, LGPL, MPL and similar) and unknown or missing licences are blocking. Explain each risk in plain English. Only the operator can accept a licence.'`
  - correctness: `'Check that the change fully does what the request asks, and look for untested paths, especially around money, totals and permissions.'`
- The prompt is these sections, joined with `\n\n` (empty ones dropped):
  1. `` `You are the ${label} member of a review council. You review independently: you do not see the other members' views. ${FOCUS[member]}` ``
  2. `` `Overall request:\n${show(request, TEXT_MAX)}` ``, followed by `planBlock(plan)` when there is a plan.
  3. `diffBlock('The change under review:', diff, 30000, base)`.
  4. `formatTests(tests)`, **only** when `member === 'correctness'`.
  5. `What the checking tools found:` followed by one line per item, or `(the tools found nothing)` when there are none. Each item line is:

     ```
     `${id} [${f.grade}] ${TOOL_LABEL[f.tool] ?? f.tool ?? 'reviewer'}${f.file ? ` ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.title}${f.preExisting ? ' (already there before this change)' : ''}${f.locked ? ' (a fact: you cannot set it aside or lower it)' : ''}`
     ```

     When `f.detail` is set, it goes on the next line, indented 4 spaces and run through `show(f.detail, 600)`.
  6. When there are notes: `Checks that did not run:` followed by one `- note` line each.
  7. The rules block, verbatim:

     ```
     Rules:
     - Work only from the evidence above and the files in your current directory. Do not edit anything.
     - For each finding decide "keep" or "dismiss". Dismiss only a false alarm, and always say why.
     - You may change a finding's grade: "blocking" (must be fixed before this ships), "warning" (the operator should know), "note" (for the record).
     - A finding marked as a fact cannot be dismissed or lowered: explain it and say how to fix it.
     - You may add problems the tools missed under "extra". Without tool evidence they can only be warnings or notes.
     - Write "why" and "fix" in plain English for a business owner who does not read code: what is wrong, why it matters, what to change.
     ```

  8. The output format, verbatim:

     ```
     End your reply with one ```json block of exactly this shape, then the VERDICT line:
     {"findings": [{"id": "S1", "decision": "keep", "grade": "blocking", "why": "...", "fix": "..."}], "extra": [{"title": "...", "why": "...", "grade": "warning", "file": "..."}]}
     Use VERDICT: BLOCK if any finding you keep is blocking, otherwise VERDICT: APPROVE.
     ```

- [ ] **Step 4: Implement `src/council/interpret.js`**

- **`parseInterpretation(text)`:**
  - Take the last match of `/```json[ \t]*\n([\s\S]*?)\n```/gi`. If there is none, take `text.trim()` when it starts with `{`.
  - No candidate → `{ ok: false, error: 'the reply had no JSON block' }`. JSON error or a non-object → `{ ok: false, error: 'the reply\'s JSON could not be read' }`.
  - Keep `findings` entries whose `id` is a non-empty string. `decision` is `'dismiss'` only when it is exactly that, else `'keep'`. `grade` is kept only if it is in `GRADES`, else `null`. `why` and `fix` are strings (redacted, clipped to 1000) or `null`.
  - Keep `extra` entries whose `title` is a non-empty string. `file` is a string or `null`.
- **`applyInterpretation(findings, ids, reply, { member })`:**
  - Build a map from the reply's findings by id. Return the findings mapped in order, each a shallow copy. When an entry exists:
    - `why` and `fix` from the entry, if non-null, replace the copy's.
    - A `locked` finding stops here.
    - `decision === 'dismiss' && why` → `dismissed = true`.
    - `grade` set → `clampGrade(grade, f.maxGrade)`. The ceiling already includes the evidence and "already there" caps (Task 1), so this one line enforces index Ruling 6.
  - Then append up to `MAX_EXTRA` extras. Each is `makeFinding({ member, tool: null, grade: x.grade ?? 'warning', title: x.title, detail: x.why ?? '', file: x.file })` with `why = x.why`.
- **`interpretMember(ctx, { member, label, findings, notes, input })`:**
  - `order` is the finding indices sorted by `GRADES.indexOf(grade)` (stable). The first `MAX_SENT` are sent, with ids `` `${ID_PREFIX[member]}${n}` `` for n = 1, 2, …. `ids[i]` is that finding's id, or `null` if it was not sent.
  - Call `const r = await callAgent(ctx, ctx.team.reviewer, 'reviewer', prompts.councilMember({ member, label, request: input.request, plan: input.plan, diff: input.diff, base: input.baseSha, tests: input.tests, items, notes }), { cwd: input.dir, write: false, timeoutMs: ctx.options.agentTimeoutMs })`.
  - For each vendor in `new Set([vendorOf(ctx.team.author.adapter.kind), ...(ctx.state.council?.fixVendors ?? [])])`, call `noteSameVendor(ctx, { phase: 'council', producerVendor: vendor, result: r, participant: ctx.team.reviewer })`. `noteSameVendor` already ignores `local` and a failed result. (`fixVendors` is recorded by Task 7 from the fix steps' `runChunk` results.)
  - `r.failure === 'no-participant'` → `{ status: 'paused', reason: r.error }`.
  - `by = r.servedBy ?? ctx.team.reviewer.name`.
  - When `!r.ok` or the parse fails, return `findings` plus one note `makeFinding({ member, grade: 'note', title: `The AI could not check the ${label} findings, so they are shown as the tools reported them`, detail: r.ok ? parsed.error : r.error })`, with `interpreted: false`.
  - Otherwise return `{ status: 'ok', findings: applyInterpretation(findings, ids, parsed, { member }), by, interpreted: true }`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/prompts.test.js test/council-interpret.test.js && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/prompts.js src/council/interpret.js test/prompts.test.js test/council-interpret.test.js
git commit -m "feat(council): LLM interpreter with code-enforced grading rules"
```
