import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTask, resume } from '../src/conductor.js';
import { fakeParticipant, approve } from './helpers/fakes.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';
import { councilStubs, SEMGREP_EVAL, GITLEAKS_AKIA } from './helpers/councilStubs.js';
import { git } from '../src/workspace.js';

const PLAN = { summary: 'S', chunks: [{ title: 'Add parser', instructions: 'write app.js' }] };
const planReply = { text: '```json\n' + JSON.stringify(PLAN) + '\n```' };
const isCouncil = (task) => /member of a review council/.test(task);
const keepAll = () => ({ text: '```json\n{"findings":[]}\n```' });
const EVAL = 'export const run = (s) => eval(s);\n';
const SAFE = 'export const run = (s) => JSON.parse(s);\n';
// The local model writes eval() (plus a test file) for the step; a council fix step writes the safe version unless stubborn.
const writeApp = (stubborn = false) => (role, task, c, opts) => {
  writeFileSync(path.join(opts.cwd, 'app.js'), !stubborn && /Council fixes, round/.test(task) ? SAFE : EVAL);
  writeFileSync(path.join(opts.cwd, 'app.test.js'), '// covered\n');
  return { text: 'ok' };
};

function team({ local = writeApp(), council = keepAll } = {}) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role) => (role === 'reviewer' ? approve() : planReply) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task) => (isCouncil(task) ? council(task) : approve()) }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: local }),
  };
}
function hooks(over = {}) {
  const calls = [];
  const rec = (name, ret) => async (arg) => { calls.push({ name, arg }); return ret; };
  return { calls, escalate: rec('escalate', 'reject'), approveResult: rec('approveResult', true), approveChunk: rec('approveChunk', true), ...over };
}
const base = () => mkdtempSync(path.join(tmpdir(), 'cdrv-'));
const opts = (over = {}, tools = { semgrep: SEMGREP_EVAL }) => ({
  council: true, testCommand: 'node -e "process.exit(0)"', councilTools: councilStubs(base(), tools), ...over,
});
const types = (events, t) => events.filter((e) => e.type === t);

test('council off (the default): no council events, no report, the gate gets council: null', async () => {
  const h = hooks();
  const events = [];
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: team(), hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.equal(events.some((e) => e.type.startsWith('council')), false);
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.council, null);
  assert.doesNotMatch(gate.summary, /Council report/);
});

test('blocking → a fix step through the normal loop → final review and full council again → landed', async () => {
  const h = hooks();
  const events = [];
  const t = team();
  const repo = await makeRepo();
  const out = await runTask({ repoDir: repo, request: 'Add a parser', team: t, hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base(), options: opts() });
  assert.equal(out.status, 'landed');
  const fix = types(events, 'council-fix');
  assert.deepEqual(fix.map((e) => [e.round, e.title, e.blocking]), [[1, 'Council fixes, round 1', 1]]);
  assert.equal(types(events, 'council-verdict').length, 2);
  assert.equal(types(events, 'phase').filter((e) => e.name === 'final').length, 2, 'the final review runs again after the fix');
  const fixTask = t.local.calls.find((c) => /Council fixes, round 1/.test(c.task)).task;
  assert.match(fixTask, /Untrusted input reaches eval\(\) — app\.js:1/);
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.council.verdict, 'approved');
  assert.match(gate.summary, /2\. Council fixes, round 1/);
  assert.match(gate.summary, /Council report: approved, nothing to fix\n {2}Round 2 · checked by codex\nFixed during the review \(1\):\n {2}- \[Security\] Untrusted input reaches eval\(\)/);
  assert.equal(readFileSync(path.join(repo, '.git', 'HEAD'), 'utf8').trim(), 'ref: refs/heads/main', 'checkout untouched');
});

test('still blocking after the cap: the operator is asked in plain words; reject stops, approve lands with the report marked', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const h = hooks();
  const events = [];
  const out = await runTask({ repoDir: repo, request: 'x', team: team({ local: writeApp(true) }), hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base(), options: opts({ councilFixRounds: 1 }) });
  assert.equal(out.status, 'stopped');
  assert.equal(types(events, 'council-fix').length, 1, 'exactly one fix round at cap 1');
  assert.equal(out.reason, 'You stopped the run because the council still found problems that must be fixed. Your repository is unchanged.');
  assert.equal(await refsOf(repo), before);
  const esc = h.calls.find((c) => c.name === 'escalate').arg;
  assert.equal(esc.kind, 'council');
  assert.match(esc.message, /still found problems that must be fixed, after every allowed round of fixes/);
  assert.match(esc.message, /The concern: Security: Untrusted input reaches eval\(\)/);

  const ok = hooks({ escalate: async () => 'approve' });
  const events0 = [];
  const landed = await runTask({ repoDir: repo, request: 'y', team: team({ local: writeApp(true) }), hooks: { ...ok, onEvent: (e) => events0.push(e) }, baseDir: base(), options: opts({ councilFixRounds: 0 }) });
  assert.equal(landed.status, 'landed');
  assert.equal(types(events0, 'council-fix').length, 0, 'no fix round at cap 0');
  const gate = ok.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.council.overridden, true);
  assert.match(gate.summary, /Council report: NOT approved: 1 blocking problem remains, and you chose to continue/);
});

test('old problems never bounce, even in a file the change touched (Review Focus 2)', async () => {
  const events = [];
  const h = hooks();
  // The step adds a line to old.js; the old eval() on line 1 is not one of the lines it added.
  const local = (r, t, c, o) => {
    writeFileSync(path.join(o.cwd, 'app.js'), SAFE);
    writeFileSync(path.join(o.cwd, 'old.js'), 'eval(x)\n// touched by this change\n');
    return { text: 'ok' };
  };
  const out = await runTask({ repoDir: await makeRepo({ 'old.js': 'eval(x)\n' }), request: 'x', team: team({ local }),
    hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base(), options: opts() });
  assert.equal(out.status, 'landed');
  assert.equal(types(events, 'council-fix').length, 0);
  assert.match(h.calls.find((c) => c.name === 'approveResult').arg.summary, /old\.js:1\) — already there before this change/);
});

test('a missing tool and a broken tool never stop the run (Review Focus 1)', async () => {
  const h = hooks();
  const tools = councilStubs(base(), { gitleaks: `console.log('gitleaks: please upgrade'); process.exit(3);` });
  tools.semgrep = '/nonexistent/semgrep';
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: team({ local: (r, t, c, o) => { writeFileSync(path.join(o.cwd, 'app.js'), SAFE); return { text: 'ok' }; } }),
    hooks: h, baseDir: base(), options: { council: true, testCommand: 'node -e "process.exit(0)"', councilTools: tools } });
  assert.equal(out.status, 'landed');
  const summary = h.calls.find((c) => c.name === 'approveResult').arg.summary;
  assert.match(summary, /Semgrep \(code scanner\) is not installed, so this check did not run\./);
  assert.match(summary, /Gitleaks \(secret scanner\) did not finish \(.+\), so this check gave no answer\./);
  assert.match(summary, /- \[Security\] Gitleaks \(secret scanner\) could not run/);
});

test('paused in the middle of round 2: resume finishes the round without redoing the fix or resetting the cap (Review Focus 4)', async () => {
  let councilCalls = 0;
  // Round 1 = security (1 finding) + correctness (always) = 2 calls; the 3rd council call finds no model.
  const flaky = () => (++councilCalls === 3 ? { ok: false, failure: 'no-participant', error: 'no AI model is available for codex (codex: rate-limited)' } : keepAll());
  const repo = await makeRepo();
  const baseDir = base();
  const options = opts({ councilFixRounds: 1 });
  const paused = await runTask({ repoDir: repo, request: 'x', team: team({ council: flaky }), hooks: hooks(), baseDir, options });
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /no AI model is available for codex/);

  const t = team();
  const h = hooks();
  const out = await resume({ workspaceDir: paused.workspaceDir, repoDir: repo, team: t, hooks: h });
  assert.equal(out.status, 'landed');
  assert.equal(t.local.calls.length, 0, 'the fix step was already done');
  const transcript = readFileSync(out.transcript, 'utf8');
  assert.equal(transcript.match(/"type":"council-fix"/g).length, 1);
  assert.match(h.calls.find((c) => c.name === 'approveResult').arg.summary, /Round 2 · checked by codex\nFixed during the review \(1\)/);
});

test('a fixer that never fixes, paused in round 2 at cap 1: resume goes to the council escalation, never a second fix (Review Focus 4)', async () => {
  let councilCalls = 0;
  const flaky = () => (++councilCalls === 3 ? { ok: false, failure: 'no-participant', error: 'no AI model is available for codex (codex: rate-limited)' } : keepAll());
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const events = [];
  const onEvent = (e) => events.push(e);
  const paused = await runTask({ repoDir: repo, request: 'x', team: team({ local: writeApp(true), council: flaky }), hooks: { ...hooks(), onEvent }, baseDir: base(), options: opts({ councilFixRounds: 1 }) });
  assert.equal(paused.status, 'paused');
  assert.equal(types(events, 'council-fix').length, 1);

  const t = team({ local: writeApp(true) });
  const h = hooks();   // escalate answers 'reject'
  const out = await resume({ workspaceDir: paused.workspaceDir, repoDir: repo, team: t, hooks: { ...h, onEvent } });
  assert.equal(out.status, 'stopped');
  assert.equal(out.reason, 'You stopped the run because the council still found problems that must be fixed. Your repository is unchanged.');
  assert.equal(h.calls.filter((c) => c.name === 'escalate').map((c) => c.arg.kind).join(), 'council');
  assert.equal(t.local.calls.length, 0, 'no second fix step');
  assert.equal(types(events, 'council-fix').length, 1, 'no second council-fix event');
  assert.equal(await refsOf(repo), before);
});

test('a fixer that never fixes, paused during the queued fix step at cap 1: resume finishes it, then escalates (Review Focus 4)', async () => {
  // The step reviewer has no model when the fix step is reviewed: the run pauses with the fix step queued.
  let pausedOnce = false;
  const reviewer = (task) => {
    if (!pausedOnce && /Council fixes, round 1/.test(task) && !isCouncil(task)) { pausedOnce = true; return { ok: false, failure: 'no-participant', error: 'no AI model is available for codex (codex: rate-limited)' }; }
    return isCouncil(task) ? keepAll() : approve();
  };
  const t1 = team({ local: writeApp(true) });
  t1.reviewer = fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task) => reviewer(task) });
  const repo = await makeRepo();
  const events = [];
  const onEvent = (e) => events.push(e);
  const paused = await runTask({ repoDir: repo, request: 'x', team: t1, hooks: { ...hooks(), onEvent }, baseDir: base(), options: opts({ councilFixRounds: 1 }) });
  assert.equal(paused.status, 'paused', paused.reason);
  assert.equal(types(events, 'council-fix').length, 1);

  const t = team({ local: writeApp(true) });
  const h = hooks();
  const out = await resume({ workspaceDir: paused.workspaceDir, repoDir: repo, team: t, hooks: { ...h, onEvent } });
  assert.equal(out.status, 'stopped');
  assert.equal(h.calls.filter((c) => c.name === 'escalate').map((c) => c.arg.kind).join(), 'council');
  assert.equal(t.local.calls.filter((c) => /Council fixes, round 2/.test(c.task)).length, 0, 'no second fix step');
  assert.equal(types(events, 'council-fix').length, 1, 'no second council-fix event');
});

test('a secret removed by a fix step never reaches your repository\'s history (Review Focus 5, Ruling 10)', async () => {
  const KEY = 'AKIAZXCVBNMASDFGHJKL';
  const local = (r, task, c, o) => {
    writeFileSync(path.join(o.cwd, 'cfg.js'), /Council fixes, round/.test(task) ? 'export const k = process.env.AWS_KEY;\n' : `export const k = "${KEY}";\n`);
    writeFileSync(path.join(o.cwd, 'cfg.test.js'), '// covered\n');
    return { text: 'ok' };
  };
  const repo = await makeRepo();
  const h = hooks();
  const events = [];
  // A secret-looking env value placed in the request must never reach the landed commit message.
  // (Mixed case, so the lower-cased branch slug never equals it and out.branch stays usable.)
  const TOKEN = 'TokRequest9F8E7D6C5B4A';
  const prev = process.env.CONDUCTOR_DRIVE_TEST_TOKEN;
  process.env.CONDUCTOR_DRIVE_TEST_TOKEN = TOKEN;
  let out;
  try {
    out = await runTask({ repoDir: repo, request: `Add config ${TOKEN}`, team: team({ local }), hooks: { ...h, onEvent: (e) => events.push(e) }, baseDir: base(), options: opts({}, { gitleaks: GITLEAKS_AKIA }) });
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_DRIVE_TEST_TOKEN; else process.env.CONDUCTOR_DRIVE_TEST_TOKEN = prev;
  }
  assert.equal(out.status, 'landed');
  const message = (await git(repo, ['log', '--format=%B', `main..${out.branch}`])).stdout;
  assert.match(message, /conductor: Add config \[redacted\] \(steps combined\)/);
  assert.doesNotMatch(message, new RegExp(TOKEN));
  assert.equal(types(events, 'council-fix').length, 1);
  assert.equal(types(events, 'council-squash').length, 1);
  assert.equal((await git(repo, ['rev-list', '--count', `main..${out.branch}`])).stdout.trim(), '1', 'the two step commits were combined');
  assert.doesNotMatch((await git(repo, ['log', '-p', `main..${out.branch}`])).stdout, new RegExp(KEY));
  assert.match((await git(repo, ['show', `${out.branch}:cfg.js`])).stdout, /process\.env\.AWS_KEY/, 'the approved files are exactly what landed');
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.match(gate.summary, /combined into one commit, because the council found a possible secret/);
  assert.doesNotMatch(gate.summary + gate.council.text, new RegExp(KEY));
});

test('without a secret the steps keep their own commits', async () => {
  const repo = await makeRepo();
  const out = await runTask({ repoDir: repo, request: 'Add a parser', team: team(), hooks: hooks(), baseDir: base(), options: opts() });
  assert.equal(out.status, 'landed');
  assert.equal((await git(repo, ['rev-list', '--count', `main..${out.branch}`])).stdout.trim(), '2');
});

test('bad council settings are refused before anything starts', async () => {
  await assert.rejects(runTask({ repoDir: await makeRepo(), request: 'x', team: team(), hooks: hooks(), baseDir: base(), options: { council: true, councilFixRounds: -1 } }), /councilFixRounds must be a whole number from 0 to 10/);
});
