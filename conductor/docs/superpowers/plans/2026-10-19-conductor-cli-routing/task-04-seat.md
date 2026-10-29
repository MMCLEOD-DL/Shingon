# Task 4: Seat & fallback ladder

This task implements the spec §7 fallback ladder as a `Seat`: an ordered list of candidate participants that looks like one participant to the rest of Conductor.

- **Infrastructure failure** (expired sign-in, version skew, backend down): the Seat marks that candidate **down** for the rest of the run and moves on.
- **Rate limit:** the candidate is **cooling** for `cooldownMs`, and the Seat moves on.
- **Nothing left:** if a cooldown ends within `maxWaitMs`, the Seat waits for it once, then tries again. Otherwise it returns a `no-participant` failure, which Task 6 turns into a resumable `paused` run.

One `HealthBoard` is shared by all Seats. A participant found dead while serving as author is therefore skipped when it comes up as reviewer too.

**Files:**
- Create: `src/router.js`, `test/router.test.js`

**Interfaces:**
- Consumes:
  - `makeResult` (it carries `failure`);
  - `classifyFailure(text)` → `'unauthorized' | 'version-skew' | 'rate-limit' | 'unavailable'` (`src/health.js`);
  - `isApiKind` (Task 2);
  - `Participant` (`canPlay`, `roles`, `capabilities`, `adapter.kind`, `run`).
- Produces (see index):
  - `HealthBoard`, `Seat`, and `REASON_TEXT` (exported): a map from the classifyFailure reasons and probe reasons to plain words.
  - A Seat is accepted anywhere a Participant is (it is duck-typed: `name`, `roles`, `capabilities`, `adapter.kind`, `canPlay`, `run`). `adapter.kind` is the **first** candidate's kind, so the two-vendor check sees the preferred participant.
  - Every result a Seat returns from a candidate carries `servedBy` (candidate name) and `servedKind` (candidate adapter kind).
  - Candidate eligibility: `c.canPlay(role) && (!opts.write || c.capabilities.can_edit_files) && board.state(c.name).status === 'ok'`.
  - A non-infrastructure failure (a timeout, a context overflow, or a bad answer with `failure: null`) is returned as-is. Retrying it is the review loop's job, not the Seat's.
  - **Events** (through `bind(emit)`; the default emit does nothing):
    - `api-in-use` `{ seat, participant }`, emitted once per API candidate per Seat, **before** its first call, because that call may cost money;
    - `route-failover` `{ seat, from, reason, error }`;
    - `route-wait` `{ seat, ms }`.
  - **Nothing left:** `makeResult({ ok:false, failure:'no-participant', error })`, where `error` reads `no AI model is available for <seat> (<name>: <plain reason>; …)`. With no eligible candidate at all, the parenthesis reads `(none of its models can edit files)` for write calls, or `(none of its models can act as <role>)`.

- [ ] **Step 1: Write the failing tests**

Create `test/router.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, because `src/router.js` does not exist.

- [ ] **Step 3: Implement**

Create `src/router.js`:

```js
// src/router.js
// Spec §7 fallback ladder. A Seat is one team slot (author / reviewer / local) backed by an
// ordered list of candidates; it looks like a single Participant to the rest of Conductor.
import { makeResult } from './result.js';
import { classifyFailure } from './health.js';
import { isApiKind } from './vendors.js';

// Plain words for why a model is out (classifyFailure + health-probe reasons).
export const REASON_TEXT = Object.freeze({
  'rate-limit': 'rate-limited',
  unauthorized: 'not signed in, or its key was refused',
  'version-skew': 'its program is out of date',
  unavailable: 'not reachable',
  'model-missing': 'the model is not installed',
});
const plain = (reason) => REASON_TEXT[reason] ?? reason ?? 'not available';

// Shared by every Seat of a run: who is down (for the run) or cooling (until a time).
export class HealthBoard {
  #states = new Map();

  constructor({ now = Date.now } = {}) {
    this.now = now;
  }

  markDown(name, reason) {
    this.#states.set(name, { status: 'down', reason, until: null });
  }

  cool(name, reason, ms) {
    this.#states.set(name, { status: 'cooling', reason, until: this.now() + ms });
  }

  state(name) {
    const s = this.#states.get(name);
    if (!s) return { status: 'ok', reason: '', until: null };
    if (s.status === 'cooling' && s.until <= this.now()) {
      this.#states.delete(name);
      return { status: 'ok', reason: '', until: null };
    }
    return { ...s };
  }
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Seat {
  constructor({ name, candidates, board = new HealthBoard(), cooldownMs = 60000, maxWaitMs = 300000, sleep = sleepMs }) {
    if (!name) throw new Error('Seat requires a name');
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error(`Seat ${name} needs at least one candidate`);
    this.name = name;
    this.candidates = candidates;
    this.board = board;
    this.cooldownMs = cooldownMs;
    this.maxWaitMs = maxWaitMs;
    this.sleep = sleep;
    this.roles = [...new Set(candidates.flatMap((c) => c.roles))];
    this.capabilities = {
      is_agentic: candidates.some((c) => c.capabilities.is_agentic),
      can_edit_files: candidates.some((c) => c.capabilities.can_edit_files),
    };
    // The preferred candidate's kind: validateTeam's two-vendor check reads it.
    this.adapter = { kind: candidates[0].adapter.kind };
    this.emit = () => {};
    this.announced = new Set();
  }

  bind(emit) {
    this.emit = typeof emit === 'function' ? emit : () => {};
  }

  canPlay(role) {
    return this.candidates.some((c) => c.canPlay(role));
  }

  #eligible(c, role, opts) {
    return c.canPlay(role) && (!opts.write || c.capabilities.can_edit_files);
  }

  async run(role, task, context = '', opts = {}) {
    let waited = false;
    for (;;) {
      for (const c of this.candidates) {
        if (!this.#eligible(c, role, opts) || this.board.state(c.name).status !== 'ok') continue;
        if (isApiKind(c.adapter.kind) && !this.announced.has(c.name)) {
          this.announced.add(c.name); // before the call: it may cost money
          this.emit('api-in-use', { seat: this.name, participant: c.name });
        }
        let r;
        try {
          r = await c.run(role, task, context, opts);
        } catch (e) {
          r = makeResult({ ok: false, error: String(e?.message ?? e) });
        }
        r.servedBy = c.name;
        r.servedKind = c.adapter.kind;
        if (r.ok || r.failure !== 'infrastructure') return r;
        const reason = classifyFailure(r.error ?? '');
        if (reason === 'rate-limit') this.board.cool(c.name, reason, this.cooldownMs);
        else this.board.markDown(c.name, reason);
        this.emit('route-failover', { seat: this.name, from: c.name, reason, error: r.error });
      }
      const eligible = this.candidates.filter((c) => this.#eligible(c, role, opts));
      const waits = eligible.map((c) => this.board.state(c.name)).filter((s) => s.status === 'cooling').map((s) => s.until - this.board.now());
      const ms = waits.length ? Math.max(0, Math.min(...waits)) : null;
      if (!waited && ms !== null && ms <= this.maxWaitMs) {
        waited = true;
        this.emit('route-wait', { seat: this.name, ms });
        await this.sleep(ms);
        continue;
      }
      return makeResult({ ok: false, failure: 'no-participant', error: this.#nothingLeft(eligible, role, opts) });
    }
  }

  #nothingLeft(eligible, role, opts) {
    if (!eligible.length) {
      return `no AI model is available for ${this.name} (none of its models can ${opts.write ? 'edit files' : `act as ${role}`})`;
    }
    const why = eligible.map((c) => `${c.name}: ${plain(this.board.state(c.name).reason)}`).join('; ');
    return `no AI model is available for ${this.name} (${why})`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/router.js test/router.test.js
git commit -m "feat: Seat fallback ladder with a shared health board"
```
