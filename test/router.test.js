import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HealthBoard, Seat, REASON_TEXT } from '../src/router.js';
import { Participant } from '../src/participant.js';
import { makeResult } from '../src/result.js';

// A candidate whose behaviour is a list of replies, consumed one per call (last one repeats).
function cand(name, kind, replies, { edits = true, roles = ['author', 'reviewer'] } = {}) {
  const calls = [];
  const p = new Participant({
    name, roles, capabilities: { is_agentic: edits, can_edit_files: edits },
    adapter: { kind, run: async (role, task, context, opts) => { calls.push({ role, opts }); return makeResult(replies[Math.min(calls.length - 1, replies.length - 1)]); } },
  });
  p.calls = calls;
  return p;
}
const OK = { text: 'done', ok: true };
const E401 = { ok: false, error: 'HTTP 401: unauthorized', failure: 'infrastructure' };
const E429 = { ok: false, error: 'API Error: 429 rate limit reached', failure: 'infrastructure' };
const BAD = { ok: false, error: 'the model wrote nonsense', failure: null };

function clock() {
  let t = 1000;
  const slept = [];
  return { now: () => t, slept, sleep: async (ms) => { slept.push(ms); t += ms; }, advance: (ms) => { t += ms; } };
}
const events = () => { const list = []; return { list, emit: (type, data) => list.push({ type, ...data }) }; };

test('the preferred candidate serves when healthy', async () => {
  const a = cand('claude', 'claude-code', [OK]);
  const b = cand('codex', 'codex', [OK]);
  const seat = new Seat({ name: 'author', candidates: [a, b] });
  const r = await seat.run('author', 't');
  assert.equal(r.ok, true);
  assert.equal(r.servedBy, 'claude');
  assert.equal(r.servedKind, 'claude-code');
  assert.equal(b.calls.length, 0);
});

test('an infrastructure failure marks the candidate down for the rest of the run', async () => {
  const ev = events();
  const a = cand('claude', 'claude-code', [E401]);
  const b = cand('codex', 'codex', [OK]);
  const board = new HealthBoard();
  const seat = new Seat({ name: 'author', candidates: [a, b], board });
  seat.bind(ev.emit);
  assert.equal((await seat.run('author', 't')).servedBy, 'codex');
  assert.equal((await seat.run('author', 't')).servedBy, 'codex');
  assert.equal(a.calls.length, 1, 'a down candidate is not called again');
  assert.equal(board.state('claude').status, 'down');
  assert.deepEqual(ev.list[0], { type: 'route-failover', seat: 'author', from: 'claude', reason: 'unauthorized', error: E401.error });
});

test('a rate limit cools the candidate; it is tried again once the cooldown passes', async () => {
  const c = clock();
  const a = cand('claude', 'claude-code', [E429, OK]);
  const b = cand('codex', 'codex', [OK]);
  const board = new HealthBoard({ now: c.now });
  const seat = new Seat({ name: 'author', candidates: [a, b], board, cooldownMs: 60000, sleep: c.sleep });
  assert.equal((await seat.run('author', 't')).servedBy, 'codex');
  assert.equal(board.state('claude').status, 'cooling');
  c.advance(60000);
  assert.equal(board.state('claude').status, 'ok');
  assert.equal((await seat.run('author', 't')).servedBy, 'claude');
});

test('a non-infrastructure failure is returned as-is, without failover', async () => {
  const a = cand('claude', 'claude-code', [BAD]);
  const b = cand('codex', 'codex', [OK]);
  const r = await new Seat({ name: 'author', candidates: [a, b] }).run('author', 't');
  assert.equal(r.ok, false);
  assert.equal(r.error, BAD.error);
  assert.equal(r.servedBy, 'claude');
  assert.equal(b.calls.length, 0);
});

test('write calls skip text-only candidates; api-in-use is announced once, before the call', async () => {
  const ev = events();
  const a = cand('claude', 'claude-code', [E401]);
  const api = cand('claude-api', 'anthropic-api', [OK], { edits: false });
  const seat = new Seat({ name: 'reviewer', candidates: [a, api] });
  seat.bind(ev.emit);
  const w = await seat.run('author', 't', '', { write: true });
  assert.equal(w.failure, 'no-participant');
  assert.match(w.error, /^no AI model is available for reviewer \(/);
  assert.equal(api.calls.length, 0);
  const r1 = await seat.run('reviewer', 't');
  const r2 = await seat.run('reviewer', 't');
  assert.equal(r1.servedBy, 'claude-api');
  assert.equal(r2.servedBy, 'claude-api');
  assert.equal(ev.list.filter((e) => e.type === 'api-in-use').length, 1);
});

test('everything rate-limited: wait once for the shortest cooldown, then give up (Review Focus 2)', async () => {
  const c = clock();
  const ev = events();
  const a = cand('claude', 'claude-code', [E429]);
  const b = cand('codex', 'codex', [E429]);
  const seat = new Seat({ name: 'author', candidates: [a, b], board: new HealthBoard({ now: c.now }), cooldownMs: 30000, maxWaitMs: 60000, sleep: c.sleep });
  seat.bind(ev.emit);
  const r = await seat.run('author', 't');
  assert.equal(r.ok, false);
  assert.equal(r.failure, 'no-participant');
  assert.match(r.error, /claude: rate-limited; codex: rate-limited/);
  assert.deepEqual(c.slept, [30000]);
  assert.equal(a.calls.length, 2);
  assert.equal(b.calls.length, 2);
  assert.equal(ev.list.filter((e) => e.type === 'route-wait').length, 1);
});

test('a cooldown longer than maxWaitMs is not waited for', async () => {
  const c = clock();
  const a = cand('claude', 'claude-code', [E429]);
  const seat = new Seat({ name: 'author', candidates: [a], board: new HealthBoard({ now: c.now }), cooldownMs: 600000, maxWaitMs: 60000, sleep: c.sleep });
  const r = await seat.run('author', 't');
  assert.equal(r.failure, 'no-participant');
  assert.deepEqual(c.slept, []);
});

test('the board is shared: a candidate found dead in one seat is skipped by the other', async () => {
  const board = new HealthBoard();
  const claude = cand('claude', 'claude-code', [E401]);
  const codex = cand('codex', 'codex', [OK]);
  const author = new Seat({ name: 'author', candidates: [claude, codex], board });
  const reviewer = new Seat({ name: 'reviewer', candidates: [codex, claude], board });
  await author.run('author', 't');
  const codexCalls = codex.calls.length;
  const r = await reviewer.run('reviewer', 't');
  assert.equal(r.servedBy, 'codex');
  assert.equal(claude.calls.length, 1);
  assert.equal(codex.calls.length, codexCalls + 1);
});

test('a candidate that throws becomes a plain failed result', async () => {
  const boom = new Participant({ name: 'boom', roles: ['author'], adapter: { kind: 'codex', run: async () => { throw new Error('kaput'); } } });
  const r = await new Seat({ name: 'author', candidates: [boom] }).run('author', 't');
  assert.equal(r.ok, false);
  assert.match(r.error, /kaput/);
  assert.equal(r.failure, null);
});

test('a Seat looks like a Participant', () => {
  const a = cand('claude', 'claude-code', [OK]);
  const api = cand('openai-api', 'openai-api', [OK], { edits: false, roles: ['reviewer'] });
  const seat = new Seat({ name: 'author', candidates: [a, api] });
  assert.equal(seat.name, 'author');
  assert.equal(seat.adapter.kind, 'claude-code');
  assert.deepEqual(seat.roles.sort(), ['author', 'reviewer']);
  assert.equal(seat.canPlay('reviewer'), true);
  assert.equal(seat.canPlay('grunt'), false);
  assert.deepEqual(seat.capabilities, { is_agentic: true, can_edit_files: true });
  assert.throws(() => new Seat({ name: 'x', candidates: [] }), /at least one candidate/);
});

test('REASON_TEXT gives plain words for every reason', () => {
  for (const k of ['unauthorized', 'version-skew', 'rate-limit', 'unavailable', 'model-missing']) assert.equal(typeof REASON_TEXT[k], 'string');
});
