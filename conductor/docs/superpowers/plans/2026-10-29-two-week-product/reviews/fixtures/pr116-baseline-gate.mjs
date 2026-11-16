// PR116 review (Claude, Nov 2026): does the baseline test gate in drive() stop a run before any model work?
//
//   node pr116-baseline-gate.mjs --conductor <conductor dir>
//
// Run against main (8d7a836) and the PR worktree (56c52ce). Synthetic participants; workspace, Git and test command are real.
// Prints one JSON line per scenario. Scenario (e) is skipped on trees without the gate (no baselinePending in state).
import { writeFileSync, readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const { values } = parseArgs({ options: { conductor: { type: 'string' } } });
const dir = path.resolve(values.conductor ?? '.');
const load = (p) => import(pathToFileURL(path.join(dir, p)).href);
const { runTask, resume } = await load('src/conductor.js');
const { git } = await load('src/workspace.js');
const { fakeParticipant, approve } = await load('test/helpers/fakes.js');
const { makeRepo } = await load('test/helpers/gitRepo.js');

const PLAN = { summary: 'S', chunks: [{ title: 'One', instructions: 'make one' }, { title: 'Two', instructions: 'make two' }] };
const planReply = { text: '```json\n' + JSON.stringify(PLAN) + '\n```' };
const stepOf = (task) => Number(/chunk (\d+) of/.exec(task)?.[1] ?? 0);
const makeTeam = () => ({
  author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: (role) => (role === 'reviewer' ? approve() : planReply) }),
  reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: () => approve() }),
  local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'],
    script: (_r, task, _c, opts) => { writeFileSync(path.join(opts.cwd, `step${stepOf(task)}.txt`), 'x\n'); return { text: 'ok' }; } }),
});
const makeHooks = (over = {}) => {
  const called = []; const events = [];
  const rec = (name, ret) => async () => { called.push(name); return ret; };
  return { called, events, onEvent: (e) => events.push(e),
    escalate: rec('escalate', 'reject'), approveResult: rec('approveResult', true), approveChunk: rec('approveChunk', true),
    approvePlan: rec('approvePlan', true), confirmLocalFallback: rec('confirmLocalFallback', true), ...over };
};
const base = () => mkdtempSync(path.join(tmpdir(), 'cond-'));
const branches = async (repo) => (await git(repo, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/conductor'])).stdout.trim().split('\n').filter(Boolean);

function report(scenario, repo, team, h, out, extra = {}) {
  return branches(repo).then((b) => {
    const bt = h.events.find((e) => e.type === 'baseline-tests');
    console.log(JSON.stringify({
      scenario, status: out.status, reasonCode: out.reasonCode ?? null,
      localCalls: team.local.calls.length,
      authorCalls: team.author.calls.filter((c) => c.role !== 'reviewer').length,
      reviewerCalls: team.reviewer.calls.length + team.author.calls.filter((c) => c.role === 'reviewer').length,
      hooksCalled: h.called, baselineEvent: Boolean(bt), baselinePassed: bt ? bt.passed : null,
      conductorBranches: b.length, ...extra,
    }));
  });
}

async function simple(scenario, files, testCommand) {
  const repo = await makeRepo(files);
  const team = makeTeam(); const h = makeHooks();
  const options = testCommand ? { testCommand } : {};
  const out = await runTask({ repoDir: repo, request: 'x', team, hooks: h, baseDir: base(), options });
  await report(scenario, repo, team, h, out);
}

const broken = { 'README.md': 'hi\n', 'broken.cjs': "console.error('PRE-EXISTING FAILURE'); process.exit(1);\n" };
await simple('a-failing-baseline', broken, 'node broken.cjs');
await simple('b-passing-baseline', undefined, 'node --version');
await simple('c-no-testCommand', undefined, undefined);
await simple('d-unlaunchable-command', undefined, 'conductor-no-such-binary-xyz');

// e: resume re-checks the baseline. The committed script reads a marker file at an absolute path outside the repo.
{
  const marker = path.join(mkdtempSync(path.join(tmpdir(), 'marker-')), 'fail');
  const repo = await makeRepo({ 'README.md': 'hi\n', 'check.cjs': `process.exit(require('fs').existsSync(${JSON.stringify(marker)}) ? 1 : 0);\n` });
  const team1 = makeTeam(); const h1 = makeHooks({ approveChunk: async () => false });
  const stopped = await runTask({ repoDir: repo, request: 'x', team: team1, hooks: h1, baseDir: base(), options: { approveEachChunk: true, testCommand: 'node check.cjs' } });
  const statePath = path.join(`${stopped.workspaceDir}.conductor`, 'state.json');
  const reopen = (extra) => {
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    delete st.baselinePending; delete st.reasonCode; delete st.reason;
    writeFileSync(statePath, JSON.stringify({ ...st, status: 'running', phase: 'chunks', ...extra }));
  };
  const first = JSON.parse(readFileSync(statePath, 'utf8'));
  console.log(JSON.stringify({ scenario: 'e0-setup', firstStatus: stopped.status, stateHasBaselinePending: 'baselinePending' in first, chunkShas: first.chunkShas?.length }));
  // e1: marker says FAIL, baselinePending forced true
  writeFileSync(marker, 'x');
  reopen({ baselinePending: true });
  const team2 = makeTeam(); const h2 = makeHooks();
  const out2 = await resume({ workspaceDir: stopped.workspaceDir, repoDir: repo, team: team2, hooks: h2, options: { approveEachChunk: false, keepWorkspace: true } });
  await report('e1-resume-marker-fail', repo, team2, h2, out2);
  // e2: marker says PASS
  rmSync(marker);
  reopen({ baselinePending: true });
  const team3 = makeTeam(); const h3 = makeHooks();
  const out3 = await resume({ workspaceDir: stopped.workspaceDir, repoDir: repo, team: team3, hooks: h3, options: { approveEachChunk: false, keepWorkspace: true } });
  await report('e2-resume-marker-pass', repo, team3, h3, out3);
}
