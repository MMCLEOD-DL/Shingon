// test/keyleak.test.js — C1 regression: a key printed by the test command and quoted by
// the reviewer never reaches a prompt, the transcript, state.json, a hook or the outcome.
// Fake keys only; never a real credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runTask } from '../src/conductor.js';
import { fakeParticipant, approve, block } from './helpers/fakes.js';
import { makeRepo } from './helpers/gitRepo.js';
import { REDACTED } from '../src/secrets.js';

const KEY = 'sk-test-0123456789';
const LOCAL_KEY = 'sk-test-local-0123456789';
process.env.X_API_KEY = KEY;
process.env.LOCALAI_API_KEY = LOCAL_KEY;

const PLAN = { summary: 'S', chunks: [{ title: 'One', instructions: 'make one' }] };
const planReply = { text: '```json\n' + JSON.stringify(PLAN) + '\n```' };

test('a key leaking through test output is redacted from prompts, transcript, state, hooks and outcome', async () => {
  const events = [];
  const hookCalls = [];
  let wsDir = null;
  const team = {
    author: fakeParticipant({
      name: 'claude', kind: 'claude-code',
      script: (role, task, c, opts) => {
        if (role === 'reviewer') return approve();
        if (!/chunk \d+ of/.test(task)) return planReply;
        writeFileSync(path.join(opts.cwd, 'one.txt'), `token=${KEY}\n`); // the fallback also writes the key into the change
        return { text: 'ok' };
      },
    }),
    // The reviewer quotes the key (as if it had read it from the env or the test log).
    reviewer: fakeParticipant({
      name: 'codex', kind: 'codex',
      script: (role) => ({ text: `I saw ${KEY} and ${LOCAL_KEY} in the log.`, ...block(`the tests print the key ${KEY}`) }),
    }),
    local: fakeParticipant({
      name: 'local', kind: 'local-agent', roles: ['grunt'],
      script: (role, task, c, opts) => { writeFileSync(path.join(opts.cwd, 'one.txt'), `token=${KEY}\n`); return { text: `ran env: X_API_KEY=${KEY}` }; },
    }),
  };
  const hooks = {
    onEvent: (e) => { events.push(e); if (e.type === 'start') wsDir = e.workspace; },
    escalate: async (esc) => { hookCalls.push({ name: 'escalate', arg: esc }); return 'approve'; },
    approveResult: async (arg) => { hookCalls.push({ name: 'approveResult', arg }); return true; },
  };
  const out = await runTask({
    repoDir: await makeRepo(), request: 'x', team, hooks,
    baseDir: mkdtempSync(path.join(tmpdir(), 'leak-')),
    options: { localRounds: 1, frontierRounds: 1, testCommand: 'cat one.txt; echo "env=[$X_API_KEY] local=[$LOCALAI_API_KEY]"; exit 1', keepWorkspace: true },
  });
  assert.equal(out.status, 'landed');

  // The leak path was really exercised: the reviewer saw the (redacted) test output.
  const reviewPrompt = team.reviewer.calls.find((c) => /Review chunk 1/.test(c.task)).task;
  assert.ok(reviewPrompt.includes(`token=${REDACTED}`), 'test output reached the reviewer, redacted');
  assert.ok(reviewPrompt.includes('env=[]'), 'secret-named vars are dropped from the test env (N2)');
  assert.ok(reviewPrompt.includes('local=[]'), 'LOCALAI_API_KEY was scrubbed from the test env');
  assert.ok(hookCalls.find((h) => h.name === 'escalate').arg.message.includes(REDACTED));
  // N2: the gate warns that the change itself contains something credential-like.
  assert.match(hookCalls.find((h) => h.name === 'approveResult').arg.summary, /Warning: this change contains something that looks like a credential/);

  const leaks = (label, x) => {
    const s = typeof x === 'string' ? x : JSON.stringify(x);
    assert.ok(!s.includes(KEY), `${label} contains the key`);
    assert.ok(!s.includes(LOCAL_KEY), `${label} contains the local key`);
  };
  leaks('outcome', out);
  leaks('events', events);
  leaks('hook payloads', hookCalls);
  for (const p of [team.author, team.reviewer, team.local]) {
    for (const c of p.calls) { leaks(`${p.name} task`, c.task); leaks(`${p.name} context`, c.context); }
  }
  const meta = `${wsDir}.conductor`;
  leaks('transcript', readFileSync(path.join(meta, 'transcript.jsonl'), 'utf8'));
  leaks('state.json', readFileSync(path.join(meta, 'state.json'), 'utf8'));
});
