# Task 8: Shipping the update to every deployment

With a checked release, the change goes out as an **update** to every deployment of the project (spec §4.8; Contract 4). Every update goes through Plan 10's `updateDeployment`, which runs the foundation's own `updater update --to <version>` on the box: stop, backup first, switch, migrate, start, health check, and automatic undo if it fails (`docs/RUNBOOK.md` "Updating"). Plan 11 never runs ssh or docker and never re-implements any of that (index Ruling 9).

What Plan 11 adds is the order and the stop rules:
- deployments are updated **one at a time, in name order**;
- before each one, the ship guard (`shipProblem`, Task 5) is checked again, and the deployment must currently be on an older version;
- `updated` and `already` carry on; `cancelled`, `rolled-back`, `unreachable`, `urgent` and **anything unexpected** stop the rest, because a version that failed on one box is not pushed to the next;
- each result is saved to `change.json` as soon as it is known, so a crash never updates the same box twice;
- on resume, a deployment that already ended `updated`/`already` is skipped, and one that stopped the ship is retried **only if the operator says so** (`ask`, which answers "no" without a terminal).

**Files:**
- Create: `src/factory/change/ship.js`
- Test: `test/factory-change-ship.test.js`

**Interfaces:**
- Consumes: `deps.listDeployments`, `deps.updateDeployment` (Plan 10, via Task 1's seams); `shipProblem` (Task 5); `compareVersions` (Task 2); `redact` from `src/secrets.js`; `stubDeps`, `makeProject` (Task 1).
- Produces:
  - `shipUpdate({ projectDir, run, version, foundation, deps, ask, save }) -> Promise<{ status: 'done'|'stopped', reason: string | null }>`; `ask(question) -> Promise<boolean>`; `save(run)` persists `run.deployments`;
  - `shipReport(run, deployments) -> string`;
  - outcome sentences (exact, `<name>` and versions filled in):
    - `updated`: `` `${name}: updated to ${version}, with a backup taken first.` ``
    - `already`: `` `${name}: already on ${version}.` ``
    - `cancelled`: `` `${name}: the update was cancelled and nothing was changed there: ${message}` ``
    - `rolled-back`: `` `${name}: the new version failed its health check, so the box undid the update by itself. It is back on ${from} with its data as before.` ``
    - `urgent`: `` `${name}: URGENT. The update failed and the automatic undo also failed. Follow "Recovering from a failed update" in the foundation runbook now. ${message}` ``
    - `unreachable`: `` `${name}: Conductor could not reach the box, so nothing was changed there: ${message}` ``
    - unknown: `` `${name}: the update ended in a way Conductor does not recognise (${outcome}), so it is treated as failed.` ``
    - not attempted: `` `${name}: not updated (still on ${from}), because an earlier deployment did not update.` ``
  - `NO_DEPLOYMENTS = 'This project has no deployments yet, so nothing was updated. When you are ready, ship it with "conductor ship <slug> --to <deployment>".'`

- [ ] **Step 1: Write the failing tests**

```js
const deployments = [
  { name: 'beta-office', currentVersion: '0.2.0', foundation: 'v0.1.0' },
  { name: 'acme-office', currentVersion: '0.2.0', foundation: 'v0.1.0' },
  { name: 'acme-cloud', currentVersion: '0.2.0', foundation: 'v0.1.0' },
];
const run = () => ({ runId: 'change-20261027-143205', approval: GOOD_APPROVAL, release: { version: '0.3.0', sha: REL }, deployments: {} });

test('updates every deployment one at a time, in name order, through Plan 10, and saves each result as it comes', async () => {
  const saves = [];
  const deps = stubDeps({ listDeployments: () => deployments, updateDeployment: async (a) => ({ outcome: 'updated', message: 'Updated from 0.2.0 to 0.3.0. A backup (1a2b3c4d) was taken first.' }) });
  const r = await shipUpdate({ projectDir, run: run(), version: '0.3.0', foundation: 'v0.1.0', deps, ask: async () => false, save: (x) => saves.push(structuredClone(x.deployments)) });
  assert.deepEqual(r, { status: 'done', reason: null });
  assert.deepEqual(deps.calls.filter((c) => c.name === 'updateDeployment').map((c) => c.arg.name), ['acme-cloud', 'acme-office', 'beta-office']);
  assert.deepEqual(deps.calls.find((c) => c.name === 'updateDeployment').arg, { projectDir, name: 'acme-cloud', version: '0.3.0', foundation: 'v0.1.0', runId: 'change-20261027-143205' });
  assert.equal(saves.length, 3);
  assert.deepEqual(Object.keys(saves[0]), ['acme-cloud']);
});

for (const outcome of ['cancelled', 'rolled-back', 'unreachable', 'urgent', 'something-new']) {
  test(`a ${outcome} outcome stops the rest; later deployments are not touched`, async () => {
    const deps = stubDeps({ listDeployments: () => deployments, updateDeployment: async ({ name }) => ({ outcome: name === 'acme-office' ? outcome : 'updated', message: 'm' }) });
    const r = await shipUpdate({ … });
    assert.equal(r.status, 'stopped');
    assert.deepEqual(deps.calls.filter((c) => c.name === 'updateDeployment').map((c) => c.arg.name), ['acme-cloud', 'acme-office']);
  });
}

test('an updateDeployment that throws counts as failed and stops the rest, with the error redacted', ...)
  // throws new Error('ssh: password sk-ant-xxxxxxxxxxxxxxxxxxxx') → stopped; saved message contains '[redacted]'
test('the ship guard is checked before each deployment: a run without approval updates nothing', ...)
  // run.approval = undefined → { status: 'stopped', reason: NO_APPROVAL }; no updateDeployment call
test('a deployment already on the new version or newer is not updated again', ...)
  // currentVersion '0.3.0' → recorded 'already', no call; currentVersion '0.4.0' → stopped, /is on 0\.4\.0, newer than 0\.3\.0/
test('resume skips deployments already updated and asks before retrying the one that stopped the ship', async () => {
  // run.deployments = { 'acme-cloud': { outcome: 'updated' }, 'acme-office': { outcome: 'rolled-back' } }
  // ask returns false → stopped, no calls at all, reason /You chose not to try acme-office again/
  // ask returns true → calls acme-office then beta-office
  // the question text: 'acme-office did not update last time (the new version failed its health check, so the box undid the update by itself). Try it again now?'
});
test('no deployments: done, with the plain note', ...)   // { status: 'done', reason: NO_DEPLOYMENTS }
test('shipReport lists every deployment with what happened and the version it is on now', () => {
  const text = shipReport({ release: { version: '0.3.0' }, deployments: { 'acme-cloud': { outcome: 'updated' }, 'acme-office': { outcome: 'rolled-back', message: 'm' } } }, deployments);
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

- Sort `deps.listDeployments(projectDir)` by `name`. None → `{ status: 'done', reason: NO_DEPLOYMENTS }`.
- For each deployment:
  - skip if `run.deployments[name]?.outcome` is `updated` or `already`;
  - if it has a stopping outcome from before: `await ask(question)`; not exactly `true` → return `stopped` with `` `You chose not to try ${name} again, so it and the deployments after it were not updated.` ``;
  - `await shipProblem(run, { appDir: path.join(projectDir, 'app') })` → return `stopped` with that reason;
  - `compareVersions(d.currentVersion, version)`: equal → record `already`; greater → stopped (`` `${name} is on ${d.currentVersion}, newer than ${version}, so it was left alone.` ``);
  - call `deps.updateDeployment(...)` in `try`; a throw becomes `{ outcome: 'error', message }`;
  - record `{ outcome, message: clip(redact(message), 1000), at: deps.now().toISOString(), from: d.currentVersion }`, then `save(run)`;
  - stop unless the outcome is `updated` or `already`; the reason is that deployment's outcome sentence.
- `shipReport`: one line per deployment from the saved results; deployments with no result get the "not attempted" sentence.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-ship.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/ship.js test/factory-change-ship.test.js
git commit -m "feat(change): ship an update to each deployment in turn through the foundation's safe update"
```
