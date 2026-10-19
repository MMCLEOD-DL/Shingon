import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanPhase } from '../src/planPhase.js';
import { fakeParticipant, approve, block, makeCtx } from './helpers/fakes.js';

const PLAN = { summary: 'S', chunks: [{ title: 'A', instructions: 'do a' }] };
const planReply = () => ({ text: 'Plan:\n```json\n' + JSON.stringify(PLAN) + '\n```' });

function team({ author, reviewer }) {
  return {
    author: fakeParticipant({ name: 'claude', kind: 'claude-code', script: author }),
    reviewer: fakeParticipant({ name: 'codex', kind: 'codex', script: reviewer }),
    local: fakeParticipant({ name: 'local', kind: 'local-agent', roles: ['grunt'], script: () => ({}) }),
  };
}

test('clean approval returns the plan with no note; agents run read-only in the workspace', async () => {
  const t = team({ author: planReply, reviewer: approve });
  const ctx = await makeCtx({ team: t });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plan, PLAN);
  assert.equal(r.note, null);
  assert.equal(t.author.calls[0].opts.cwd, ctx.ws.dir);
  assert.equal(t.author.calls[0].opts.write, false);
  assert.equal(t.reviewer.calls[0].role, 'reviewer');
});

test('an unparsable plan is fed back to the author and not sent for review', async () => {
  const t = team({
    author: (role, task, c, o, n) => (n === 0 ? { text: 'no json here' } : planReply()),
    reviewer: approve,
  });
  const r = await runPlanPhase(await makeCtx({ team: t }));
  assert.equal(r.status, 'ok');
  assert.equal(t.reviewer.calls.length, 1);
  assert.match(t.author.calls[1].task, /blocked your previous plan[\s\S]*no ```json plan block/);
});

test('a reversible deadlock is accepted with a note', async () => {
  const t = team({ author: planReply, reviewer: () => block('I would name it differently') });
  const ctx = await makeCtx({ team: t, options: { planRounds: 2 } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'ok');
  assert.match(r.note, /name it differently/);
  assert.equal(ctx.hookCalls.filter((h) => h.name === 'escalate').length, 0);
});

test('an irreversible deadlock escalates; reject stops the run', async () => {
  const t = team({ author: planReply, reviewer: () => block('IRREVERSIBLE: deletes the user table') });
  const ctx = await makeCtx({ team: t, options: { planRounds: 2 } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'stopped');
  const esc = ctx.hookCalls.find((h) => h.name === 'escalate');
  assert.match(esc.arg.message, /deletes the user table/);
});

test('an irreversible deadlock the user approves continues with a note', async () => {
  const t = team({ author: planReply, reviewer: () => block('IRREVERSIBLE: deletes the user table') });
  const ctx = await makeCtx({ team: t, options: { planRounds: 1 }, hooks: { escalate: async () => 'approve' } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'ok');
  assert.match(r.note, /approved/i);
});

test('an author that never produces a valid plan fails without asking the user', async () => {
  const t = team({ author: () => ({ ok: false, error: 'rate limited' }), reviewer: approve });
  const ctx = await makeCtx({ team: t, options: { planRounds: 2 } });
  const r = await runPlanPhase(ctx);
  assert.equal(r.status, 'failed');
  assert.match(r.reason, /rate limited/);
  assert.equal(ctx.hookCalls.length, 0);
});

test('a valid plan followed by a broken retry settles on the valid plan', async () => {
  const t = team({
    author: (role, task, c, o, n) => (n === 0 ? planReply() : { text: 'oops' }),
    reviewer: () => block('minor ordering preference'),
  });
  const r = await runPlanPhase(await makeCtx({ team: t, options: { planRounds: 2 } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plan, PLAN);
  assert.match(r.note, /minor ordering preference/);
});

test('bad JSON, zero chunks and too many chunks are each fed back as a round, never a crash', async () => {
  const fence = (s) => ({ text: '```json\n' + s + '\n```' });
  const bad = [
    fence('{"summary": "S", "chunks": [ oops'),
    fence(JSON.stringify({ summary: 'S', chunks: [] })),
    fence(JSON.stringify({ summary: 'S', chunks: [1, 2, 3].map((i) => ({ title: `t${i}`, instructions: 'x' })) })),
  ];
  const t = team({ author: (role, task, c, o, n) => (n < bad.length ? bad[n] : planReply()), reviewer: approve });
  const r = await runPlanPhase(await makeCtx({ team: t, options: { planRounds: 4, maxChunks: 2 } }));
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.plan, PLAN);
  assert.equal(t.reviewer.calls.length, 1);
  assert.match(t.author.calls[1].task, /not valid JSON/);
  assert.match(t.author.calls[2].task, /no chunks/);
  assert.match(t.author.calls[3].task, /3 chunks \(max 2\)/);
});
