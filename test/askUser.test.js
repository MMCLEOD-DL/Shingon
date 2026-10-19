import { test } from 'node:test';
import assert from 'node:assert/strict';
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
