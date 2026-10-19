import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, existsSync, mkdtempSync, appendFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTask, resume, validateTeam } from '../src/conductor.js';
import { git, Workspace } from '../src/workspace.js';
import { fakeParticipant, approve, block } from './helpers/fakes.js';
import { makeRepo, refsOf } from './helpers/gitRepo.js';

const PLAN = { summary: 'S', chunks: [{ title: 'One', instructions: 'make one' }, { title: 'Two', instructions: 'make two' }] };
const planReply = { text: '```json\n' + JSON.stringify(PLAN) + '\n```' };
const stepOf = (task) => Number(/chunk (\d+) of/.exec(task)?.[1] ?? 0);

function makeTeam({ reviewer = () => approve(), local } = {}) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, task) => (role === 'reviewer' ? approve() : planReply) }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: (role, task, c, o, n) => reviewer(role, task, n) }),
    local: fakeParticipant({
      name: 'local', kind: 'local-agent', roles: ['grunt'],
      script: local ?? ((role, task, c, opts) => { writeFileSync(path.join(opts.cwd, `step${stepOf(task)}.txt`), 'x\n'); return { text: 'ok' }; }),
    }),
  };
}

function hooks(over = {}) {
  const calls = [];
  const rec = (name, ret) => async (arg) => { calls.push({ name, arg }); return ret; };
  return { calls, escalate: rec('escalate', 'reject'), approveResult: rec('approveResult', true), approveChunk: rec('approveChunk', true), ...over };
}

const base = () => mkdtempSync(path.join(tmpdir(), 'cond-'));

test('validateTeam enforces roles, editing and the two-vendor rule', () => {
  const t = makeTeam();
  assert.doesNotThrow(() => validateTeam(t));
  assert.throws(() => validateTeam({ ...t, reviewer: fakeParticipant({ name: 'c2', kind: 'claude-code', script: approve }) }), /two-vendor/);
  assert.throws(() => validateTeam({ ...t, reviewer: fakeParticipant({ name: 'r', kind: 'codex', roles: ['reviewer'], script: approve }) }), /must be able to play author/);
  assert.throws(() => validateTeam({ ...t, local: fakeParticipant({ name: 'l', kind: 'x', roles: ['author'], script: approve }) }), /grunt/);
  assert.throws(() => validateTeam({ author: t.author }), /needs author, reviewer and local/);
});

test('runTask rejects bad input before touching anything', async () => {
  const h = hooks();
  await assert.rejects(runTask({ repoDir: await makeRepo(), request: '  ', team: makeTeam(), hooks: h, baseDir: base() }), /request/);
  await assert.rejects(runTask({ repoDir: base(), request: 'x', team: makeTeam(), hooks: h, baseDir: base() }), /not a git repository/);
  await assert.rejects(runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: { escalate: h.escalate }, baseDir: base() }), /approveResult/);
});

test('happy path lands a new branch with one commit per chunk; checkout untouched', async () => {
  const repo = await makeRepo();
  const h = hooks();
  const out = await runTask({ repoDir: repo, request: 'Add steps', team: makeTeam(), hooks: h, baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.equal(out.branch, 'conductor/add-steps');
  assert.equal((await git(repo, ['rev-list', '--count', `main..${out.branch}`])).stdout.trim(), '2');
  assert.equal((await git(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim(), 'main');
  assert.equal((await git(repo, ['status', '--porcelain'])).stdout, '');
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.match(gate.summary, /1\. One[\s\S]*2\. Two/);
  assert.deepEqual(gate.files.sort(), ['step1.txt', 'step2.txt']);
  assert.equal(gate.finalReview.decision, 'APPROVE');
  assert.match(gate.diff, /step2\.txt/);
});

test('a rejected result leaves the real repo exactly as it was', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveResult: async () => false }), baseDir: base() });
  assert.equal(out.status, 'rejected');
  assert.equal(await refsOf(repo), before);
  assert.equal((await git(repo, ['status', '--porcelain'])).stdout, '');
  // m4: nothing left to resume, so the workspace is deleted and the transcript kept.
  assert.equal(out.workspaceDir, null);
  assert.match(out.transcript, /logs[/\\]conductor-x\.jsonl$/);
  assert.match(readFileSync(out.transcript, 'utf8'), /"type":"finish"/);
});

test('a throwing final gate is a rejection, not a landing', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveResult: async () => { throw new Error('ui died'); } }), baseDir: base() });
  assert.equal(out.status, 'rejected');
  assert.equal(await refsOf(repo), before);
});

test('user rejecting an escalated plan stops before any chunk runs', async () => {
  const t = makeTeam({ reviewer: () => block('IRREVERSIBLE: drops data') });
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: t, hooks: hooks(), baseDir: base(), options: { planRounds: 1 } });
  assert.equal(out.status, 'stopped');
  assert.equal(t.local.calls.length, 0);
});

test('approveEachChunk: declining after step 1 stops the run', async () => {
  const t = makeTeam();
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: t, hooks: hooks({ approveChunk: async () => false }), baseDir: base(), options: { approveEachChunk: true } });
  assert.equal(out.status, 'stopped');
  assert.equal(t.local.calls.length, 1);
});

test('a blocking final review still reaches the gate, with its concern in the summary', async () => {
  const reviewer = (role, task) => (/Full diff of the finished branch/.test(task) ? block('IRREVERSIBLE: removes a public API') : approve());
  const h = hooks({ approveResult: async (arg) => { h.calls.push({ name: 'approveResult', arg }); return false; } });
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam({ reviewer }), hooks: h, baseDir: base() });
  assert.equal(out.status, 'rejected');
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.finalReview.decision, 'BLOCK');
  assert.match(gate.summary, /Final review concern: removes a public API/);
});

test('landing picks a free name when the branch already exists', async () => {
  const repo = await makeRepo();
  await git(repo, ['branch', 'conductor/x']);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.equal(out.branch, 'conductor/x-2');
  assert.equal((await git(repo, ['rev-parse', 'conductor/x'])).stdout.trim(), (await git(repo, ['rev-parse', 'main'])).stdout.trim());
});

test('resume after a crash discards the half-done chunk and continues', async () => {
  const repo = await makeRepo();
  const first = makeTeam();
  const stopped = await runTask({ repoDir: repo, request: 'x', team: first, hooks: hooks({ approveChunk: async () => false }), baseDir: base(), options: { approveEachChunk: true, testCommand: 'true' } });
  assert.equal(stopped.status, 'stopped');
  // Simulate a crash mid-step-2: state still "running", half-written file in the workspace.
  const statePath = path.join(`${stopped.workspaceDir}.conductor`, 'state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...st, status: 'running', phase: 'chunks' }));
  writeFileSync(path.join(stopped.workspaceDir, 'half.txt'), 'partial');

  const second = makeTeam();
  const out = await resume({ workspaceDir: stopped.workspaceDir, repoDir: repo, team: second, hooks: hooks(), options: { approveEachChunk: false, keepWorkspace: true } });
  assert.equal(out.status, 'landed');
  assert.equal(second.local.calls.length, 1);
  assert.match(second.local.calls[0].task, /chunk 2 of 2/);
  assert.equal(second.author.calls.filter((c) => c.role === 'author').length, 0);
  assert.deepEqual((await git(repo, ['show', '--name-only', '--format=', out.branch])).stdout.trim().split('\n'), ['step2.txt']);
  assert.ok(!existsSync(path.join(stopped.workspaceDir, 'half.txt')));
  assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).options.testCommand, 'true');
});

test('resume of a finished run returns its outcome without calling agents', async () => {
  const repo = await makeRepo();
  const done = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base(), options: { keepWorkspace: true } });
  const t = makeTeam();
  const again = await resume({ workspaceDir: done.workspaceDir, repoDir: repo, team: t, hooks: hooks() });
  assert.equal(again.status, 'landed');
  assert.equal(again.branch, done.branch);
  assert.equal(t.author.calls.length + t.reviewer.calls.length + t.local.calls.length, 0);
});

test('an unexpected error mid-run becomes failed, and resume continues it', async () => {
  const repo = await makeRepo();
  let wsDir = null;
  let headBackup = null;
  const h = hooks({
    onEvent: (e) => { if (e.type === 'start') wsDir = e.workspace; },
    approveChunk: async () => {
      headBackup = readFileSync(path.join(wsDir, '.git', 'HEAD'), 'utf8');
      writeFileSync(path.join(wsDir, '.git', 'HEAD'), 'garbage\n');
      return true;
    },
  });
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: h, baseDir: base(), options: { approveEachChunk: true } });
  assert.equal(out.status, 'failed');
  assert.ok(out.reason);

  writeFileSync(path.join(wsDir, '.git', 'HEAD'), headBackup);
  const again = await resume({ workspaceDir: wsDir, repoDir: repo, team: makeTeam(), hooks: hooks(), options: { approveEachChunk: false } });
  assert.equal(again.status, 'landed');
});

// ---- Additional pins for the Task 9 non-negotiables (beyond the brief) ----

const untouched = async (repo) => ({
  refs: await refsOf(repo),
  status: (await git(repo, ['status', '--porcelain', '--ignored'])).stdout,
  head: (await git(repo, ['rev-parse', 'HEAD'])).stdout,
  files: (await git(repo, ['ls-files', '--others', '--cached'])).stdout,
});

test('stopped and failed runs leave the real repo exactly as it was (Review Focus 1)', async () => {
  const repo = await makeRepo();
  const before = await untouched(repo);
  const stopped = await runTask({ repoDir: repo, request: 'x', team: makeTeam({ reviewer: () => block('IRREVERSIBLE: drops data') }), hooks: hooks(), baseDir: base(), options: { planRounds: 1 } });
  assert.equal(stopped.status, 'stopped');
  const t = makeTeam();
  t.author = fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => ({ text: 'no plan here' }) });
  const failed = await runTask({ repoDir: repo, request: 'y', team: t, hooks: hooks(), baseDir: base(), options: { planRounds: 1 } });
  assert.equal(failed.status, 'failed');
  const midChunk = await runTask({
    repoDir: repo, request: 'z', baseDir: base(), hooks: hooks(),
    team: makeTeam({ local: (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, '.git', 'HEAD'), 'garbage\n'); return { text: 'ok' }; } }),
  });
  assert.equal(midChunk.status, 'failed');
  assert.deepEqual(await untouched(repo), before);
});

test('only an explicit true from approveResult lands', async () => {
  for (const ret of ['yes', 1, 'approve', {}, undefined]) {
    const repo = await makeRepo();
    const before = await refsOf(repo);
    const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveResult: async () => ret }), baseDir: base() });
    assert.equal(out.status, 'rejected', `approveResult returned ${JSON.stringify(ret)}`);
    assert.equal(await refsOf(repo), before);
  }
});

test('a genuine throw inside a chunk fails the run; resume keeps completed chunks and their shas (Review Focus 3)', async () => {
  const repo = await makeRepo();
  let crash = true;
  const local = (role, task, c, opts) => {
    const n = stepOf(task);
    writeFileSync(path.join(opts.cwd, `step${n}.txt`), 'x\n');
    // Corrupting HEAD makes both the inspection and its rollback fail: an infrastructure throw out of runChunk.
    if (n === 2 && crash) writeFileSync(path.join(opts.cwd, '.git', 'HEAD'), 'garbage\n');
    return { text: 'ok' };
  };
  let wsDir = null;
  const t1 = makeTeam({ local });
  const out = await runTask({ repoDir: repo, request: 'crashy', team: t1, hooks: hooks({ onEvent: (e) => { if (e.type === 'start') wsDir = e.workspace; } }), baseDir: base() });
  assert.equal(out.status, 'failed');
  const statePath = path.join(`${wsDir}.conductor`, 'state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal(st.status, 'failed');
  assert.equal(st.chunkIndex, 1);
  assert.equal(st.chunkShas.length, 1);
  const chunk1 = st.chunkShas[0];

  writeFileSync(path.join(wsDir, '.git', 'HEAD'), `ref: refs/heads/${st.taskId}\n`);
  crash = false;
  const t2 = makeTeam({ local });
  const again = await resume({ workspaceDir: wsDir, repoDir: repo, team: t2, hooks: hooks(), options: { keepWorkspace: true } });
  assert.equal(again.status, 'landed');
  assert.equal(t2.local.calls.length, 1);
  assert.match(t2.local.calls[0].task, /chunk 2 of 2/);
  assert.equal(t2.author.calls.filter((c) => c.role === 'author').length, 0);
  assert.equal((await git(repo, ['rev-parse', `${again.branch}~1`])).stdout.trim(), chunk1);
  assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8')).chunkShas[0], chunk1);
});

test('a plan-phase failure gives the user a plain reason, details stay in the transcript', async () => {
  const t = makeTeam();
  t.author = fakeParticipant({ name: 'claude', kind: 'claude-code', script: () => ({ ok: false, error: 'claude exited 1: stderr: ECONNRESET' }) });
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: t, hooks: hooks(), baseDir: base(), options: { planRounds: 1 } });
  assert.equal(out.status, 'failed');
  assert.doesNotMatch(out.reason, /exited|stderr|ECONNRESET|author failed/);
  const transcript = readFileSync(path.join(`${out.workspaceDir}.conductor`, 'transcript.jsonl'), 'utf8');
  assert.match(transcript, /ECONNRESET/);
});

test('an agent switching the workspace branch has that attempt discarded; its branch is never recorded or landed', async () => {
  const repo = await makeRepo();
  const events = [];
  const local = async (role, task, c, opts) => {
    await git(opts.cwd, ['checkout', '-q', '-B', 'sneaky']);
    writeFileSync(path.join(opts.cwd, `step${stepOf(task)}.txt`), 'x\n');
    await git(opts.cwd, ['add', '-A']);
    await git(opts.cwd, ['commit', '-q', '-m', 'sneaky work']);
    return { text: 'ok' };
  };
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam({ local }), hooks: hooks({ onEvent: (e) => events.push(e) }), baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.equal(out.branch, 'conductor/x');
  assert.ok(events.some((e) => e.type === 'branch-switched' && e.found === 'sneaky'));
  assert.equal((await git(repo, ['rev-parse', '--verify', '--quiet', 'sneaky'])).code, 1);
  // The fake fallback author edits nothing, so nothing the switching agent wrote was shipped.
  assert.equal((await git(repo, ['diff', '--name-only', 'main', out.branch])).stdout.trim(), '');
});

test('a detached workspace HEAD is put back on the run branch; the detached attempt is not landed', async () => {
  const repo = await makeRepo();
  const local = async (role, task, c, opts) => {
    writeFileSync(path.join(opts.cwd, `step${stepOf(task)}.txt`), 'x\n');
    if (stepOf(task) === 2) await git(opts.cwd, ['checkout', '-q', '--detach']);
    return { text: 'ok' };
  };
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam({ local }), hooks: hooks(), baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.deepEqual((await git(repo, ['diff', '--name-only', 'main', out.branch])).stdout.trim().split('\n'), ['step1.txt']);
});

// ---- Final-review fixes: I1 (approved == landed) and I2 (agent-writable .git) ----

test('a test command that commits during the final phase cannot ship unseen work (I1)', async () => {
  const repo = await makeRepo();
  const counter = path.join(base(), 'runs');
  // Runs 1 and 2 are the chunk tests; run 3 is the final-phase test run, after the diff was taken.
  const testCommand = `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'; ` +
    'if [ $n -ge 3 ]; then echo sneaky > extra.txt; git add extra.txt; git -c user.name=t -c user.email=t@t -c core.hooksPath=/dev/null commit -qm sneaky; fi; true';
  const h = hooks();
  const events = [];
  h.onEvent = (e) => events.push(e);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: h, baseDir: base(), options: { testCommand } });
  assert.equal(out.status, 'landed');
  assert.equal(readFileSync(counter, 'utf8').trim(), '3');
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.deepEqual(gate.files.sort(), ['step1.txt', 'step2.txt']);
  const landed = (await git(repo, ['diff', '--name-only', 'main', out.branch])).stdout.trim().split('\n').sort();
  assert.deepEqual(landed, gate.files.sort());
  assert.ok(events.some((e) => e.type === 'final-drift'));
});

test('an agent that rewrites .git/config is caught: config restored, payload never runs (I2)', async () => {
  const repo = await makeRepo();
  const d = base();
  const marker = path.join(d, 'pwned');
  const hook = path.join(d, 'hook.sh');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  const events = [];
  const local = (role, task, c, opts) => {
    appendFileSync(path.join(opts.cwd, '.git', 'config'), `[core]\n\tfsmonitor = ${hook}\n[diff]\n\texternal = ${hook}\n`);
    writeFileSync(path.join(opts.cwd, `step${stepOf(task)}.txt`), 'x\n');
    return { text: 'ok' };
  };
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam({ local }), hooks: hooks({ onEvent: (e) => events.push(e) }), baseDir: base(), options: { keepWorkspace: true } });
  assert.equal(out.status, 'landed');
  assert.ok(!existsSync(marker), 'payload executed');
  const tampered = events.filter((e) => e.type === 'config-tampered');
  assert.equal(tampered.length, 2);
  assert.equal(tampered[0].participant, 'local');
  assert.doesNotMatch(readFileSync(path.join(out.workspaceDir, '.git', 'config'), 'utf8'), /fsmonitor/);
});

test('resume refuses a different repoDir, or a state.json pointing elsewhere (I2)', async () => {
  const repo = await makeRepo();
  const other = await makeRepo();
  const stopped = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveChunk: async () => false }), baseDir: base(), options: { approveEachChunk: true } });
  const statePath = path.join(`${stopped.workspaceDir}.conductor`, 'state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...st, status: 'running' }));
  const otherBefore = await refsOf(other);
  const t = makeTeam();
  const wrong = await resume({ workspaceDir: stopped.workspaceDir, repoDir: other, team: t, hooks: hooks() });
  assert.equal(wrong.status, 'failed');
  assert.match(wrong.reason, /will not resume/);
  writeFileSync(statePath, JSON.stringify({ ...st, status: 'running', repoDir: other }));
  const tampered = await resume({ workspaceDir: stopped.workspaceDir, repoDir: repo, team: t, hooks: hooks() });
  assert.equal(tampered.status, 'failed');
  assert.equal(t.local.calls.length + t.author.calls.length + t.reviewer.calls.length, 0);
  assert.equal(await refsOf(other), otherBefore);
  await assert.rejects(resume({ workspaceDir: stopped.workspaceDir, team: t, hooks: hooks() }), /repoDir/);
});

test('a crash between land and finish: resume reports the landed branch, no duplicate -2 (T9-M1)', async () => {
  const repo = await makeRepo();
  let wsDir = null;
  const real = Workspace.prototype.land;
  Workspace.prototype.land = async function (args) {
    await real.call(this, args);
    throw new Error('power cut');
  };
  let out;
  try {
    out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ onEvent: (e) => { if (e.type === 'start') wsDir = e.workspace; } }), baseDir: base() });
  } finally {
    Workspace.prototype.land = real;
  }
  assert.equal(out.status, 'failed');
  assert.equal((await git(repo, ['rev-parse', '--verify', '--quiet', 'conductor/x'])).code, 0);
  const t = makeTeam();
  const h = hooks();
  const again = await resume({ workspaceDir: wsDir, repoDir: repo, team: t, hooks: h });
  assert.equal(again.status, 'landed');
  assert.equal(again.branch, 'conductor/x');
  assert.equal((await git(repo, ['rev-parse', '--verify', '--quiet', 'conductor/x-2'])).code, 1);
  assert.equal(h.calls.length, 0);
});

test('a step nobody could produce fails the run (not "stopped") without asking the user (I4)', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const t = makeTeam({ local: () => ({ ok: false, error: 'timed out' }) });
  t.author = fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role, task) => (role === 'author' && /chunk \d+ of/.test(task) ? { ok: false, error: 'rate limited' } : role === 'reviewer' ? approve() : planReply) });
  const h = hooks();
  const out = await runTask({ repoDir: repo, request: 'x', team: t, hooks: h, baseDir: base(), options: { localRounds: 1, frontierRounds: 1 } });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /could not be completed/);
  assert.equal(h.calls.filter((c) => c.name === 'escalate').length, 0);
  assert.equal(await refsOf(repo), before);
});

// ---- Final-review fixes: Task 9 ledger minors, m1, m2, m4, m5, m8 ----

test('validateTeam needs can_edit_files; validateHooks needs escalate, and approveChunk when asked (T9-M6)', async () => {
  const { validateHooks } = await import('../src/conductor.js');
  const t = makeTeam();
  const { Participant } = await import('../src/participant.js');
  const readOnly = new Participant({ name: 'ro', adapter: { kind: 'local-agent', run: async () => ({}) }, roles: ['grunt'] });
  assert.throws(() => validateTeam({ ...t, local: readOnly }), /can_edit_files/);
  assert.throws(() => validateHooks({ approveResult: async () => true }, {}), /escalate/);
  assert.throws(() => validateHooks({ escalate: async () => 'reject', approveResult: async () => true }, { approveEachChunk: true }), /approveChunk/);
});

test('happy path: phase "done", source line in the summary, workspace removed, transcript kept (T9-M4, m4, m5)', async () => {
  const repo = await makeRepo();
  writeFileSync(path.join(repo, 'wip.txt'), 'uncommitted');
  const h = hooks();
  const events = [];
  h.onEvent = (e) => events.push(e);
  const b = base();
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: h, baseDir: b });
  assert.equal(out.status, 'landed');
  assert.equal(out.workspaceDir, null);
  assert.deepEqual(readdirSync(b).sort(), ['logs']);
  const transcript = readFileSync(out.transcript, 'utf8');
  assert.equal(out.transcript, path.join(b, 'logs', 'conductor-x.jsonl'));
  assert.match(transcript.trim().split('\n').at(-1), /"type":"finish"/);
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.match(gate.summary, /Started from commit [0-9a-f]{7} on branch main; your uncommitted changes were not included\./);
  assert.ok(events.some((e) => e.type === 'warning' && e.kind === 'uncommitted-changes'));
  // A second run with the same name does not overwrite the first transcript.
  const again = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks(), baseDir: b });
  assert.equal(again.transcript, path.join(b, 'logs', 'conductor-x-2.jsonl'));
});

test('keepWorkspace keeps the workspace; its final state says phase "done" (m4, T9-M4)', async () => {
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base(), options: { keepWorkspace: true } });
  assert.equal(out.status, 'landed');
  assert.ok(existsSync(out.workspaceDir));
  const st = JSON.parse(readFileSync(path.join(`${out.workspaceDir}.conductor`, 'state.json'), 'utf8'));
  assert.equal(st.phase, 'done');
  assert.equal(st.status, 'landed');
});

test('approveChunk gets files, a plain note and the tests (m1)', async () => {
  const seen = [];
  const reviewer = (role, task) => (/Review chunk 1/.test(task) ? block('IRREVERSIBLE: renames a thing') : approve());
  const h = hooks({ approveChunk: async (arg) => { seen.push(arg); return true; }, escalate: async () => 'approve' });
  const team = makeTeam({ reviewer });
  // The fallback author also writes the step file, so the approved chunk has content.
  team.author = fakeParticipant({
    name: 'claude', kind: 'claude-code',
    script: (role, task, c, opts) => {
      if (role === 'reviewer') return approve();
      if (!/chunk \d+ of/.test(task)) return planReply;
      writeFileSync(path.join(opts.cwd, `step${stepOf(task)}.txt`), 'x\n');
      return { text: 'ok' };
    },
  });
  const out = await runTask({ repoDir: await makeRepo(), request: 'x', team, hooks: h, baseDir: base(), options: { approveEachChunk: true, testCommand: 'true', localRounds: 1, frontierRounds: 1 } });
  assert.equal(out.status, 'landed');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].index, 0);
  assert.equal(seen[0].total, 2);
  assert.deepEqual(seen[0].files, ['step1.txt']);
  assert.equal(seen[0].tests.passed, true);
  assert.match(seen[0].note, /renames a thing/);
  assert.doesNotMatch(seen[0].note, /IRREVERSIBLE/);
});

test('approveResult never sees the raw IRREVERSIBLE marker (m2)', async () => {
  const reviewer = (role, task) => (/Full diff of the finished branch/.test(task)
    ? { text: 'IRREVERSIBLE: this drops a column', ...block('IRREVERSIBLE: drops a column') } : approve());
  const h = hooks({ approveResult: async (arg) => { h.calls.push({ name: 'approveResult', arg }); return false; } });
  await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam({ reviewer }), hooks: h, baseDir: base() });
  const gate = h.calls.find((c) => c.name === 'approveResult').arg;
  assert.equal(gate.finalReview.reason, 'drops a column');
  assert.doesNotMatch(JSON.stringify(gate), /IRREVERSIBLE/);
});

test('an unexpected error gets a plain reason; the detail stays in the transcript (m8)', async () => {
  const repo = await makeRepo();
  let wsDir = null;
  const h = hooks({
    onEvent: (e) => { if (e.type === 'start') wsDir = e.workspace; },
    approveChunk: async () => { writeFileSync(path.join(wsDir, '.git', 'HEAD'), 'garbage\n'); return true; },
  });
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: h, baseDir: base(), options: { approveEachChunk: true } });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /^Conductor hit an internal problem and stopped\. Your repository was not changed\./);
  assert.doesNotMatch(out.reason, /git|fatal/);
  assert.match(readFileSync(path.join(`${wsDir}.conductor`, 'transcript.jsonl'), 'utf8'), /"type":"run-error"/);
});

test('a land failure says the branch could not be created and where the work is kept (m8)', async () => {
  const real = Workspace.prototype.land;
  Workspace.prototype.land = async function ({ branch }) { return { ok: false, branch, error: 'fetch failed: disk full' }; };
  let out;
  try {
    out = await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base() });
  } finally {
    Workspace.prototype.land = real;
  }
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /^Could not create the result branch in your repository: fetch failed: disk full; the finished work is kept in /);
  assert.ok(out.reason.includes(out.workspaceDir));
});

test('all of conductor/x and -2..-9 taken: failed, says where the work is, and no ref moves (T9-M6)', async () => {
  const repo = await makeRepo();
  for (const s of ['', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9']) await git(repo, ['branch', `conductor/x${s}`]);
  const before = await refsOf(repo);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base() });
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /every branch name conductor\/x\[-2\.\.-9\] is taken/);
  assert.ok(out.reason.includes(out.workspaceDir));
  assert.equal(await refsOf(repo), before);
});

test('runTask: a working copy that cannot be made, or a run state that cannot be written, is a failed outcome (T9-M5, T9c)', async () => {
  const broken = await makeRepo({ 'a.txt': 'blob that will vanish\n' });
  const blob = (await git(broken, ['rev-parse', 'HEAD:a.txt'])).stdout.trim();
  const { rmSync } = await import('node:fs');
  rmSync(path.join(broken, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));
  const a = await runTask({ repoDir: broken, request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base() });
  assert.equal(a.status, 'failed');
  assert.match(a.reason, /^Could not make a working copy of your repository/);

  const { RunLog } = await import('../src/runlog.js');
  const real = RunLog.prototype.saveState;
  RunLog.prototype.saveState = () => { throw new Error('ENOSPC'); };
  let b;
  try {
    b = await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: hooks(), baseDir: base() });
  } finally {
    RunLog.prototype.saveState = real;
  }
  assert.equal(b.status, 'failed');
  assert.match(b.reason, /could not write its run state/);
});

test('resume validates the saved state and never rejects on a broken workspace (T9-M3, T9b)', async () => {
  const repo = await makeRepo();
  const stopped = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveChunk: async () => false }), baseDir: base(), options: { approveEachChunk: true } });
  const statePath = path.join(`${stopped.workspaceDir}.conductor`, 'state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  const t = makeTeam();
  const tryState = async (over) => {
    writeFileSync(statePath, JSON.stringify({ ...st, status: 'running', phase: 'chunks', ...over }));
    return resume({ workspaceDir: stopped.workspaceDir, repoDir: repo, team: t, hooks: hooks() });
  };
  for (const over of [{ phase: 'nonsense' }, { chunkIndex: 5 }, { chunkShas: ['0'.repeat(40)], chunkIndex: 1 }, { plan: null }]) {
    const out = await tryState(over);
    assert.equal(out.status, 'failed', JSON.stringify(over));
    assert.match(out.reason, /saved state is not usable/);
  }
  assert.equal(t.local.calls.length + t.author.calls.length + t.reviewer.calls.length, 0);
  writeFileSync(statePath, JSON.stringify({ ...st, status: 'running', phase: 'chunks' }));
  const headFile = path.join(stopped.workspaceDir, '.git', 'HEAD');
  writeFileSync(headFile, 'garbage\n');
  const bad = await resume({ workspaceDir: stopped.workspaceDir, repoDir: repo, team: t, hooks: hooks() });
  assert.equal(bad.status, 'failed');
  const notWs = await resume({ workspaceDir: base(), repoDir: repo, team: t, hooks: hooks() });
  assert.equal(notWs.status, 'failed');
  assert.match(notWs.reason, /not a Conductor workspace/);
});

test('resume from the final phase goes straight back to the gate (T9-M6)', async () => {
  const repo = await makeRepo();
  const first = await runTask({ repoDir: repo, request: 'x', team: makeTeam(), hooks: hooks({ approveResult: async () => { throw new Error('ui died'); } }), baseDir: base(), options: { keepWorkspace: true } });
  assert.equal(first.status, 'rejected');
  // Simulate a crash at the gate: the run was still in its final phase.
  const statePath = path.join(`${first.workspaceDir}.conductor`, 'state.json');
  const st = JSON.parse(readFileSync(statePath, 'utf8'));
  writeFileSync(statePath, JSON.stringify({ ...st, status: 'running', phase: 'final' }));
  const t = makeTeam();
  const h = hooks();
  const again = await resume({ workspaceDir: first.workspaceDir, repoDir: repo, team: t, hooks: h });
  assert.equal(again.status, 'landed');
  assert.equal(t.local.calls.length, 0);
  assert.equal(t.author.calls.length, 0);
  assert.equal(h.calls.filter((c) => c.name === 'approveResult').length, 1);
  assert.deepEqual((await git(repo, ['diff', '--name-only', 'main', again.branch])).stdout.trim().split('\n').sort(), ['step1.txt', 'step2.txt']);
});

test('a baseDir under the temp dir is flagged: basedir-warning event and a summary line (N4)', async () => {
  const events = [];
  const h = hooks({ onEvent: (e) => events.push(e) });
  await runTask({ repoDir: await makeRepo(), request: 'x', team: makeTeam(), hooks: h, baseDir: base() });
  assert.ok(events.some((e) => e.type === 'basedir-warning'));
  assert.match(h.calls.find((c) => c.name === 'approveResult').arg.summary, /Warning: the workspace is under the temporary directory/);
});

test('validateTeam compares vendors, and allowSameVendor lifts the rule', () => {
  const t = makeTeam();
  const apiReviewer = fakeParticipant({ name: 'claude-api', kind: 'anthropic-api', script: approve });
  assert.throws(() => validateTeam({ ...t, reviewer: apiReviewer }), /two-vendor rule/);
  const sameVendor = { ...t, reviewer: fakeParticipant({ name: 'c2', kind: 'claude-code', script: approve }) };
  assert.doesNotThrow(() => validateTeam(sameVendor, { allowSameVendor: true }));
});

import { Seat } from '../src/router.js';
import { makeResult as mkResult } from '../src/result.js';
import { Participant } from '../src/participant.js';

const NOBODY_R = { ok: false, error: 'no AI model is available for codex (codex: rate-limited)', failure: 'no-participant' };

test('a frontier seat with nothing left pauses the run; resume finishes it (Review Focus 2)', async () => {
  const repo = await makeRepo();
  const before = await refsOf(repo);
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam({ reviewer: () => NOBODY_R }), hooks: hooks(), baseDir: base() });
  assert.equal(out.status, 'paused');
  assert.match(out.reason, /^Conductor paused: no AI model is available for codex \(codex: rate-limited\)\. Your repository is unchanged/);
  assert.match(out.reason, /conductor resume/);
  assert.ok(out.workspaceDir, 'a paused run keeps its workspace');
  assert.equal(await refsOf(repo), before);
  const state = JSON.parse(readFileSync(path.join(`${out.workspaceDir}.conductor`, 'state.json'), 'utf8'));
  assert.equal(state.status, 'paused');
  const done = await resume({ workspaceDir: out.workspaceDir, repoDir: repo, team: makeTeam(), hooks: hooks() });
  assert.equal(done.status, 'landed');
});

test('a final review with nothing left pauses at the gate, never lands', async () => {
  const repo = await makeRepo();
  const h = hooks();
  const finalNobody = (role, task) => (/Review the whole branch/.test(task) ? NOBODY_R : approve());
  const out = await runTask({ repoDir: repo, request: 'x', team: makeTeam({ reviewer: finalNobody }), hooks: h, baseDir: base() });
  assert.equal(out.status, 'paused');
  assert.equal(h.calls.filter((c) => c.name === 'approveResult').length, 0);
});

test('run warnings and paid API use reach the final summary', async () => {
  const repo = await makeRepo();
  const h = hooks();
  const t = makeTeam();
  t.reviewer = fakeParticipant({ name: 'gpt-api', kind: 'openai-api', script: () => ({ ...approve(), usage: { costUsd: 0.02 } }) });
  t.author = fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role) => (role === 'reviewer' ? approve() : planReply) });
  const out = await runTask({ repoDir: repo, request: 'x', team: t, hooks: h, baseDir: base(), warnings: ['WARNING-ONE', 'WARNING-ONE'] });
  assert.equal(out.status, 'landed');
  const summary = h.calls.find((c) => c.name === 'approveResult').arg.summary;
  assert.equal(summary.split('WARNING-ONE').length, 2, 'each warning appears once');
  assert.match(summary, /Paid API use this run: \d+ calls?, about \$0\.\d\d\./);
});

test('seats are bound to the transcript: their routing events are logged', async () => {
  const repo = await makeRepo();
  const events = [];
  const dead = new Participant({ name: 'claude', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true }, adapter: { kind: 'claude-code', run: async () => mkResult({ ok: false, error: 'HTTP 401: unauthorized', failure: 'infrastructure' }) } });
  const t = makeTeam();
  // Health is tracked by candidate name, so the backup needs its own name.
  const backup = fakeParticipant({ name: 'claude-2', kind: 'claude-code', script: (role) => (role === 'reviewer' ? approve() : planReply) });
  t.author = new Seat({ name: 'claude', candidates: [dead, backup] });
  const out = await runTask({ repoDir: repo, request: 'x', team: t, hooks: hooks({ onEvent: (e) => events.push(e) }), baseDir: base() });
  assert.equal(out.status, 'landed');
  assert.ok(events.some((e) => e.type === 'route-failover' && e.from === 'claude' && e.reason === 'unauthorized'));
});
