import { test } from 'node:test';
import assert from 'node:assert/strict';
import { briefAuthorSeat } from '../src/factory/briefTeam.js';
import { API_KEY_BILLING_WARNING } from '../src/team.js';
import { fakeParticipant } from './helpers/fakes.js';

const p = (name, kind, roles = ['author', 'reviewer']) => fakeParticipant({ name, kind, roles, script: () => ({ text: 'x' }) });
const TEAM = () => [p('claude', 'claude-code'), p('codex', 'codex'), p('local', 'local-agent', ['grunt']), p('oops', 'local-agent', ['author']), p('api', 'anthropic-api')];
const healthOf = (down = {}) => { const probed = []; const fn = async (adapter) => { probed.push(adapter.kind); return down[adapter.kind] ? { ok: false, reason: down[adapter.kind] } : { ok: true, reason: '' }; }; fn.probed = probed; return fn; };
const names = (seat) => seat.candidates.map((c) => c.name);

test('the author seat is frontier only: subscriptions, API only when allowed, never local', async () => {
  const health = healthOf();
  const r = await briefAuthorSeat(TEAM(), { health, env: {} });
  assert.equal(r.ok, true);
  assert.equal(r.seat.name, 'claude');
  assert.deepEqual(names(r.seat), ['claude', 'codex']);
  assert.equal(health.probed.includes('local-agent'), false, 'the local model is not even checked');
  assert.deepEqual(names((await briefAuthorSeat(TEAM(), { health: healthOf(), env: {}, routing: { allowApi: true } })).seat), ['claude', 'codex', 'api']);
  assert.equal((await briefAuthorSeat(TEAM(), { health: healthOf(), env: {}, routing: { allowApi: 'true' } })).seat.candidates.some((c) => c.name === 'api'), false, 'only a real true allows paid API');
});

test('preference, fallback and plain failure', async () => {
  assert.equal((await briefAuthorSeat(TEAM(), { health: healthOf(), env: {}, routing: { author: 'codex' } })).seat.name, 'codex');
  assert.equal((await briefAuthorSeat(TEAM(), { health: healthOf({ 'claude-code': 'rate-limit' }), env: {} })).seat.name, 'codex');
  const none = await briefAuthorSeat(TEAM(), { health: healthOf({ 'claude-code': 'rate-limit', codex: 'unauthorized' }), env: {} });
  assert.deepEqual(none, { ok: false, error: 'No AI subscription can write the brief (claude: rate-limited; codex: not signed in, or its key was refused). Sign in to Claude Code or Codex, then run the same command again. Nothing was sent to any AI model.' });
  const warn = await briefAuthorSeat(TEAM(), { health: healthOf(), env: { ANTHROPIC_API_KEY: 'sk-test-0000000000000000' } });
  assert.deepEqual(warn.warnings, [API_KEY_BILLING_WARNING]);
});
