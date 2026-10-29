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

test('secrets in the interpreter reply never survive (why, fix, extras)', async (t) => {
  const key = 'hunter2-very-secret-value-0042';
  process.env.COUNCIL_TEST_API_TOKEN = key;
  t.after(() => { delete process.env.COUNCIL_TEST_API_TOKEN; });
  const reply = { ok: true, findings: [{ id: 'S1', decision: 'keep', grade: null, why: `leaked ${key}`, fix: `rotate ${key}` }],
    extra: [{ title: `bad ${key}`, why: `see ${key}`, grade: 'note', file: `src/${key}.js` }] };
  const out = applyInterpretation([sem()], ['S1'], reply, { member: 'security' });
  assert.ok(!JSON.stringify(out).includes(key), 'no raw secret anywhere');
  const parsed = parseInterpretation('```json\n' + JSON.stringify({ findings: [{ id: 'S1', why: key, fix: key }], extra: [] }) + '\n```');
  assert.ok(!JSON.stringify(parsed).includes(key));
  const ctx = await ctxWith(() => ({ text: fence({ findings: [{ id: 'S1', decision: 'keep', why: key, fix: key }] }) }));
  const r = await interpretMember(ctx, { member: 'security', label: 'Security', findings: [sem()], notes: [], input: input(ctx) });
  assert.ok(!JSON.stringify(r).includes(key));
});


test('a whitespace-only reason does not set a finding aside', () => {
  const err = sem({ grade: 'blocking', title: 'eval' });
  const p = parseInterpretation(fence({ findings: [{ id: 'S1', decision: 'dismiss', why: '  ' }] }));
  assert.equal(p.findings[0].why, null);
  const out = applyInterpretation([err], ['S1'], { ok: true, findings: [{ id: 'S1', decision: 'dismiss', grade: null, why: '  ', fix: null }], extra: [] }, { member: 'security' });
  assert.deepEqual([out[0].grade, out[0].dismissed], ['blocking', false]);
});

test('conflicting duplicate ids: no dismissal, highest grade (clamped), first non-empty text', () => {
  const err = sem({ grade: 'blocking', title: 'eval' });
  const warn = sem({ title: 'weak hash' });
  const reply = { ok: true, extra: [], findings: [
    { id: 'S1', decision: 'dismiss', grade: 'note', why: 'fixture', fix: null },
    { id: 'S1', decision: 'keep', grade: 'warning', why: null, fix: 'fix it' },
    { id: 'S2', decision: 'keep', grade: 'blocking', why: 'bad', fix: null },
    { id: 'S2', decision: 'dismiss', grade: 'note', why: 'ok', fix: null },
  ] };
  const out = applyInterpretation([err, warn], ['S1', 'S2'], reply, { member: 'security' });
  assert.deepEqual(out.map((f) => [f.grade, f.dismissed]), [['warning', false], ['warning', false]]);
  assert.equal(out[0].why, 'fixture');
  assert.equal(out[0].fix, 'fix it');
});

test('dismiss-everything reply with 12 extras: only locked survive, 10 extras, none blocking', () => {
  const locked = makeFinding({ member: 'correctness', tool: 'tests', grade: 'blocking', locked: true, title: 'tests fail' });
  const a = sem({ grade: 'blocking', title: 'a' });
  const b = sem({ title: 'b' });
  const reply = { ok: true, findings: ['X1', 'X2', 'X3'].map((id) => ({ id, decision: 'dismiss', grade: 'note', why: 'all fine', fix: null })),
    extra: Array.from({ length: 12 }, (_, i) => ({ title: `e${i}`, why: 'w', grade: 'blocking', file: null })) };
  const out = applyInterpretation([locked, a, b], ['X1', 'X2', 'X3'], reply, { member: 'security' });
  assert.equal(out.length, 13);
  assert.deepEqual(out.slice(0, 3).map((f) => f.dismissed), [false, true, true]);
  assert.equal(out[0].grade, 'blocking');
  assert.ok(out.slice(3).every((f) => f.grade !== 'blocking' && !f.evidence));
});

test('interpretMember never shows another member\'s findings to the model', async () => {
  const ctx = await ctxWith(() => ({ text: fence({ findings: [] }) }));
  const other = makeFinding({ member: 'legal', tool: 'licences', grade: 'blocking', title: 'LEGAL-ONLY-TITLE' });
  const r = await interpretMember(ctx, { member: 'security', label: 'Security', findings: [other, sem()], notes: [], input: input(ctx) });
  const task = ctx.team.reviewer.calls[0].task;
  assert.doesNotMatch(task, /LEGAL-ONLY-TITLE/);
  assert.match(task, /S1 \[warning\] Semgrep/);
  assert.equal(r.findings.length, 2);
});

import { orderShots } from '../src/council/interpret.js';

test('orderShots puts phone shots first, keeps 40 of 45, and drops paths that escape the workspace', () => {
  const paths = [];
  for (let i = 0; i < 45; i++) paths.push(`reports/screenshots/p${String(i).padStart(2, '0')}-${i % 2 ? 'mobile' : 'desktop'}-chromium.png`);
  const out = orderShots(paths);
  assert.equal(out.length, 40);
  assert.ok(out.slice(0, 22).every((p) => p.includes('mobile')));
  assert.deepEqual(out.slice(0, 22), [...out.slice(0, 22)].sort());
  assert.deepEqual(orderShots(['/etc/passwd', '../x.png', 'a/../../x.png', 'ok/a.png', 'bad\nname.png', 'C:\\x.png', 42]), ['ok/a.png']);
});

test('interpretMember passes phone screenshots first and the measurements to the prompt', async () => {
  const prompts = [];
  const ctx = await ctxWith((role, task) => { prompts.push(task); return { text: fence({ findings: [] }) }; });
  const out = await interpretMember(ctx, { member: 'design', label: 'Design', findings: [], notes: [], context: ['x'],
    attach: ['reports/screenshots/a-desktop-chromium.png', 'reports/screenshots/a-mobile-chromium.png'],
    input: { ...input(ctx), briefText: '# Acme brief', policy: { hosting: 'client-box', outbound: [] } } });
  assert.equal(out.status, 'ok');
  const p = prompts[0];
  assert.match(p, /The client's approved brief:\n# Acme brief/);
  assert.match(p, /The client's data policy:\nHosting: the client's own box/);
  assert.ok(p.indexOf('a-mobile-chromium') < p.indexOf('a-desktop-chromium'));
  assert.match(p, /What the checks measured:\n- x/);
});
