# Task 8: Shipping the update to every deployment

With a checked release, the change goes out as an **update** to every deployment of the project (spec §4.8; Contracts 4 and 7.6).
- Every update goes through Plan 10's `updateDeployment({ projectDir, name, version, foundation, runId }, { factory, say, state }) -> { outcome, message }` (the second argument is Plan 10's options: Plan 11 passes its `factory`, the terminal's `say`, and the CLI's ship `state`, so Ctrl-C can call Plan 10's `interruptShip(state)`). It wraps Plan 10's `runLaterShip` for an existing deployment, which runs the foundation's own `updater update --to <version>` on the box: stop, backup first, switch, migrate, start, health check, and automatic undo if it fails (`docs/RUNBOOK.md` "Updating").
- Plan 10 records the outcome, `currentVersion`, `foundation` and history in `deployments/<name>.json`.
- Plan 11 never runs ssh or docker, never re-implements any of that, and never writes deployment files (index Ruling 9).

What Plan 11 adds is the order and the stop rules:
- the project's deployments come from Plan 10's `listDeployments(projectsRoot)`, filtered by slug. Any entry of this project with a `problem` (an unreadable record) stops the ship **before any box is touched**;
- a deployment whose setup is not finished (`setup.step !== 'done'`) is skipped and reported; it does not stop the rest;
- the others are updated **one at a time, in name order**;
- before each one, the ship guard (`shipProblem`, Task 5) is checked again, and the deployment must currently be on an older version;
- Plan 10's `updated` and `already-on` carry on (`CONTINUE_OUTCOMES`). `rolled-back`, `cancelled`, `busy`, `settings-error`, `urgent`, `lost-contact`, `refused` and **anything unexpected** stop the rest (Plan 10's `OUTCOMES`/`UPDATE_OUTCOMES` are the only names, Contract 7 §7.11), because a version that failed on one box is not pushed to the next;
- each result is saved to `change.json` as soon as it is known, so a crash never updates the same box twice;
- on resume, a deployment that already ended `updated`/`already-on` is skipped, and one that stopped the ship is retried **only if the operator says so** (`ask`, which answers "no" without a terminal).

**Files:**
- Create: `src/factory/change/ship.js`
- Test: `test/factory-change-ship.test.js`

**Interfaces:**
- Consumes: `deps.listDeployments`, `deps.updateDeployment`, `deps.now` (Task 1's seams); `CONTINUE_OUTCOMES` (Task 1); `shipProblem` (Task 5); `compareVersions` (Plan 10, `foundationLog.js`); `redact` from `src/secrets.js`; `clip` from `src/text.js`; `stubDeps`, `makeProject` (Task 1).
- Produces:
  - `projectDeployments(deps, { projectsRoot, slug }) -> { list: [{ name, deployment }], problem: string | null }`. `list` is sorted by name. `problem` is `` `The deployment record ${name} could not be read (${entry.problem}), so nothing was updated. Fix or remove it, then resume.` `` for the first unreadable entry;
  - `shipUpdate({ projectDir, projectsRoot, slug, run, version, foundation, deps, factory, say, state, ask, save }) -> Promise<{ status: 'done'|'stopped', reason: string | null }>`; `ask(question) -> Promise<boolean>`; `save(run)` persists `run.deployments`; `factory`, `say` and `state` go unchanged into `updateDeployment`'s second argument;
  - `shipReport(run, list) -> string`;
  - outcome sentences (exact, `<name>` and versions filled in):
    - `updated`: `` `${name}: updated to ${version}, with a backup taken first.` ``
    - `already-on`: `` `${name}: already on ${version}.` ``
    - `cancelled`: `` `${name}: the update was cancelled and nothing was changed there: ${message}` ``
    - `rolled-back`: `` `${name}: the new version failed its health check, so the box undid the update by itself. It is back on ${from} with its data as before.` ``
    - `busy`: `` `${name}: something else was already running on the box, so nothing was changed there: ${message}` ``
    - `settings-error`: `` `${name}: the box's settings are not right, so the update did not start: ${message}` ``
    - `urgent`: `` `${name}: URGENT. The update failed and the automatic undo also failed. Follow "Recovering from a failed update" in the foundation runbook now. ${message}` ``
    - `lost-contact`: `` `${name}: Conductor lost contact with the box during the update, so it does not know how it ended. Check it with "conductor deployments status" before trying again. ${message}` ``
    - `refused`: `` `${name}: Conductor did not start the update there, and nothing was changed: ${message}` ``
    - unknown (including a throw): `` `${name}: the update ended in a way Conductor does not recognise (${outcome}), so it is treated as failed.` ``
    - not attempted: `` `${name}: not updated (still on ${from}), because an earlier deployment did not update.` ``
    - not set up: `` `${name}: not set up yet, so it was not updated. Finish it with "conductor ship <slug> --to ${name}".` ``
  - `NO_DEPLOYMENTS = 'This project has no deployments yet, so nothing was updated. When you are ready, ship it with "conductor ship <slug> --to <deployment>".'`

- [ ] **Step 1: Write the failing tests**

```js
const dep = (name, over = {}) => ({ slug: 'acme', name, problem: null,
  deployment: { name, project: 'acme', currentVersion: '0.2.0', foundation: 'v0.1.0', setup: { step: 'done' }, ...over } });
const entries = [dep('beta-office'), dep('acme-office'), dep('acme-cloud'), { ...dep('other'), slug: 'bobs' }];
const run = () => ({ runId: '20261027-143205-a1b2', approval: GOOD_APPROVAL, release: { version: '0.3.0', sha: REL, tag: 'v0.3.0' }, deployments: {} });

test('updates every deployment of this project one at a time, in name order, through Plan 10, and saves each result as it comes', async () => {
  const saves = [];
  const deps = stubDeps({ listDeployments: () => entries, updateDeployment: async () => ({ outcome: 'updated', message: 'Updated from 0.2.0 to 0.3.0. A backup (1a2b3c4d) was taken first.' }) });
  const r = await shipUpdate({ projectDir, projectsRoot, slug: 'acme', run: run(), version: '0.3.0', foundation: 'v0.1.0', deps, ask: async () => false, save: (x) => saves.push(structuredClone(x.deployments)) });
  assert.deepEqual(r, { status: 'done', reason: null });
  assert.deepEqual(deps.calls.filter((c) => c.name === 'updateDeployment').map((c) => c.arg.name), ['acme-cloud', 'acme-office', 'beta-office']);
  assert.deepEqual(deps.calls.find((c) => c.name === 'updateDeployment').arg, { projectDir, name: 'acme-cloud', version: '0.3.0', foundation: 'v0.1.0', runId: '20261027-143205-a1b2' });
  assert.equal(saves.length, 3);
  assert.deepEqual(Object.keys(saves[0]), ['acme-cloud']);
});

for (const outcome of ['cancelled', 'rolled-back', 'busy', 'settings-error', 'lost-contact', 'urgent', 'refused', 'something-new']) {
  test(`a ${outcome} outcome stops the rest; later deployments are not touched`, async () => {
    const deps = stubDeps({ listDeployments: () => entries, updateDeployment: async ({ name }) => ({ outcome: name === 'acme-office' ? outcome : 'updated', message: 'm' }) });
    const r = await shipUpdate({ … });
    assert.equal(r.status, 'stopped');
    assert.deepEqual(deps.calls.filter((c) => c.name === 'updateDeployment').map((c) => c.arg.name), ['acme-cloud', 'acme-office']);
  });
}

test('an unreadable deployment record of this project stops the ship before any box is touched', ...)
  // entries include { slug: 'acme', name: 'acme-broken', deployment: null, problem: 'bad JSON' } → stopped, reason names acme-broken; no updateDeployment call
test('a deployment whose setup is not finished is skipped and reported, and the rest carry on', ...)
  // setup.step 'configured' → recorded { outcome: 'not-set-up' }; the others updated; status 'done'
test('an updateDeployment that throws counts as failed and stops the rest, with the error redacted', ...)
  // throws new Error('ssh: password sk-ant-xxxxxxxxxxxxxxxxxxxx') → stopped; saved message contains '[redacted]'
test('the ship guard is checked before each deployment: a run without approval updates nothing', ...)
  // run.approval = undefined → { status: 'stopped', reason: NO_APPROVAL }; no updateDeployment call
test('a deployment already on the new version or newer is not updated again', ...)
  // currentVersion '0.3.0' → recorded 'already-on', no call; currentVersion '0.4.0' → stopped, /is on 0\.4\.0, newer than 0\.3\.0/
test('resume skips deployments already updated and asks before retrying the one that stopped the ship', async () => {
  // run.deployments = { 'acme-cloud': { outcome: 'updated' }, 'acme-office': { outcome: 'rolled-back', from: '0.2.0' } }
  // ask returns false → stopped, no calls at all, reason /You chose not to try acme-office again/
  // ask returns true → calls acme-office then beta-office
  // the question text: 'acme-office did not update last time (the new version failed its health check, so the box undid the update by itself). Try it again now?'
});
test('no deployments: done, with the plain note', ...)   // { status: 'done', reason: NO_DEPLOYMENTS }
test('shipReport lists every deployment with what happened and the version it is on now', () => {
  const { list } = projectDeployments(stubDeps({ listDeployments: () => entries }), { projectsRoot, slug: 'acme' });
  const text = shipReport({ release: { version: '0.3.0' }, deployments: { 'acme-cloud': { outcome: 'updated' }, 'acme-office': { outcome: 'rolled-back', message: 'm', from: '0.2.0' } } }, list);
  assert.equal(text, [
    'Deployments:',
    '  acme-cloud: updated to 0.3.0, with a backup taken first.',
    '  acme-office: the new version failed its health check, so the box undid the update by itself. It is back on 0.2.0 with its data as before.',
    '  beta-office: not updated (still on 0.2.0), because an earlier deployment did not update.',
  ].join('\n'));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-ship.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/ship.js`**

- `projectDeployments`: `deps.listDeployments(projectsRoot)`, keep `slug === slug`, sort by `name`, then return the first entry with a `problem` as `problem`.
- `shipUpdate`:
  - `problem` → `{ status: 'stopped', reason: problem }`. An empty list → `{ status: 'done', reason: NO_DEPLOYMENTS }`.
  - For each deployment:
    1. skip it if `run.deployments[name]?.outcome` is in `CONTINUE_OUTCOMES`;
    2. `setup.step !== 'done'` → record `{ outcome: 'not-set-up', at }`, save, carry on;
    3. if it has a stopping outcome from before: `await ask(question)`. Anything but exactly `true` → return `stopped` with `` `You chose not to try ${name} again, so it and the deployments after it were not updated.` ``;
    4. `await shipProblem(run, { appDir: path.join(projectDir, 'app') })` → return `stopped` with that reason;
    5. `compareVersions(d.currentVersion, version)`: equal → record `already-on`; greater → stopped (`` `${name} is on ${d.currentVersion}, newer than ${version}, so it was left alone.` ``);
    6. call `deps.updateDeployment({ projectDir, name, version, foundation, runId: run.runId }, { factory, say, state })` in `try`; a throw becomes `{ outcome: 'error', message }`;
    7. record `{ outcome, message: clip(redact(message), 1000), at: deps.now().toISOString(), from: d.currentVersion }`, then `save(run)`;
    8. stop unless the outcome is in `CONTINUE_OUTCOMES`; the reason is that deployment's outcome sentence.
- `shipReport`: one line per deployment from the saved results. Deployments with no result get the "not attempted" sentence.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-ship.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/ship.js test/factory-change-ship.test.js
git commit -m "feat(change): ship an update to each deployment in turn through the foundation's safe update

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
