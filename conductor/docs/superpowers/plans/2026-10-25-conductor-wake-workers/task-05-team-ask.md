# Task 5: buildTeam — ask before the frontier covers for local

Today, when the local model is down, `buildTeam` quietly plans for Claude and Codex to do every step (`localDown: "frontier"`). The run then spends subscription usage the operator never agreed to: smoke run 2 cost about $0.57 this way.

The spec's [call] (§4.2) says to ask first, so `"ask"` becomes the default (Ruling 1). `buildTeam` itself never prompts. It reports the down local model as `built.localDown`, and the CLI asks (Task 8).

**Commit safety.** Once this task flips the default, `buildTeam` no longer pushes `LOCAL_DOWN_WARNING` for a down local model, and until Task 8 lands the CLI would ignore `built.localDown`: the subscription would cover **silently**, which is worse than today. So this task also adds a small interim stop to `src/cli/main.js`: a run (not `doctor`) with `built.localDown` set prints a plain message and exits 1 before anything is spent. Task 8 replaces that block with the real consent loop. Tasks 5–8 still ship together in one merge (see the index).

**Files:**
- Modify: `src/team.js`, `src/cli/main.js` (interim stop)
- Test: `test/team.test.js` (modify one test, append one), `test/cli-e2e.test.js` (append one)

**Interfaces:**
- Consumes: `REASON_TEXT` (`src/router.js`); the existing `report` entries `{ name, kind, ok, reason, detail }`.
- Produces:
  - `ROUTING_DEFAULTS.localDown = 'ask'`.
  - `buildTeam` return on success gains `localDown`:
    - `null` when the local model is healthy, or when `localDown` is `"frontier"`;
    - otherwise `{ name, reason, detail }`, copied from the local's report entry.
  - When the local model is unhealthy:
    - `'pause'` → unchanged (`ok: false`, same message);
    - `'frontier'` → unchanged (`LOCAL_DOWN_WARNING` pushed, `localDown: null`);
    - `'ask'` → `ok: true`, `localDown` set, `LOCAL_DOWN_WARNING` **not** pushed.
  - The local Seat is still built either way. It is already marked down on the board, so if the operator says "go ahead", the chunk phase falls back at once.
  - Any `localDown` value other than `'frontier'` or `'pause'` behaves as `'ask'` (fail closed; `loadConfig` already rejects such values, Task 2).
  - `src/cli/main.js` (interim, replaced in Task 8): after the `doctor`/`!built.ok` block, a run with `built.localDown` set prints `The local model <name> is not available (<detail or reason text>). Start the local model, then run Conductor again.` and returns `EXIT.stopped` (1).

- [ ] **Step 1: Update the existing test and add the new one**

In `test/team.test.js`, replace the test `'local down: frontier covers with a warning, or pause when configured'` with:

```js
test('local down: ask by default, frontier covers with a warning when configured, or pause', async () => {
  const down = { ok: false, reason: 'unavailable', detail: 'could not reach the local model server (ECONNREFUSED)' };
  const ask = await buildTeam([claude(), codex(), local({ probe: down })], { env: NOENV });
  assert.equal(ask.ok, true);
  assert.deepEqual(ask.warnings, [], 'no warning until the operator agrees');
  assert.deepEqual(ask.localDown, { name: 'local', reason: 'unavailable', detail: 'could not reach the local model server (ECONNREFUSED)' });
  assert.equal(ask.team.local.name, 'local');
  const fr = await buildTeam([claude(), codex(), local({ probe: down })], { routing: { localDown: 'frontier' }, env: NOENV });
  assert.equal(fr.ok, true);
  assert.deepEqual(fr.warnings, [LOCAL_DOWN_WARNING]);
  assert.equal(fr.localDown, null);
  const p2 = await buildTeam([claude(), codex(), local({ probe: down })], { routing: { localDown: 'pause' }, env: NOENV });
  assert.equal(p2.ok, false);
  assert.match(p2.error, /local model local is not available \(could not reach the local model server/);
});

test('local healthy: localDown is null', async () => {
  const r = await buildTeam([claude(), codex(), local()], { env: NOENV });
  assert.equal(r.localDown, null);
});
```

Then search the suite for any other test that expects `LOCAL_DOWN_WARNING` or a frontier fallback from a down local model **without** setting `localDown`:

```bash
grep -rn "LOCAL_DOWN_WARNING\|probe: down\|local.*DOWN" test/
```

Add `routing: { localDown: 'frontier' }` to each one found (Global Constraints: existing behaviour is only made explicit).

Append to `test/cli-e2e.test.js` (it outlives this task: Task 8's consent loop also exits 1 without a terminal, and its `STOPPED_BEFORE_START` also contains "Start the local model, then run"):

```js
test('local down without consent: the run stops before anything is spent', async () => {
  const s = await setup();
  try {
    const cfg = JSON.parse(readFileSync(s.cfg, 'utf8'));
    cfg.participants[2].baseUrl = 'http://127.0.0.1:9/v1'; // nothing listens there: connection refused
    writeFileSync(s.cfg, JSON.stringify(cfg));
    const before = await refsOf(s.repo);
    const r = await spawnBin(['add multiply', '--config', s.cfg], { cwd: s.repo, env: s.env });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /Start the local model, then run/);
    assert.doesNotMatch(r.out, /Plan agreed/, 'no agent was called');
    assert.deepEqual(await refsOf(s.repo), before);
  } finally { await s.close(); }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/team.test.js`
Expected: FAIL. The default still pushes `LOCAL_DOWN_WARNING`, and `localDown` is `undefined`.

- [ ] **Step 3: Implement in `src/team.js` and the interim stop in `src/cli/main.js`**

In `src/team.js`, change the defaults line:

```js
const ROUTING_DEFAULTS = { allowApi: false, preferTwoVendors: false, localDown: 'ask', cooldownMs: 60000, maxWaitMs: 300000 };
```

Replace the block from `const warnings = [];` to the end of the `if (!healthy(local)) { … }` block with:

```js
  const warnings = [];
  const local = (r.local && named(r.local)) || locals[0];
  if (!local) return fail('The config has no local model (a participant with the "grunt" role).');
  // A down local model is reported, not covered, unless routing.localDown is 'frontier' (factory spec §4.2):
  // covering uses the operator's subscription, so the CLI asks first.
  let localDown = null;
  if (!healthy(local)) {
    if (r.localDown === 'pause') return fail(`The local model ${local.name} is not available (${why(local)}). Start it, then run Conductor again.`);
    if (r.localDown === 'frontier') warnings.push(LOCAL_DOWN_WARNING);
    else localDown = { name: local.name, reason: entry(local)?.reason || 'unavailable', detail: entry(local)?.detail ?? null };
  }
```

and the final return with:

```js
  return { ok: true, team, warnings, report, allowSameVendor, localDown };
```

Update the header comment's second line to: `// vendors, order each Seat's fallbacks by the ladder, and say plainly when the run is degraded. A down local model is reported, not covered, unless routing.localDown is 'frontier'.`

In `src/cli/main.js`, directly after the closing brace of `if (cli.command === 'doctor' || !built.ok) { … }` and before `for (const w of built.warnings) term.say(...)`, add:

```js
  // Interim (Plan 4 Task 5; Task 8 replaces this with the consent question): never let the
  // subscription cover a down local model without the operator's say-so.
  if (built.localDown) {
    const d = built.localDown;
    term.say(`The local model ${d.name} is not available (${d.detail ?? REASON_TEXT[d.reason] ?? d.reason}). Start the local model, then run Conductor again.`);
    term.close();
    return EXIT.stopped;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS, including the new e2e test. No existing e2e test has its local stub server down, so none changes; if one does fail here, add `localDown: 'frontier'` to that test's config routing. The real CLI consent behaviour arrives in Task 8.

- [ ] **Step 5: Commit**

```bash
git add src/team.js src/cli/main.js test
git commit -m "feat: routing.localDown defaults to ask — a down local model is reported, not silently covered"
```
