# Task 7: The brief loop

This is the heart of Plan 7: `runBriefSession`, the state machine that drafts, asks, redrafts and gets approval (spec §4.1; Rulings 1, 3, 6, 10, 11). It is pure apart from the injected author seat, the `io` and the project folder, so every path is tested with `fakeParticipant` and a scripted `io`.

**Files:**
- Create: `src/factory/briefRun.js`
- Test: `test/factory-brief-run.test.js`

**Interfaces:**
- Consumes:
  - `callRole`, `RunLog` (`src/runlog.js`) and `vendorOf` (`src/vendors.js`);
  - `normalizeBrief`, `validateBrief`, `renderBrief`, `briefPaths`, `nextVersion`, `saveApprovedBrief`, `loadBrief`, `currentBriefInfo` (Tasks 3–4);
  - `briefDraftPrompt`, `parseBriefReply` (Task 5);
  - `readNotes`, `saveSession`, `discardSession` (Task 6);
  - `cleanText` (Task 3).
- Produces: `BRIEF_LIMITS`, `assertFrontierSeat(seat)` and `runBriefSession(...)` (signatures and the `io` contract are in the index).

**State machine** (the session is saved after every arrow):

```
draft ──author reply valid (draft stage)──▶ questions (if openQuestions) ──all asked──▶ draft
  │  └─reply unusable → problems, attempts+1 (≤3) ──▶ draft                        └─all skipped → STOP (questions kept)
  └──valid, no questions──▶ approve ──a──▶ save vN, discard session → APPROVED
                               ├─c (note)──▶ draft (changeRequests += note)
                               └─s / EOF──▶ STOP (stage approve kept)
```

- [ ] **Step 1: Write the failing tests** in `test/factory-brief-run.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBriefSession, assertFrontierSeat, BRIEF_LIMITS } from '../src/factory/briefRun.js';
import { newSession, loadSession, saveSession } from '../src/factory/briefSession.js';
import { briefPaths, loadBrief, saveApprovedBrief, nextVersion } from '../src/factory/brief.js';
import { RunLog } from '../src/runlog.js';
import { Seat } from '../src/router.js';
import { fakeParticipant } from './helpers/fakes.js';
import { validBrief, approvedBrief } from './helpers/briefFixtures.js';

const NOW = new Date('2026-10-27T11:00:00Z');
const NOTE_TEXT = 'Met Jo at Thistle Joinery. 45 staff. MARKER-NOTES-7731';
const fence = (o) => `Draft below.\n\`\`\`json\n${JSON.stringify(o)}\n\`\`\``;
const Q1 = { id: 'q1', question: '\x1b[31mWhere should backups go?', why: 'Never only on the same box' };
const Q2 = { id: 'q2', question: 'May receipts be read by a cloud service?', why: 'Decides local or cloud OCR' };
const asking = (...qs) => validBrief({ policy: { ...validBrief().policy, backupDestination: null }, openQuestions: qs });

function setup({ mode = 'new', baseVersion = null } = {}) {
  const p = mkdtempSync(path.join(tmpdir(), 'run-'));
  for (const s of ['brief', 'notes']) mkdirSync(path.join(p, s));
  writeFileSync(path.join(p, 'notes', 'n.md'), NOTE_TEXT);
  const session = newSession({ slug: 'thistle', mode, baseVersion, notes: ['notes/n.md'], now: new Date('2026-10-27T10:00:00Z') });
  saveSession(p, session);
  return { p, session };
}
const author = (replies) => fakeParticipant({ name: 'claude', kind: 'claude-code', roles: ['author', 'reviewer'],
  script: (role, task, ctx, opts, i) => { const r = replies[Math.min(i, replies.length - 1)]; return typeof r === 'string' ? { text: r, usage: { costUsd: 0.02 } } : r; } });
function io({ answers = [], approvals = [] } = {}) {
  const asked = []; const shown = []; const said = [];
  return { asked, shown, said,
    say: (t) => said.push(t),
    ask: async (q) => { asked.push(q); return answers.length ? answers.shift() : { stop: true }; },
    approve: async (a) => { shown.push(a); return approvals.length ? approvals.shift() : { decision: 'stop' }; } };
}
const run = (p, session, a, ioObj, extra = {}) => runBriefSession({ projectDir: p, session, author: a, io: ioObj, log: new RunLog(briefPaths(p).logs),
  operatorName: 'Malcolm', cwd: mkdtempSync(path.join(tmpdir(), 'cwd-')), now: () => NOW, ...extra });

test('draft → questions one at a time → redraft → approve writes v1 and clears the session', async () => {
  const { p, session } = setup();
  const a = author([fence(asking(Q1, Q2)), fence(validBrief())]);
  const t = io({ answers: [{ answer: 'A USB disk in their safe\x07' }, { answer: 'No, keep receipts in house' }], approvals: [{ decision: 'approve' }] });
  const out = await run(p, session, a, t);
  assert.deepEqual(out, { status: 'approved', version: 1, jsonPath: briefPaths(p).json(1), mdPath: briefPaths(p).md(1), costUsd: 0.04 });
  assert.deepEqual(t.asked.map((q) => [q.index, q.total, q.question]), [[1, 2, 'Where should backups go?'], [2, 2, 'May receipts be read by a cloud service?']]);
  assert.equal(a.calls.length, 2);
  assert.ok(a.calls[0].task.includes(NOTE_TEXT), 'the notes go to the author');
  assert.equal(a.calls[0].role, 'author');
  assert.equal(a.calls[0].opts.write, false);
  assert.ok(a.calls[1].task.includes('Q: Where should backups go?\nA: A USB disk in their safe\n'), 'answers are cleaned and passed on');
  assert.match(t.shown[0].markdown, /Draft: not yet approved \(will become version 1\)/);
  assert.equal(t.shown[0].draftPath, briefPaths(p).draftMd);
  const b = loadBrief(p);
  assert.deepEqual({ slug: b.slug, version: b.version, approvedBy: b.approvedBy, approvedAt: b.approvedAt, createdAt: b.createdAt, revisedFrom: b.revisedFrom },
    { slug: 'thistle', version: 1, approvedBy: 'Malcolm', approvedAt: NOW.toISOString(), createdAt: '2026-10-27T10:00:00.000Z', revisedFrom: null });
  assert.equal(loadSession(p, 'thistle'), null);
  assert.ok(existsSync(path.join(briefPaths(p).logs, 'transcript.jsonl')), 'the session log stays in the project folder');
});

test('unusable replies go back to the author, not to the operator', async () => {
  const { p, session } = setup();
  const vague = validBrief({ features: [{ ...validBrief().features[0], acceptance: [{ given: 'a receipt is uploaded', when: 'the manager opens it', then: 'it works correctly' }] }, validBrief().features[1]] });
  const a = author(['Happy to help! What does the client do?', fence(vague), fence(validBrief())]);
  const t = io({ approvals: [{ decision: 'approve' }] });
  assert.equal((await run(p, session, a, t)).status, 'approved');
  assert.equal(t.asked.length, 0);
  assert.ok(a.calls[1].task.includes('Your previous draft could not be used:\n- the reply has no ```json block'));
  assert.ok(a.calls[2].task.includes('"works correctly" cannot be checked by a test'));
});

test('three unusable replies in a row: failed, plainly, and resumable with a fresh budget', async () => {
  const { p, session } = setup();
  const out = await run(p, session, author(['no json', 'still none', 'nope']), io());
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /Conductor could not get a usable brief from the AI after 3 tries\. The last problems were: the reply has no ```json block.*Your answers are saved: run conductor brief thistle to try again\./s);
  const s = loadSession(p, 'thistle');
  assert.deepEqual([s.stage, s.attempts], ['draft', 0]);
  assert.equal(BRIEF_LIMITS.attempts, 3);
  assert.equal((await run(p, s, author([fence(validBrief())]), io({ approvals: [{ decision: 'approve' }] }))).status, 'approved');
});

test('stop between questions keeps every answer; resume asks only what is left', async () => {
  const { p, session } = setup();
  const out = await run(p, session, author([fence(asking(Q1, Q2))]), io({ answers: [{ answer: 'USB disk' }, { stop: true }] }));
  assert.deepEqual(out, { status: 'stopped', reason: 'Stopped. Your answers so far are saved. To carry on, run: conductor brief thistle', costUsd: 0.02 });
  const s = loadSession(p, 'thistle');
  assert.equal(s.stage, 'questions');
  assert.deepEqual(s.pending.map((q) => q.id), ['q2']);
  assert.deepEqual(s.answers.map((x) => [x.id, x.answer]), [['q1', 'USB disk']]);
  const a2 = author([fence(validBrief())]);
  const t2 = io({ answers: [{ answer: 'No cloud' }], approvals: [{ decision: 'approve' }] });
  assert.equal((await run(p, s, a2, t2)).status, 'approved');
  assert.deepEqual(t2.asked.map((q) => q.question), ['May receipts be read by a cloud service?']);
  assert.ok(a2.calls[0].task.includes('A: USB disk') && a2.calls[0].task.includes('A: No cloud'));
});

test('skipping every question in a round stops instead of looping; one skip is passed on as unknown', async () => {
  const { p, session } = setup();
  const out = await run(p, session, author([fence(asking(Q1, Q2))]), io({ answers: [{ skip: true }, { skip: true }] }));
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /Conductor can't finish the brief until these are answered:\n- Where should backups go\?\n- May receipts be read by a cloud service\?\nWhen you know, run: conductor brief thistle/);
  const s = loadSession(p, 'thistle');
  assert.deepEqual([s.stage, s.pending.length, s.answers.length], ['questions', 2, 0]);
  const a = author([fence(validBrief())]);
  await run(p, s, a, io({ answers: [{ answer: 'USB disk' }, { skip: true }], approvals: [{ decision: 'stop' }] }));
  assert.ok(a.calls[0].task.includes('Q: May receipts be read by a cloud service?\nA: (not known yet: keep it as an open question)'));
});

test('asking for changes redrafts; stopping at approval keeps the draft and costs nothing to resume', async () => {
  const { p, session } = setup();
  const a = author([fence(validBrief()), fence(validBrief({ client: 'Thistle Joinery Limited' }))]);
  const out = await run(p, session, a, io({ approvals: [{ decision: 'change', note: 'Use the full company name' }, { decision: 'stop' }] }));
  assert.equal(out.status, 'stopped');
  assert.ok(a.calls[1].task.includes('asked for these changes:\n- Use the full company name'));
  const s = loadSession(p, 'thistle');
  assert.deepEqual([s.stage, s.draft.client], ['approve', 'Thistle Joinery Limited']);
  const a2 = author([fence(validBrief())]);
  const t2 = io({ approvals: [{ decision: 'approve' }] });
  assert.equal((await run(p, s, a2, t2)).status, 'approved');
  assert.equal(a2.calls.length, 0, 'resuming at approval needs no model call');
  assert.equal(loadBrief(p).client, 'Thistle Joinery Limited');
});

test('an author that never stops asking is cut off after 8 rounds', async () => {
  const { p, session } = setup();
  const answers = Array.from({ length: 20 }, () => ({ answer: 'yes' }));
  const out = await run(p, session, author([fence(asking(Q1))]), io({ answers }));
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /The AI still had questions after 8 rounds, so Conductor stopped to save your subscription\. Your answers are saved: run conductor brief thistle to carry on\./);
  assert.equal(loadSession(p, 'thistle').rounds, 0);
});

test('no frontier model left: paused, nothing counted as a try', async () => {
  const { p, session } = setup();
  const a = author([{ ok: false, failure: 'no-participant', error: 'no AI model is available for claude (claude: rate-limited)' }]);
  const out = await run(p, session, a, io());
  assert.equal(out.status, 'paused');
  assert.match(out.reason, /No AI model can write the brief right now \(no AI model is available for claude \(claude: rate-limited\)\)\. Your answers are saved: run conductor brief thistle later\./);
  assert.equal(loadSession(p, 'thistle').attempts, 0);
});

test('revise: the author sees the approved brief; the result is v2 revised from v1; a moved base is refused', async () => {
  const { p, session } = setup({ mode: 'revise', baseVersion: 1 });
  saveApprovedBrief(p, approvedBrief());
  const a = author([fence(validBrief({ assumptions: ['Mileage is out of scope'] }))]);
  const out = await run(p, session, a, io({ approvals: [{ decision: 'approve' }] }));
  assert.equal(out.version, 2);
  assert.ok(a.calls[0].task.includes('This is a revision of the approved brief version 1'));
  assert.equal(loadBrief(p).revisedFrom, 1);

  const { p: q, session: s2 } = setup({ mode: 'revise', baseVersion: 1 });
  saveApprovedBrief(q, approvedBrief());
  saveApprovedBrief(q, approvedBrief({ version: 2 }));
  const r = await run(q, s2, author([fence(validBrief())]), io());
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /The approved brief changed while this revision was open \(it is now version 2\)\. Run conductor brief thistle --discard-draft, then start the revision again\./);
});

test('a crash after saving the approved brief never makes a second version', async () => {
  const { p, session } = setup();
  saveApprovedBrief(p, approvedBrief()); // vN written and pointer moved…
  Object.assign(session, { stage: 'approve', draft: validBrief(), approving: { version: 1 } }); // …but the session was never cleared
  saveSession(p, session);
  const t = io();
  const out = await run(p, session, author([]), t);
  assert.deepEqual([out.status, out.version], ['approved', 1]);
  assert.equal(t.shown.length, 0);
  assert.equal(nextVersion(p), 2);
  assert.equal(loadSession(p, 'thistle'), null);
});

test('the notes never go to a local model', async () => {
  const { p, session } = setup();
  const local = fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['author', 'grunt'], script: () => ({ text: 'x' }) });
  const claude = author([fence(validBrief())]);
  assert.throws(() => assertFrontierSeat(local), /The brief must be written by a frontier model \(Claude or Codex\): the meeting notes never go to the local model/);
  assert.throws(() => assertFrontierSeat(new Seat({ name: 'claude', candidates: [claude, local] })), /never go to the local model/);
  assert.doesNotThrow(() => assertFrontierSeat(new Seat({ name: 'claude', candidates: [claude] })));
  await assert.rejects(run(p, session, local, io()), /never go to the local model/);
  assert.equal(local.calls.length, 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-brief-run.test.js`
Expected: FAIL with `Cannot find module '…/briefRun.js'`.

- [ ] **Step 3: Implement `assertFrontierSeat` and `BRIEF_LIMITS`**

- `BRIEF_LIMITS = Object.freeze({ attempts: 3, rounds: 8, questionsPerRound: 5, answerMax: 2000 })`.
- `assertFrontierSeat(seat)`:
  - the candidates are `seat.candidates ?? [seat]`;
  - if any candidate has `adapter.kind === 'local-agent'` or `vendorOf(kind) === 'local'`, throw `The brief must be written by a frontier model (Claude or Codex): the meeting notes never go to the local model. Check the "author" participants in your config.`

- [ ] **Step 4: Implement `runBriefSession`**

At the start, call `assertFrontierSeat(author)`. It throws, so the caller sees the rejection before any call.

**Reading the inputs:**
- Read the notes once with `readNotes`.
- `revise` mode: `base = loadBrief(projectDir)`. If `base.version !== session.baseVersion`, return the "changed while this revision was open" failure.

**Crash recovery:** if `session.approving` is set, `currentBriefInfo(projectDir)?.version === session.approving.version` and `loadBrief` succeeds:
- discard the session;
- return `approved` with that version and its paths, with no prompt shown.

Otherwise clear `approving` and carry on.

**Stage `draft`:**
1. If `attempts >= 3`, return the "3 tries" failure:
   - set `attempts = 0`, keep `problems`, save;
   - the reason is `Conductor could not get a usable brief from the AI after 3 tries. The last problems were: ${problems.slice(0, 3).join(' ')} Your answers are saved: run conductor brief ${slug} to try again.`
2. If `rounds >= 8`, return the "8 rounds" failure, with `rounds = 0` saved.
3. Say one of:
   - `Asking the AI to draft the brief…` when there is no draft and no answers;
   - `Asking the AI to fix its draft (try ${attempts + 1} of 3)…` when `problems` is non-empty;
   - otherwise `Asking the AI to update the brief with your answers…`.
4. Build the prompt with `briefDraftPrompt({ notes, baseBrief: base, answers: session.answers, changeRequests, problems })`.
5. `r = await callRole(log, author, 'author', prompt, '', { cwd, write: false, timeoutMs })`.
6. Add `r.usage?.costUsd` to `session.costUsd` when it is a finite number.
7. `!r.ok`:
   - `r.failure === 'no-participant'` → save and return `paused` with the reason in the test;
   - otherwise `attempts++`, `problems = [\`the AI could not answer (${r.error})\`]`, save, loop.
8. `parseBriefReply(r.text)` fails → `attempts++`, `problems = [error]`, save, loop.
9. `validateBrief(draft, { stage: 'draft' })` fails → `attempts++`, `problems = v.problems`, save, loop.
10. Success:
    - `draft` = the parsed draft;
    - `attempts = 0`, `problems = []`, `changeRequests = []` (they are now in the draft), `rounds++`;
    - `pending = draft.openQuestions.slice(0, 5)`;
    - stage `questions` if `pending` is non-empty, else `approve`;
    - save.

**Stage `questions`:**
- Track this round's results in a local list.
- For each item in `pending`, in order: `res = await io.ask({ index: k, total: n, question, why })`, where `n` is the pending count at round start and `k` is 1-based across the round, including a resumed round.
  - `stop` → save and return the "Stopped. Your answers…" result.
  - `skip` → record `answer: null`.
  - otherwise → `answer: cleanText(res.answer, 2000)`.
- After each answer: push `{ id, question, answer, at: now().toISOString() }` to `answers`, shift `pending`, save.
- When `pending` is empty:
  - if every answer recorded **in this round** is `null`, remove those entries from `answers`, put the questions back in `pending`, save, and return the "can't finish until these are answered" stop;
  - otherwise stage `draft`, save.
- Resuming mid-round: the pending items are the rest of the round. Answers from before the interruption count as answered, so the all-skipped check only looks at this sitting's answers.

**Stage `approve`:**
1. `v = nextVersion(projectDir)`.
2. `markdown = renderBrief({ ...draft, version: v })`.
3. Save, so `draft.md` is fresh.
4. `res = await io.approve({ markdown, draftPath: briefPaths(p).draftMd })`.
5. Act on the answer:
   - `approve`:
     1. set `approving = { version: v }` and save;
     2. build `{ ...draft, schema: 1, slug, version: v, createdAt: session.startedAt, revisedFrom: session.baseVersion, approvedAt: now().toISOString(), approvedBy: operatorName }`;
     3. `saveApprovedBrief`, then `discardSession`;
     4. return `approved`.
   - `change` → push `cleanText(note, 2000)` to `changeRequests`, stage `draft`, save.
   - `stop` → save and return the "Stopped. Your answers…" result.

Every return carries `costUsd: session.costUsd`. Round each sum with `Math.round(x * 1e6) / 1e6` so the test's `0.04` is exact.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node --test test/factory-brief-run.test.js && npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/factory/briefRun.js test/factory-brief-run.test.js
git commit -m "feat(factory): the brief loop: draft, one-at-a-time questions, approval, resume"
```
