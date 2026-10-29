// test/fakes.test.js — the shared test ctx must look like the one runTask builds (T6, m7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, fakeParticipant } from './helpers/fakes.js';
import { DEFAULT_OPTIONS } from '../src/options.js';

test('makeCtx builds the runTask ctx shape', async () => {
  const ctx = await makeCtx({ request: 'Add CSV export', options: { localRounds: 1 } });
  for (const k of ['request', 'team', 'hooks', 'options', 'ws', 'log', 'state']) assert.ok(k in ctx, k);
  assert.equal(ctx.state.taskId, ctx.ws.branch);
  assert.equal(ctx.state.taskId, 'conductor/add-csv-export');
  assert.equal(ctx.state.version, 1);
  assert.equal(ctx.log.dir, ctx.ws.metaDir);
  assert.equal(ctx.options.localRounds, 1);
  assert.equal(ctx.options.frontierRounds, DEFAULT_OPTIONS.frontierRounds);
});

test('makeCtx hooks default to reject/true/true and are overridable', async () => {
  const ctx = await makeCtx({ hooks: { escalate: async () => 'approve' } });
  assert.equal(await ctx.hooks.escalate({}), 'approve');
  assert.equal(await ctx.hooks.approveResult({}), true);
  assert.equal(await ctx.hooks.approveChunk({}), true);
  const d = await makeCtx();
  assert.equal(await d.hooks.escalate({}), 'reject');
  assert.deepEqual(d.hookCalls.map((h) => h.name), ['escalate']);
});

test('fakeParticipant records calls and wraps replies in Results', async () => {
  const p = fakeParticipant({ name: 'p', script: () => ({ text: 'hi' }) });
  const r = await p.run('author', 'task', 'ctx', { cwd: '/x' });
  assert.equal(r.text, 'hi');
  assert.deepEqual(p.calls, [{ role: 'author', task: 'task', context: 'ctx', opts: { cwd: '/x' } }]);
});
