import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { runCouncilRound, hideFiles, validateCouncilOptions, councilToolStatus, MEMBERS_V1 } from '../src/council/index.js';
import { SECURITY } from '../src/council/security.js';
import { CORRECTNESS } from '../src/council/correctness.js';
import { makeFinding } from '../src/council/findings.js';
import { DEFAULT_OPTIONS } from '../src/options.js';
import { fakeParticipant, makeCtx } from './helpers/fakes.js';
import { councilStubs, GITLEAKS_AKIA, printJson } from './helpers/councilStubs.js';

const fence = (o) => '```json\n' + JSON.stringify(o) + '\n```';
const member = (name, titles, alwaysInterpret = false) => ({
  member: name, label: name[0].toUpperCase() + name.slice(1), alwaysInterpret,
  collect: async () => [{ tool: 'semgrep', label: 'Semgrep (code scanner)', status: 'ran', note: null,
    findings: titles.map((t) => makeFinding({ member: name, tool: 'semgrep', grade: 'blocking', title: t, file: 'a.js' })) }],
});

async function ctxWith(reviewerScript = () => ({ text: fence({ findings: [] }) }), options = {}) {
  const events = [];
  const team = {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => ({ text: 'x' }) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: reviewerScript }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: () => ({ text: 'x' }) }),
  };
  const ctx = await makeCtx({ team, hooks: { onEvent: (e) => events.push(e) }, options: { council: true, ...options } });
  ctx.state.plan = { summary: 'S', chunks: [{ title: 'One', instructions: 'i' }] };
  return { ctx, events };
}

test('a round: members one by one, independent prompts, no AI call when a member found nothing', async () => {
  const { ctx, events } = await ctxWith();
  const head = await ctx.ws.head();
  const out = await runCouncilRound(ctx, { files: ['a.js'], tests: null, diff: '+x', members: [member('security', ['SEC-ONLY']), member('legal', []), member('correctness', ['COR-ONLY'], true)] });
  assert.equal(out.status, 'ok');
  assert.equal(out.report.verdict, 'blocked');
  const tasks = ctx.team.reviewer.calls.map((c) => c.task);
  assert.equal(tasks.length, 2, 'legal found nothing and is not alwaysInterpret');
  assert.match(tasks[0], /SEC-ONLY/);
  assert.doesNotMatch(tasks[1], /SEC-ONLY/, 'members never see each other\'s findings');
  assert.deepEqual(events.filter((e) => e.type.startsWith('council')).map((e) => `${e.type}:${e.member ?? ''}:${e.stage ?? e.verdict ?? ''}`), [
    'council-start::', 'council-member:security:tools', 'council-tool:security:', 'council-member:security:interpreting', 'council-member-done:security:',
    'council-member:legal:tools', 'council-tool:legal:', 'council-member-done:legal:',
    'council-member:correctness:tools', 'council-tool:correctness:', 'council-member:correctness:interpreting', 'council-member-done:correctness:',
    'council-finding:security:', 'council-finding:correctness:', 'council-verdict::blocked',
  ]);
  assert.deepEqual(ctx.state.council, { round: 1, fixRounds: 0, secretSeen: false, history: [{ round: 1, sha: head, fixRounds: 0, blocking: [
    { key: 'security|semgrep|a.js|SEC-ONLY', title: 'SEC-ONLY', member: 'security' },
    { key: 'correctness|semgrep|a.js|COR-ONLY', title: 'COR-ONLY', member: 'correctness' },
  ] }] });
  assert.equal(JSON.parse(readFileSync(path.join(ctx.ws.metaDir, 'state.json'), 'utf8')).council.round, 1, 'saved');
  assert.equal(out.report.by, 'codex');
});

test('a paused interpreter leaves the round unfinished, so resume runs it again', async () => {
  const { ctx } = await ctxWith(() => ({ ok: false, failure: 'no-participant', error: 'no AI model is available for codex (codex: rate-limited)' }));
  const out = await runCouncilRound(ctx, { files: [], tests: null, diff: '', members: [member('security', ['x'])] });
  assert.deepEqual(out, { status: 'paused', reason: 'no AI model is available for codex (codex: rate-limited)' });
  assert.equal(ctx.state.council.round, 0);
});

test('a round re-run on the same commit with the same fix count keeps its number (Review Focus 4)', async () => {
  const { ctx } = await ctxWith();
  const members = [member('security', ['x'])];
  await runCouncilRound(ctx, { files: [], tests: null, diff: '', members });
  // A crash after the save, before the fix step was queued (or during the escalation): resume runs it again.
  const again = await runCouncilRound(ctx, { files: [], tests: null, diff: '', members });
  assert.equal(again.report.round, 1);
  assert.equal(ctx.state.council.history.length, 1, 'replaced, not duplicated');
  ctx.state.council.fixRounds = 1;   // a fix step ran, even one that changed nothing
  const next = await runCouncilRound(ctx, { files: [], tests: null, diff: '', members });
  assert.equal(next.report.round, 2);
  assert.deepEqual(next.report.resolved, [], 'still blocking, so not "fixed"');
  assert.equal(ctx.state.council.history.length, 2);
});

test('tests that already failed at the starting commit only warn; the workspace is put back (Ruling 5)', async () => {
  // Fails whenever a.js exists (only after the change), or always.
  const onlyAfter = `node -e "process.exit(require('fs').existsSync('a.js') ? 1 : 0)"`;
  for (const [testCommand, verdict] of [['node -e "process.exit(2)"', 'approved-with-warnings'], [onlyAfter, 'blocked']]) {
    const { ctx, events } = await ctxWith(undefined, { testCommand });
    writeFileSync(path.join(ctx.ws.dir, 'a.js'), 'x\n');
    writeFileSync(path.join(ctx.ws.dir, 'a.test.js'), '// t\n');
    await ctx.ws.commitAll('step');
    const head = await ctx.ws.head();
    const tests = await ctx.ws.runTests(testCommand);
    const out = await runCouncilRound(ctx, { files: ['a.js', 'a.test.js'], tests, diff: '+x', members: [CORRECTNESS] });
    assert.equal(out.report.verdict, verdict, testCommand);
    assert.equal(await ctx.ws.head(), head, 'the workspace is back at the change');
    assert.ok(existsSync(path.join(ctx.ws.dir, 'a.js')));
    assert.equal(events.filter((e) => e.type === 'council-base-tests').length, 1);
    await runCouncilRound(ctx, { files: ['a.js', 'a.test.js'], tests, diff: '+x', members: [CORRECTNESS] });
    assert.equal(events.filter((e) => e.type === 'council-base-tests').length, 1, 'the answer is saved, not asked again');
  }
});

test('a member whose checks throw gives a warning, not a crash', async () => {
  const { ctx } = await ctxWith();
  const broken = { member: 'legal', label: 'Legal', alwaysInterpret: false, collect: async () => { throw new Error('bug'); } };
  const out = await runCouncilRound(ctx, { files: [], tests: null, diff: '', members: [broken] });
  assert.equal(out.report.verdict, 'approved-with-warnings');
  assert.match(out.report.text, /The Legal checks hit a problem \(bug\), so they gave no answer\./);
});

test('a secret found in the change never reaches a prompt, the transcript or the report (Review Focus 5)', async () => {
  const KEY = 'AKIAQWERTYUIOPASDFGH';
  const { ctx } = await ctxWith(undefined, { councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'crnd-')), { gitleaks: GITLEAKS_AKIA }) });
  writeFileSync(path.join(ctx.ws.dir, 'cfg.js'), `export const k = "${KEY}";\n`);
  await ctx.ws.commitAll('step'); // committed, so its line counts as added by this change
  const diff = `diff --git a/cfg.js b/cfg.js\n+export const k = "${KEY}";\ndiff --git a/b.js b/b.js\n+ok\n`;
  const out = await runCouncilRound(ctx, { files: ['cfg.js', 'b.js'], tests: null, diff, members: [SECURITY, member('correctness', [], true)] });
  assert.equal(out.report.verdict, 'blocked');
  for (const c of ctx.team.reviewer.calls) assert.doesNotMatch(c.task, new RegExp(KEY));
  assert.match(ctx.team.reviewer.calls[1].task, /changes to cfg\.js hidden: the secret scanner found a possible secret in it/);
  assert.match(ctx.team.reviewer.calls[1].task, /\+ok/);
  assert.doesNotMatch(out.report.text, new RegExp(KEY));
  assert.doesNotMatch(readFileSync(ctx.log.transcript, 'utf8'), new RegExp(KEY));
  assert.equal(ctx.state.council.secretSeen, true, 'Task 7 combines the commits before the gate');
});

test('hideFiles swaps whole file sections of a diff', () => {
  const d = 'diff --git a/x b/x\n+1\ndiff --git a/y b/y\n+2\n';
  assert.equal(hideFiles(d, new Set(['x'])), 'diff --git a/x b/x\n(changes to x hidden: the secret scanner found a possible secret in it)\ndiff --git a/y b/y\n+2\n');
  assert.equal(hideFiles(d, new Set()), d);
});

test('hideFiles finds the path in spaced, quoted and deleted forms', () => {
  const d = 'diff --git a/my file.js b/my file.js\n--- a/my file.js\t\n+++ b/my file.js\t\n@@ -0,0 +1 @@\n+k\n' +
    'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\n--- "a/caf\\303\\251.js"\n+++ "b/caf\\303\\251.js"\n@@ -0,0 +1 @@\n+k\n' +
    'diff --git a/gone.js b/gone.js\ndeleted file mode 100644\n--- a/gone.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-k\n' +
    'diff --git a/keep.js b/keep.js\n--- a/keep.js\n+++ b/keep.js\n@@ -0,0 +1 @@\n+visible\n';
  const out = hideFiles(d, new Set(['my file.js', 'café.js', 'gone.js']));
  assert.doesNotMatch(out, /^[+-]k$/m);
  for (const p of ['my file\\.js', 'café\\.js', 'gone\\.js']) assert.match(out, new RegExp(`\\(changes to ${p} hidden`));
  assert.match(out, /^\+visible$/m);
});

test('validateCouncilOptions explains bad settings in plain words; off means unchecked', () => {
  const v = (o) => () => validateCouncilOptions({ ...DEFAULT_OPTIONS, council: true, ...o });
  assert.doesNotThrow(v({}));
  assert.throws(v({ councilFixRounds: 11 }), /councilFixRounds must be a whole number from 0 to 10/);
  assert.throws(v({ councilFixRounds: 1.5 }), /councilFixRounds/);
  assert.throws(v({ councilAcceptLicences: 'GPL' }), /councilAcceptLicences must be a list of licence names/);
  assert.throws(v({ councilTools: { semgrep: 1 } }), /councilTools must map a tool name to a path or false/);
  assert.throws(v({ councilTools: { trivy: false } }), /councilTools: unknown tool "trivy" \(known: semgrep, gitleaks, npm-audit, scancode\)/);
  assert.throws(v({ councilToolTimeoutMs: 0 }), /councilToolTimeoutMs must be a whole number of milliseconds above 0 \(got 0\)/);
  assert.throws(v({ councilToolTimeoutMs: 1.5 }), /councilToolTimeoutMs must be a whole number/);
  assert.throws(v({ councilToolTimeoutMs: '600000' }), /councilToolTimeoutMs must be a whole number/);
  assert.throws(v({ councilSemgrepConfig: '' }), /councilSemgrepConfig must be a Semgrep rules pack name or a rules file path \(got ""\)/);
  assert.throws(v({ councilSemgrepConfig: 5 }), /councilSemgrepConfig must be/);
  assert.doesNotThrow(() => validateCouncilOptions({ ...DEFAULT_OPTIONS, councilFixRounds: 99 }));
});

test('councilToolStatus reports each optional tool for doctor', () => {
  const status = councilToolStatus({ options: { ...DEFAULT_OPTIONS, councilTools: { semgrep: false } }, env: { PATH: '' } });
  assert.deepEqual(status.map((s) => [s.tool, s.ok, s.why]), [
    ['semgrep', false, 'turned off in the config'], ['gitleaks', false, 'not installed'], ['npm-audit', false, 'not installed'], ['scancode', false, 'not installed'],
  ]);
  assert.deepEqual(MEMBERS_V1.map((m) => m.member), ['security', 'legal', 'correctness']);
});

test('carry-overs: user git config cannot break added lines, and a new empty file counts as introduced', async () => {
  const body = printJson({ results: [{ check_id: 'r', path: 'empty.js', start: { line: 1 }, extra: { message: 'Bad thing', severity: 'ERROR' } }], errors: [] });
  const { ctx } = await ctxWith(undefined, { councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'crnd-')), { semgrep: body }) });
  execFileSync('git', ['config', 'diff.noprefix', 'true'], { cwd: ctx.ws.dir });
  execFileSync('git', ['config', 'diff.mnemonicPrefix', 'true'], { cwd: ctx.ws.dir });
  writeFileSync(path.join(ctx.ws.dir, 'empty.js'), '');
  writeFileSync(path.join(ctx.ws.dir, 'b.js'), 'x\n');
  await ctx.ws.commitAll('step');
  const out = await runCouncilRound(ctx, { files: ['empty.js', 'b.js'], tests: null, diff: '', members: [SECURITY] });
  assert.equal(out.report.blocking.length, 1);
  assert.equal(out.report.blocking[0].preExisting, false);
});

test('the one-off base test run puts the workspace back even when the test command throws', async () => {
  const { ctx } = await ctxWith(undefined, { testCommand: 'false' });
  writeFileSync(path.join(ctx.ws.dir, 'a.js'), 'x\n');
  await ctx.ws.commitAll('step');
  const head = await ctx.ws.head();
  const tests = { ran: true, passed: false, code: 1, output: '' };
  ctx.ws.runTests = async () => { throw new Error('boom'); };
  await assert.rejects(runCouncilRound(ctx, { files: ['a.js'], tests, diff: '', members: [CORRECTNESS] }), /boom/);
  assert.equal(await ctx.ws.head(), head);
  assert.ok(existsSync(path.join(ctx.ws.dir, 'a.js')));
});

test('carry-over (a): with diff.noprefix, a file under a top-level b/ directory still gets its added lines right', async () => {
  const res = (line) => ({ check_id: 'r', path: 'b/old.js', start: { line }, extra: { message: `Bad L${line}`, severity: 'ERROR' } });
  const body = printJson({ results: [res(1), res(3)], errors: [] });
  const events = [];
  const team = {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => ({ text: 'x' }) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: () => ({ text: fence({ findings: [] }) }) }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: () => ({ text: 'x' }) }),
  };
  const ctx = await makeCtx({ team, files: { 'b/old.js': 'l1\nl2\n' }, hooks: { onEvent: (e) => events.push(e) },
    options: { council: true, councilTools: councilStubs(mkdtempSync(path.join(tmpdir(), 'crnd-')), { semgrep: body }) } });
  ctx.state.plan = { summary: 'S', chunks: [{ title: 'One', instructions: 'i' }] };
  execFileSync('git', ['config', 'diff.noprefix', 'true'], { cwd: ctx.ws.dir });
  writeFileSync(path.join(ctx.ws.dir, 'b/old.js'), 'l1\nl2\nl3\n');
  await ctx.ws.commitAll('step');
  const out = await runCouncilRound(ctx, { files: ['b/old.js'], tests: null, diff: '', members: [SECURITY] });
  assert.deepEqual(out.report.blocking.map((f) => f.title), ['Bad L3'], 'the added line blocks');
  assert.deepEqual(out.report.warnings.map((f) => [f.title, f.preExisting]), [['Bad L1', true]], 'the old line is already there');
});
