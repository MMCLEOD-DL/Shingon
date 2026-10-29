import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { askUser } from '../src/askUser.js';
import { makeCtx } from './helpers/fakes.js';

const esc = { kind: 'plan', title: 'the plan', reason: 'IRREVERSIBLE: x', recommendation: 'Reject.' };

test('passes a plain-English escalation to the hook and returns approve', async () => {
  let got = null;
  const ctx = await makeCtx({ hooks: { escalate: async (e) => { got = e; return 'approve'; } } });
  assert.equal(await askUser(ctx, esc), 'approve');
  assert.match(got.message, /the plan/);
  assert.deepEqual(got.options, ['approve', 'reject']);
});

test('anything but "approve" is a reject, including a throwing hook', async () => {
  for (const hook of [async () => 'yes', async () => undefined, async () => { throw new Error('ui gone'); }]) {
    const ctx = await makeCtx({ hooks: { escalate: hook } });
    assert.equal(await askUser(ctx, esc), 'reject');
  }
});

test('true, "Approve", a rejected promise, a sync throw and a missing hook all reject', async () => {
  const hooks = [
    async () => true,
    async () => 'Approve',
    async () => ' approve',
    () => Promise.reject(new Error('closed')),
    () => { throw new Error('sync'); },
    undefined,
  ];
  for (const escalate of hooks) {
    const ctx = await makeCtx();
    ctx.hooks.escalate = escalate;
    assert.equal(await askUser(ctx, esc), 'reject');
  }
});

const eventsOf = (ctx) => readFileSync(ctx.log.transcript, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('logs escalation and decision events; the hook sees no IRREVERSIBLE marker', async () => {
  let got = null;
  const seen = [];
  const ctx = await makeCtx({ hooks: { escalate: async (e) => { got = e; return 'approve'; }, onEvent: (e) => seen.push(e.type) } });
  await askUser(ctx, { ...esc, reason: 'Concern: IRREVERSIBLE: drops table' });
  assert.doesNotMatch(got.message, /IRREVERSIBLE/i);
  const ev = eventsOf(ctx);
  const escEv = ev.find((e) => e.type === 'escalation');
  assert.equal(escEv.kind, 'plan');
  assert.doesNotMatch(escEv.message, /IRREVERSIBLE/i);
  assert.equal(ev.find((e) => e.type === 'decision').decision, 'approve');
  assert.ok(!ev.some((e) => e.type === 'hook-error'));
  assert.deepEqual(seen, ['escalation', 'decision']);
});

test('a throwing hook logs hook-error and a reject decision', async () => {
  const ctx = await makeCtx({ hooks: { escalate: async () => { throw new Error('ui gone'); } } });
  assert.equal(await askUser(ctx, esc), 'reject');
  const ev = eventsOf(ctx);
  assert.deepEqual(ev.map((e) => e.type), ['escalation', 'hook-error', 'decision']);
  assert.equal(ev[1].hook, 'escalate');
  assert.match(ev[1].error, /ui gone/);
  assert.equal(ev[2].decision, 'reject');
});

test('the escalation carries the transcript path for "see details"', async () => {
  let got = null;
  const ctx = await makeCtx({ hooks: { escalate: async (e) => { got = e; return 'reject'; } } });
  await askUser(ctx, esc);
  assert.equal(got.transcript, ctx.log.transcript);
});
