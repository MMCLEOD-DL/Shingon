import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBriefSession, assertFrontierSeat, BRIEF_LIMITS } from '../src/factory/briefRun.js';
import { newSession, loadSession, saveSession } from '../src/factory/briefSession.js';
import { briefPaths, loadBrief, saveApprovedBrief, nextVersion } from '../src/factory/brief.js';
import { acceptanceIds } from '../src/factory/acceptance.js';
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
  assert.ok(t.shown[0].markdown.includes('  - [upload-receipt#1] Given Alice'), 'the operator approves the example ids the tests will carry');
  assert.equal(t.shown[0].draftPath, briefPaths(p).draftMd);
  const b = loadBrief(p);
  assert.deepEqual({ slug: b.slug, version: b.version, approvedBy: b.approvedBy, approvedAt: b.approvedAt, createdAt: b.createdAt, revisedFrom: b.revisedFrom },
    { slug: 'thistle', version: 1, approvedBy: 'Malcolm', approvedAt: NOW.toISOString(), createdAt: '2026-10-27T10:00:00.000Z', revisedFrom: null });
  assert.deepEqual(acceptanceIds(b).map((x) => x.id), ['upload-receipt#1', 'monthly-report#1']);
  assert.deepEqual(b.exampleSeq, { 'upload-receipt': 1, 'monthly-report': 1 });
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
  assert.deepEqual(acceptanceIds(loadBrief(p)).map((x) => x.id), ['upload-receipt#1', 'monthly-report#1'], 'unchanged examples keep their ids');

  const { p: q, session: s2 } = setup({ mode: 'revise', baseVersion: 1 });
  saveApprovedBrief(q, approvedBrief());
  saveApprovedBrief(q, approvedBrief({ version: 2 }));
  const r = await run(q, s2, author([fence(validBrief())]), io());
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /The approved brief changed while this revision was open \(it is now version 2\)\. Run conductor brief thistle --discard-draft, then start the revision again\./);
});

test('revise carries example ids: unchanged kept, new and reworded take the next unused number', async () => {
  const { p, session } = setup({ mode: 'revise', baseVersion: 1 });
  saveApprovedBrief(p, approvedBrief());
  const [up, report] = validBrief().features;
  const extra = { given: 'Alice is signed in as Staff', when: 'she uploads a receipt with no amount', then: 'she sees "Please enter the amount"' };
  const reworded = { ...report.acceptance[0], then: 'the Travel row shows net £10.33, VAT £2.07, gross £12.40, category Travel' };
  const draft = validBrief({ features: [{ ...up, acceptance: [extra, up.acceptance[0]] }, { ...report, acceptance: [reworded] }] });
  const out = await run(p, session, author([fence(draft)]), io({ approvals: [{ decision: 'approve' }] }));
  assert.equal(out.version, 2);
  const v2 = loadBrief(p);
  assert.deepEqual(acceptanceIds(v2).map((x) => x.id), ['upload-receipt#2', 'upload-receipt#1', 'monthly-report#2']);
  assert.deepEqual(v2.exampleSeq, { 'upload-receipt': 2, 'monthly-report': 2 });
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

test('revise: a crash after saving v2 resumes to approved v2, ahead of the "brief changed" check, with no v3', async () => {
  const { p, session } = setup({ mode: 'revise', baseVersion: 1 });
  saveApprovedBrief(p, approvedBrief());
  saveApprovedBrief(p, approvedBrief({ version: 2, revisedFrom: 1 })); // v2 written and pointer moved…
  Object.assign(session, { stage: 'approve', draft: validBrief(), approving: { version: 2 } }); // …but the session was never cleared
  saveSession(p, session);
  const t = io();
  const out = await run(p, session, author([]), t);
  assert.deepEqual(out, { status: 'approved', version: 2, jsonPath: briefPaths(p).json(2), mdPath: briefPaths(p).md(2), costUsd: 0 });
  assert.equal(t.shown.length, 0);
  assert.equal(nextVersion(p), 3);
  assert.equal(loadSession(p, 'thistle'), null);
});

test('resuming mid-round numbers the questions still pending from 1', async () => {
  const { p, session } = setup();
  await run(p, session, author([fence(asking(Q1, Q2))]), io({ answers: [{ answer: 'USB disk' }, { stop: true }] }));
  const t = io({ answers: [{ stop: true }] });
  await run(p, loadSession(p, 'thistle'), author([]), t);
  assert.deepEqual(t.asked.map((q) => [q.index, q.total]), [[1, 1]]);
});

test('notes too long to send: a plain refusal for this sitting, not a counted try', async () => {
  const { p, session } = setup();
  writeFileSync(path.join(p, 'notes', 'n.md'), 'x'.repeat(130_000));
  const a = author([fence(validBrief())]);
  const out = await run(p, session, a, io());
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /^These notes are too long to send in one go/);
  assert.equal(a.calls.length, 0);
  assert.equal(loadSession(p, 'thistle').attempts, 0);
});

test('a rerun gets fresh budgets: all 8 rounds and all 3 tries again', async () => {
  const { p, session } = setup();
  await run(p, session, author([fence(asking(Q1))]), io({ answers: [{ answer: 'yes' }, { answer: 'yes' }, { stop: true }] }));
  assert.equal(loadSession(p, 'thistle').rounds, 3);
  const a = author([fence(asking(Q1))]);
  const out = await run(p, loadSession(p, 'thistle'), a, io({ answers: Array.from({ length: 20 }, () => ({ answer: 'yes' })) }));
  assert.match(out.reason, /after 8 rounds/);
  assert.equal(a.calls.length, 8, 'a full 8 rounds in the new sitting');

  const { p: q, session: s2 } = setup();
  const gone = { ok: false, failure: 'no-participant', error: 'no AI model is available for claude' };
  assert.equal((await run(q, s2, author(['no json', 'still none', gone]), io())).status, 'paused');
  assert.equal(loadSession(q, 'thistle').attempts, 2);
  const b = author(['nope', 'nope', 'nope']);
  const t = io();
  const r = await run(q, loadSession(q, 'thistle'), b, t);
  assert.match(r.reason, /after 3 tries/);
  assert.equal(b.calls.length, 3, 'a full 3 tries in the new sitting');
  assert.ok(t.said.includes('Asking the AI to fix its draft (try 1 of 3)…'), 'the problems are kept, the count starts again');
});

// Node 22's JSON.parse quotes the raw reply text around the fault, escape characters and all.
const HOSTILE = 'Draft.\n```json\n{"client": "Thistle", "kind": tru\x1b]0;pwned\x07}\n```';
const hasEscape = (s) => /[\x07\x1b]/.test(s);

test('escape characters in a broken reply never reach the operator or the saved problems', async () => {
  const { p, session } = setup();
  const t = io();
  const out = await run(p, session, author([HOSTILE, HOSTILE, HOSTILE]), t);
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /the brief block is not valid JSON/);
  assert.equal(hasEscape(out.reason), false, JSON.stringify(out.reason));
  assert.equal(t.said.some(hasEscape), false);
  assert.equal(loadSession(p, 'thistle').problems.some(hasEscape), false);
});

test('escape characters in an adapter error are cleaned, for a failed try and for a pause', async () => {
  const { p, session } = setup();
  const bad = { ok: false, failure: 'error', error: 'claude said \x1b[31mno\x1b[0m\x07' };
  const out = await run(p, session, author([bad, bad, bad]), io());
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /the AI could not answer \(claude said no\)/);
  assert.equal(hasEscape(out.reason), false);
  const s = loadSession(p, 'thistle');
  const paused = await run(p, s, author([{ ok: false, failure: 'no-participant', error: 'rate-limited \x1b]0;pwned\x07' }]), io());
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /No AI model can write the brief right now \(rate-limited\)/);
  assert.equal(hasEscape(paused.reason), false);
});

test('notes that grow too long mid-brief: the refusal says the answers are saved and how to start again', async () => {
  const { p, session } = setup();
  writeFileSync(path.join(p, 'notes', 'n.md'), 'x'.repeat(130_000));
  const out = await run(p, session, author([fence(validBrief())]), io());
  assert.equal(out.status, 'stopped');
  assert.match(out.reason, /Your answers so far are saved/);
  assert.match(out.reason, /conductor brief thistle --discard-draft/);
});
