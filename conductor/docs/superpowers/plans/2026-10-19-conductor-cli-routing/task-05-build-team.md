# Task 5: buildTeam & two-vendor degradation

This task turns the configured participants into the run's team of three Seats.

- **Probe.** It probes every candidate first (in parallel) and marks the dead ones down on the shared board.
- **Pick.** It chooses the preferred author and reviewer **from different vendors**.
- **Order.** It orders each Seat's fallbacks by the spec ladder.
- **Degrade.** It says in plain English when the run is degraded:
  - only one vendor is alive;
  - the local model is down;
  - Claude Code may bill an API key instead of the subscription.

`validateTeam` moves from comparing adapter kinds to comparing vendors, and allows the same vendor in both seats only when `buildTeam` says so.

**Files:**
- Create: `src/team.js`, `test/team.test.js`
- Modify: `src/conductor.js` (`validateTeam`, its callers), `src/options.js`
- Test: `test/conductor.test.js` (append)

**Interfaces:**
- Consumes:
  - `checkHealth(adapter, { timeoutMs })`, which delegates to `adapter.probe` (Task 3);
  - `HealthBoard`, `Seat`, `REASON_TEXT` (Task 4);
  - `vendorOf`, `isApiKind`, `isSubscriptionKind` (Task 2).
- Produces:
  - `buildTeam(participants, { routing = {}, health = checkHealth, env = process.env, board = new HealthBoard(), sleep })`.
    - Success: `{ ok: true, team: { author, reviewer, local }, warnings, report, allowSameVendor }`.
    - Failure: `{ ok: false, error, report }`.
    - `report` is `[{ name, kind, ok, reason, detail }]`, one entry per probed participant, in config order: subscriptions, then APIs (only if `allowApi`), then locals.
    - `error` is one plain-English sentence that says what to do.
  - `routing` keys, with defaults: `author`, `reviewer`, `local` (participant names, optional), `allowApi: false`, `preferTwoVendors: false`, `localDown: 'frontier'` (or `'pause'`), `cooldownMs: 60000`, `maxWaitMs: 300000`.
  - **Classification:**
    - frontier subscription = `isSubscriptionKind(kind)` and can play both `author` and `reviewer`;
    - API = `isApiKind(kind)` (ignored entirely unless `allowApi`);
    - local = can play `grunt` and is not an API.
  - **Picks:**
    - author = `routing.author` if healthy, else the first healthy subscription, else the first healthy API;
    - reviewer = the healthy subscription of a **different vendor** (`routing.reviewer` first if it qualifies), else (only when `preferTwoVendors`) a healthy API of a different vendor, else the first other healthy frontier participant, else the author itself;
    - `allowSameVendor` = the two picks share a vendor.
  - **Seat candidates** (deduplicated, preferred first):
    - author: `[author, ...other subscriptions in config order, ...APIs (author's vendor first)]`;
    - reviewer: `[reviewer, ...(preferTwoVendors ? APIs whose vendor ≠ author's : []), ...other subscriptions, ...APIs (reviewer's vendor first)]`.
    - Unhealthy candidates stay in the list; the board makes the Seat skip them.
  - **Seat names** are the preferred participant's name (so `claude`, `codex`, `local` in the usual config).
  - **Warnings** are the exported strings below, pushed in this order: `LOCAL_DOWN_WARNING`, `SAME_VENDOR_WARNING`, `API_KEY_BILLING_WARNING`.
    - The billing warning appears when `env.ANTHROPIC_API_KEY` is set and a healthy `claude-code` participant is in the team.
  - **Errors:**
    - no local participant;
    - local down with `localDown: 'pause'`;
    - no healthy frontier participant at all;
    - a `routing.author`/`reviewer`/`local` name that matches no participant.
  - `DEFAULT_OPTIONS.allowSameVendor = false`.
  - `validateTeam(team, { allowSameVendor = false } = {})`: the vendor rule is now `vendorOf(author.adapter.kind) !== vendorOf(reviewer.adapter.kind)` unless `allowSameVendor`. The error text keeps the words `two-vendor rule`.
  - `runTask` calls `validateTeam(team, opts)`, and `resume` calls `validateTeam(team, options)` with the caller's options.

```js
export const SAME_VENDOR_WARNING = "Only one AI company's models were available, so the same company's AI checked its own work. The cross-checking is weaker this run.";
export const LOCAL_DOWN_WARNING = 'The local model was not available, so the subscription models did every step. This uses more of your subscription.';
export const API_KEY_BILLING_WARNING = 'ANTHROPIC_API_KEY is set in your environment, so Claude Code may charge your Anthropic API account instead of your subscription.';
```

- [ ] **Step 1: Write the failing tests**

Create `test/team.test.js`:

```js
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
```

Append to `test/conductor.test.js`:

```js
test('validateTeam compares vendors, and allowSameVendor lifts the rule', () => {
  const t = makeTeam();
  const apiReviewer = fakeParticipant({ name: 'claude-api', kind: 'anthropic-api', script: approve });
  assert.throws(() => validateTeam({ ...t, reviewer: apiReviewer }), /two-vendor rule/);
  const sameVendor = { ...t, reviewer: fakeParticipant({ name: 'c2', kind: 'claude-code', script: approve }) };
  assert.doesNotThrow(() => validateTeam(sameVendor, { allowSameVendor: true }));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL. `src/team.js` does not exist, and `validateTeam` compares kinds, so an `anthropic-api` reviewer next to a `claude-code` author passes when it should throw.

- [ ] **Step 3: Implement**

`src/options.js`: add after `keepWorkspace`:

```js
  allowSameVendor: false, // set by buildTeam when only one AI vendor is healthy (the summary then says so)
```

`src/conductor.js`:
- Add `import { vendorOf } from './vendors.js';`.
- Change the signature to `export function validateTeam(team, { allowSameVendor = false } = {}) {`.
- Replace the two-vendor block with:

```js
  if (!allowSameVendor && vendorOf(author.adapter.kind) === vendorOf(reviewer.adapter.kind)) {
    throw new Error(`two-vendor rule: ${author.name} and ${reviewer.name} are both ${vendorOf(author.adapter.kind)} models; pick frontier participants from different vendors`);
  }
```

- In `runTask`, change `validateTeam(team);` to `validateTeam(team, opts);`.
- In `resume`, change `validateTeam(team);` to `validateTeam(team, options);`.

Create `src/team.js`:

```js
// src/team.js
// Preflight + preference (spec §7): probe everyone, pick author and reviewer from different
// vendors, order each Seat's fallbacks by the ladder, and say plainly when the run is degraded.
import { checkHealth } from './health.js';
import { HealthBoard, Seat, REASON_TEXT } from './router.js';
import { vendorOf, isApiKind, isSubscriptionKind } from './vendors.js';

export const SAME_VENDOR_WARNING = "Only one AI company's models were available, so the same company's AI checked its own work. The cross-checking is weaker this run.";
export const LOCAL_DOWN_WARNING = 'The local model was not available, so the subscription models did every step. This uses more of your subscription.';
export const API_KEY_BILLING_WARNING = 'ANTHROPIC_API_KEY is set in your environment, so Claude Code may charge your Anthropic API account instead of your subscription.';

const PROBE_TIMEOUT_MS = { 'local-agent': 60000 }; // the first local call may load the model
const ROUTING_DEFAULTS = { allowApi: false, preferTwoVendors: false, localDown: 'frontier', cooldownMs: 60000, maxWaitMs: 300000 };

const uniq = (list) => [...new Set(list)];

export async function buildTeam(participants, { routing = {}, health = checkHealth, env = process.env, board = new HealthBoard(), sleep } = {}) {
  const r = { ...ROUTING_DEFAULTS, ...routing };
  const named = (n) => participants.find((p) => p.name === n);
  const subs = participants.filter((p) => isSubscriptionKind(p.adapter.kind) && p.canPlay('author') && p.canPlay('reviewer'));
  const apis = r.allowApi ? participants.filter((p) => isApiKind(p.adapter.kind)) : [];
  const locals = participants.filter((p) => p.canPlay('grunt') && !isApiKind(p.adapter.kind));

  const probed = uniq([...subs, ...apis, ...locals]);
  const report = await Promise.all(probed.map(async (p) => {
    let h;
    try {
      h = await health(p.adapter, { timeoutMs: PROBE_TIMEOUT_MS[p.adapter.kind] ?? 15000 });
    } catch (e) {
      h = { ok: false, reason: 'unavailable', detail: String(e?.message ?? e) };
    }
    const ok = h?.ok === true;
    return { name: p.name, kind: p.adapter.kind, ok, reason: ok ? '' : (h?.reason || 'unavailable'), detail: h?.detail ?? null };
  }));
  const entry = (p) => report.find((x) => x.name === p.name);
  const healthy = (p) => entry(p)?.ok === true;
  for (const x of report) if (!x.ok) board.markDown(x.name, x.reason);
  const fail = (error) => ({ ok: false, error, report });
  const why = (p) => entry(p)?.detail ?? REASON_TEXT[entry(p)?.reason] ?? entry(p)?.reason ?? 'not available';

  for (const k of ['author', 'reviewer', 'local']) {
    if (r[k] && !named(r[k])) return fail(`The config's routing.${k} names "${r[k]}", but there is no participant with that name.`);
  }

  const warnings = [];
  const local = (r.local && named(r.local)) || locals[0];
  if (!local) return fail('The config has no local model (a participant with the "grunt" role).');
  if (!healthy(local)) {
    if (r.localDown === 'pause') return fail(`The local model ${local.name} is not available (${why(local)}). Start it, then run Conductor again.`);
    warnings.push(LOCAL_DOWN_WARNING);
  }

  const okSubs = subs.filter(healthy);
  const okApis = apis.filter(healthy);
  if (!okSubs.length && !okApis.length) {
    const reasons = subs.map((p) => `${p.name}: ${REASON_TEXT[entry(p).reason] ?? entry(p).reason}`).join('; ');
    return fail(`No AI subscription is available: ${reasons || 'none is configured'}. Sign in to Claude Code or Codex, then try again.`);
  }
  const preferred = (name, pool) => (name && pool.find((p) => p.name === name)) || null;
  const author = preferred(r.author, okSubs) ?? okSubs[0] ?? okApis[0];
  const otherVendor = (p) => vendorOf(p.adapter.kind) !== vendorOf(author.adapter.kind);
  const reviewer =
    preferred(r.reviewer, okSubs.filter(otherVendor)) ??
    okSubs.find(otherVendor) ??
    (r.preferTwoVendors ? okApis.find(otherVendor) : undefined) ??
    [...okSubs, ...okApis].find((p) => p !== author) ??
    author;
  const allowSameVendor = vendorOf(author.adapter.kind) === vendorOf(reviewer.adapter.kind);
  if (allowSameVendor) warnings.push(SAME_VENDOR_WARNING);
  if (env.ANTHROPIC_API_KEY && okSubs.some((p) => p.adapter.kind === 'claude-code')) warnings.push(API_KEY_BILLING_WARNING);

  const apisFor = (p) => [...apis.filter((a) => vendorOf(a.adapter.kind) === vendorOf(p.adapter.kind)), ...apis];
  const seatOpts = { board, cooldownMs: r.cooldownMs, maxWaitMs: r.maxWaitMs, ...(sleep ? { sleep } : {}) };
  const team = {
    author: new Seat({ name: author.name, candidates: uniq([author, ...subs, ...apisFor(author)]), ...seatOpts }),
    reviewer: new Seat({
      name: reviewer.name,
      candidates: uniq([reviewer, ...(r.preferTwoVendors ? apis.filter(otherVendor) : []), ...subs, ...apisFor(reviewer)]),
      ...seatOpts,
    }),
    local: new Seat({ name: local.name, candidates: [local], ...seatOpts }),
  };
  return { ok: true, team, warnings, report, allowSameVendor };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS. The existing `validateTeam enforces roles, editing and the two-vendor rule` test still passes: `claude-code` vs `claude-code` is the same vendor.

- [ ] **Step 5: Commit**

```bash
git add src/team.js src/conductor.js src/options.js test
git commit -m "feat: buildTeam — preflight probes, two-vendor picks, degradation warnings"
```
