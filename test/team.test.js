import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTeam, SAME_VENDOR_WARNING, LOCAL_DOWN_WARNING, API_KEY_BILLING_WARNING } from '../src/team.js';
import { HealthBoard } from '../src/router.js';
import { validateTeam } from '../src/conductor.js';
import { Participant } from '../src/participant.js';
import { makeResult } from '../src/result.js';

// probe: the health answer this participant gives (default healthy).
function p(name, kind, { roles = ['author', 'reviewer'], edits = true, probe = { ok: true, reason: '' } } = {}) {
  return new Participant({
    name, roles, capabilities: { is_agentic: edits, can_edit_files: edits },
    adapter: { kind, probe: async () => probe, run: async () => makeResult({ text: name }) },
  });
}
const DOWN = { ok: false, reason: 'unauthorized', detail: 'not signed in' };
const claude = (o) => p('claude', 'claude-code', o);
const codex = (o) => p('codex', 'codex', o);
const local = (o) => p('local', 'local-agent', { roles: ['grunt'], ...o });
const claudeApi = (o) => p('claude-api', 'anthropic-api', { edits: false, ...o });
const gptApi = (o) => p('gpt-api', 'openai-api', { edits: false, ...o });
const names = (seat) => seat.candidates.map((c) => c.name);
const NOENV = {};

test('both subscriptions healthy: different vendors, ladder order, no warnings', async () => {
  const r = await buildTeam([claude(), codex(), local(), claudeApi()], { env: NOENV });
  assert.equal(r.ok, true);
  assert.equal(r.team.author.name, 'claude');
  assert.equal(r.team.reviewer.name, 'codex');
  assert.deepEqual(names(r.team.author), ['claude', 'codex']);
  assert.deepEqual(names(r.team.reviewer), ['codex', 'claude']);
  assert.deepEqual(names(r.team.local), ['local']);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.allowSameVendor, false);
  assert.deepEqual(r.report.map((x) => x.name), ['claude', 'codex', 'local'], 'APIs are not probed unless allowApi');
  assert.doesNotThrow(() => validateTeam(r.team));
});

test('routing.author swaps the seats', async () => {
  const r = await buildTeam([claude(), codex(), local()], { routing: { author: 'codex' }, env: NOENV });
  assert.equal(r.team.author.name, 'codex');
  assert.equal(r.team.reviewer.name, 'claude');
});

test('allowApi adds APIs at the end of each ladder, own vendor first', async () => {
  const r = await buildTeam([claude(), codex(), local(), claudeApi(), gptApi()], { routing: { allowApi: true }, env: NOENV });
  assert.deepEqual(names(r.team.author), ['claude', 'codex', 'claude-api', 'gpt-api']);
  assert.deepEqual(names(r.team.reviewer), ['codex', 'claude', 'gpt-api', 'claude-api']);
});

test('one vendor down: same vendor in both seats, flagged (Review Focus 4)', async () => {
  const board = new HealthBoard();
  const r = await buildTeam([claude({ probe: DOWN }), codex(), local()], { env: NOENV, board });
  assert.equal(r.ok, true);
  assert.equal(r.team.author.name, 'codex');
  assert.equal(r.team.reviewer.name, 'codex');
  assert.equal(r.allowSameVendor, true);
  assert.deepEqual(r.warnings, [SAME_VENDOR_WARNING]);
  assert.equal(board.state('claude').status, 'down');
  assert.throws(() => validateTeam(r.team), /two-vendor rule/);
  assert.doesNotThrow(() => validateTeam(r.team, { allowSameVendor: r.allowSameVendor }));
});

test('preferTwoVendors puts an other-vendor API ahead of the same-vendor subscription', async () => {
  const r = await buildTeam([claude({ probe: DOWN }), codex(), local(), claudeApi()], { routing: { allowApi: true, preferTwoVendors: true }, env: NOENV });
  assert.equal(r.team.author.name, 'codex');
  assert.equal(r.team.reviewer.name, 'claude-api');
  assert.deepEqual(names(r.team.reviewer), ['claude-api', 'claude', 'codex']);
  assert.equal(r.allowSameVendor, false);
  assert.deepEqual(r.warnings, []);
  assert.doesNotThrow(() => validateTeam(r.team));
});

test('local down: frontier covers with a warning, or pause when configured', async () => {
  const down = { ok: false, reason: 'unavailable', detail: 'could not reach the local model server (ECONNREFUSED)' };
  const r = await buildTeam([claude(), codex(), local({ probe: down })], { env: NOENV });
  assert.equal(r.ok, true);
  assert.deepEqual(r.warnings, [LOCAL_DOWN_WARNING]);
  const p2 = await buildTeam([claude(), codex(), local({ probe: down })], { routing: { localDown: 'pause' }, env: NOENV });
  assert.equal(p2.ok, false);
  assert.match(p2.error, /local model local is not available \(could not reach the local model server/);
});

test('nothing healthy: a plain error and the full report', async () => {
  const r = await buildTeam([claude({ probe: DOWN }), codex({ probe: { ok: false, reason: 'version-skew' } }), local()], { env: NOENV });
  assert.equal(r.ok, false);
  assert.match(r.error, /No AI subscription is available: claude: not signed in, or its key was refused; codex: its program is out of date\./);
  assert.deepEqual(r.report.map((x) => [x.name, x.ok, x.reason]), [['claude', false, 'unauthorized'], ['codex', false, 'version-skew'], ['local', true, '']]);
});

test('config problems are plain errors', async () => {
  assert.match((await buildTeam([claude(), codex()], { env: NOENV })).error, /no local model/);
  assert.match((await buildTeam([claude(), codex(), local()], { routing: { author: 'gemini' }, env: NOENV })).error, /routing\.author names "gemini"/);
});

test('ANTHROPIC_API_KEY next to a Claude subscription is flagged', async () => {
  const r = await buildTeam([claude(), codex(), local()], { env: { ANTHROPIC_API_KEY: 'x' } });
  assert.deepEqual(r.warnings, [API_KEY_BILLING_WARNING]);
});

test('a probe that throws counts as unavailable', async () => {
  const boom = new Participant({ name: 'codex', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true }, adapter: { kind: 'codex', probe: async () => { throw new Error('kaput'); }, run: async () => makeResult({}) } });
  const r = await buildTeam([claude(), boom, local()], { env: NOENV });
  assert.equal(r.report[1].ok, false);
  assert.equal(r.report[1].reason, 'unavailable');
  assert.equal(r.allowSameVendor, true);
});

test('without preferTwoVendors a healthy other-vendor API is only a fallback: same-vendor subscription reviews', async () => {
  const r = await buildTeam([claude({ probe: DOWN }), codex(), local(), claudeApi()], { routing: { allowApi: true }, env: NOENV });
  assert.equal(r.team.author.name, 'codex');
  assert.equal(r.team.reviewer.name, 'codex');
  assert.equal(r.allowSameVendor, true);
  assert.ok(r.warnings.includes(SAME_VENDOR_WARNING));
  assert.deepEqual(names(r.team.reviewer), ['codex', 'claude', 'claude-api']);
});

test('probe text is redacted in the report and the error', async () => {
  const SECRET = 'sk-test-abcdefghijklmnop1234';
  const env = { ANTHROPIC_API_KEY: SECRET };
  const leaky = (n, k, roles) => p(n, k, { roles, probe: { ok: false, reason: 'unavailable', detail: `proxy echoed ${SECRET}` } });
  const boom = new Participant({ name: 'codex', roles: ['author', 'reviewer'], capabilities: { can_edit_files: true }, adapter: { kind: 'codex', probe: async () => { throw new Error(`bad ${SECRET}`); }, run: async () => makeResult({}) } });
  const r = await buildTeam([leaky('claude', 'claude-code', ['author', 'reviewer']), boom, local()], { env });
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes(SECRET));
  const l = await buildTeam([claude(), codex(), leaky('local', 'local-agent', ['grunt'])], { env, routing: { localDown: 'pause' } });
  assert.equal(l.ok, false);
  assert.ok(!JSON.stringify(l).includes(SECRET));
  assert.match(l.error, /\[redacted\]/);
});

test('allowApi / preferTwoVendors turn on only for exactly true (I4)', async () => {
  for (const v of ['false', 'true', 1, 'yes']) {
    const r = await buildTeam([claude({ probe: DOWN }), codex(), local(), claudeApi()], { routing: { allowApi: v, preferTwoVendors: v }, env: NOENV });
    assert.ok(!r.report.some((x) => x.name === 'claude-api'), `allowApi ${JSON.stringify(v)} must not probe a paid API`);
    assert.ok(!r.team.author.candidates.concat(r.team.reviewer.candidates).some((c) => c.name === 'claude-api'), `allowApi ${JSON.stringify(v)} must not seat a paid API`);
  }
  const twoOnly = await buildTeam([claude({ probe: DOWN }), codex(), local(), claudeApi()], { routing: { allowApi: true, preferTwoVendors: 'false' }, env: NOENV });
  assert.equal(twoOnly.team.reviewer.name, 'codex', 'preferTwoVendors "false" must not put the API first');
});
