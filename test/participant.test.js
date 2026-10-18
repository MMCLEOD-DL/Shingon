// test/participant.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Participant } from '../src/participant.js';
import { makeResult } from '../src/result.js';

const fakeAdapter = { kind: 'fake', async run(role) { return makeResult({ text: `ran ${role}` }); } };

test('runs an eligible role through the adapter', async () => {
  const p = new Participant({ name: 'claude', adapter: fakeAdapter, roles: ['author', 'reviewer'] });
  assert.equal(p.canPlay('reviewer'), true);
  const r = await p.run('reviewer', 'task');
  assert.equal(r.text, 'ran reviewer');
});

test('rejects an ineligible role naming participant and role', async () => {
  const p = new Participant({ name: 'local', adapter: fakeAdapter, roles: ['grunt'] });
  assert.equal(p.canPlay('author'), false);
  await assert.rejects(() => p.run('author', 't'), /local.*author|author.*local/);
});

test('capabilities default to false and merge', () => {
  const p = new Participant({ name: 'x', adapter: fakeAdapter, roles: ['grunt'], capabilities: { is_agentic: true } });
  assert.equal(p.capabilities.is_agentic, true);
  assert.equal(p.capabilities.can_edit_files, false);
});

test('run rejects when the adapter returns a non-Result', async () => {
  const badAdapter = { kind: 'bad', async run() { return { text: 'not a result' }; } };
  const p = new Participant({ name: 'x', adapter: badAdapter, roles: ['author'] });
  await assert.rejects(() => p.run('author', 't'), /Result/);
});

test('constructor validates name, adapter, and roles', () => {
  assert.throws(() => new Participant({ adapter: fakeAdapter, roles: ['author'] }), /name/);
  assert.throws(() => new Participant({ name: 'x', adapter: {}, roles: ['author'] }), /adapter/);
  assert.throws(() => new Participant({ name: 'x', adapter: fakeAdapter, roles: [] }), /role/);
});

test('forwards opts to the adapter', async () => {
  let seen = null;
  const adapter = { kind: 'fake', run: async (role, task, context, opts) => { seen = opts; return makeResult({ text: 'x' }); } };
  const p = new Participant({ name: 'p', adapter, roles: ['grunt'] });
  await p.run('grunt', 't', 'c', { cwd: '/w', write: true });
  assert.deepEqual(seen, { cwd: '/w', write: true });
});
