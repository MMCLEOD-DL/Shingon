# Task 5: The change gate and ship guard

This task enforces the safety rule: **a change never ships without a passing council or an explicit operator override** (index Ruling 7). It does so in two places.

1. **`makeChangeGate`** builds the `hooks.approveBuild` that Plan 8's `runBuild` calls after the council in change mode (Task 4). Plan 8 passes `{ summary, sha, branch, runId, council, checks }`, where `council` is `build.council`: the council hook's result plus the `sha` it reviewed and `overridden`. Before asking, the gate checks:
   - the council ran (`council` present, and `builds/<runId>/council-report.json` exists and reads, Contract 7.5);
   - it reviewed exactly this commit (`council.sha === sha`);
   - it passed, or the operator overrode it through Plan 8's council escalation (`council.overridden === true`, which only an "approve" answer to that escalation sets);
   - the pipeline's own check passes (for an upgrade: no conflict markers left in the conflicted files at the approved commit).

   If any check fails, it does **not** ask. It calls `onRefused(reason)`, which the pipeline saves as `run.refusal`, and returns **`false`**. Plan 8 then ends the build as `rejected` with `main` unchanged, and the pipeline reports the real cause rather than "you rejected it". (It must not return `{ note }`: Plan 8 turns a note into an operator-feedback fix unit.)

   If the checks pass, it adds Plan 11's text (what happens next) to the summary and asks. The operator's answer goes back to Plan 8 unchanged unless it is exactly `true` (so the operator's own feedback note still becomes a fix unit). On exactly `true` it writes the approval record **before** returning `true`, so a crash straight after still knows what was approved.
2. **`shipProblem`** runs again before each deployment is touched (Task 8), from the saved record alone, because a resumed run did not see the gate.

**Files:**
- Create: `src/factory/change/gate.js`
- Test: `test/factory-change-gate.test.js`

**Interfaces:**
- Consumes:
  - Plan 8's `approveBuild` argument (Task 4) and `build.council` (`{ status: 'approved'|'approved-with-warnings'|'blocked'|'paused', text, sha, overridden? }`);
  - Plan 9's `builds/<runId>/council-report.json` (Plan 5 `CouncilReport` plus Plan 9's additions: `verdict`, `round`);
  - `git` from `src/workspace.js`.

  The check that the release commit touched only release files is Task 7's `releaseProblem`; `shipProblem` checks the approval and ancestry.
- Produces: `councilPassed`, `readCouncilReport`, `conflictMarkers`, `makeChangeGate`, `shipProblem`, and these exact texts:
  - `COUNCIL_MISSING = 'The full council did not review this change, so it cannot be shipped. Nothing was added to the app. Check that the council is set up (conductor doctor) and run the change again.'`
  - `COUNCIL_NOT_PASSED = 'The council still found problems that must be fixed, and you did not choose to ship anyway, so this change cannot be shipped. Nothing was added to the app.'`
  - `COUNCIL_OLDER_COMMIT = 'The council reviewed an earlier version of this change, not the one waiting for approval, so it cannot be shipped. Nothing was added to the app. Resume the change so the council reviews the final version.'`
  - `MARKERS_LEFT(files) = \`The foundation merge is not finished: these files still contain both versions side by side: ${files.join(', ')}. Nothing was added to the app.\``
  - `NOT_APPROVED_COMMIT = 'What reached the app is not exactly what you approved, so nothing was shipped. The approved work is still on its own branch in the app.'`
  - `NO_APPROVAL = 'There is no record that you approved this change, so nothing was shipped.'`
  - `APPROVAL_NOT_SAVED = 'Conductor could not record your approval, so the change was not added to the app. Resume the change to try again.'`

- [ ] **Step 1: Write the failing tests**

```js
const SHA = 'a'.repeat(40);
const council = (over = {}) => ({ status: 'approved', text: 'Council report: approved', sha: SHA, ...over });
const report = { verdict: 'approved', round: 1 };
const arg = (over = {}) => ({ summary: 'S', sha: SHA, branch: 'build/20261027-143205-a1b2', runId: '20261027-143205-a1b2', council: council(), checks: {}, ...over });

test('councilPassed: approved and approved-with-warnings pass; blocked passes only when overridden; missing or older never pass', () => {
  assert.deepEqual(councilPassed(council(), { sha: SHA, report }), { ok: true, overridden: false });
  assert.deepEqual(councilPassed(council({ status: 'approved-with-warnings' }), { sha: SHA, report }), { ok: true, overridden: false });
  assert.deepEqual(councilPassed(council({ status: 'blocked', overridden: true }), { sha: SHA, report }), { ok: true, overridden: true });
  assert.deepEqual(councilPassed(council({ status: 'blocked' }), { sha: SHA, report }), { ok: false, reason: COUNCIL_NOT_PASSED });
  assert.deepEqual(councilPassed(null, { sha: SHA, report }), { ok: false, reason: COUNCIL_MISSING });
  assert.deepEqual(councilPassed(council(), { sha: SHA, report: null }), { ok: false, reason: COUNCIL_MISSING });
  assert.deepEqual(councilPassed(council({ sha: 'b'.repeat(40) }), { sha: SHA, report }), { ok: false, reason: COUNCIL_OLDER_COMMIT });
  assert.deepEqual(councilPassed(council({ status: 'paused' }), { sha: SHA, report }), { ok: false, reason: COUNCIL_NOT_PASSED });
  assert.deepEqual(councilPassed(council({ status: 'something-new' }), { sha: SHA, report }), { ok: false, reason: COUNCIL_NOT_PASSED });
  assert.deepEqual(councilPassed(council({ status: 'blocked', overridden: 'yes' }), { sha: SHA, report }), { ok: false, reason: COUNCIL_NOT_PASSED });
});

test('readCouncilReport reads builds/<runId>/council-report.json; missing or damaged gives null', ...)

test('the gate refuses without asking when the council is missing, blocked or older, and returns false', async () => {
  for (const c of [null, council({ status: 'blocked' }), council({ sha: 'b'.repeat(40) })]) {
    const asked = []; const approved = []; const refused = [];
    const gate = makeChangeGate({ projectDir, approveBuild: async (a) => { asked.push(a); return true; }, extraText: () => 'X',
      check: async () => null, onApproved: async (r) => approved.push(r), onRefused: (why) => refused.push(why) });
    assert.equal(await gate(arg({ council: c })), false);
    assert.equal(asked.length, 0);
    assert.equal(approved.length, 0);
    assert.match(refused[0], /cannot be shipped/);
  }
});

test('the gate refuses without asking when the pipeline check fails (conflict markers left)', ...)
  // check: async () => MARKERS_LEFT(['apps/server/src/app.ts']) → false; onRefused got that text; not asked

test('passing checks: the operator sees the summary plus what happens next, and the approval is saved before true is returned', async () => {
  const order = [];
  const gate = makeChangeGate({ projectDir,
    approveBuild: async (a) => { order.push('asked'); assert.equal(a.summary, 'S\n\nIf you approve:\n  X'); return true; },
    extraText: () => 'X', check: async () => null, onRefused: () => {},
    onApproved: async (r) => { order.push('saved');
      assert.equal(r.sha, SHA); assert.equal(r.branch, 'build/20261027-143205-a1b2');
      assert.deepEqual(r.council, { status: 'approved', overridden: false, verdict: 'approved', round: 1 }); },
  });
  assert.equal(await gate(arg()), true);
  assert.deepEqual(order, ['asked', 'saved']);
});

test('anything but exactly true from the operator is passed back unchanged and nothing is saved', ...)
  // approveBuild returns { note: 'bold totals' } → gate returns that object (Plan 8 makes it a fix unit);
  // returns false → false; returns 'yes' → 'yes'; onApproved never called

test('an overridden council is approved but the summary says so in plain words', ...)
  // summary contains 'You chose to ship although the council still found problems.'

test('if saving the approval fails, the gate returns false and records APPROVAL_NOT_SAVED', ...)

test('conflictMarkers finds files that still hold <<<<<<< or >>>>>>> lines at a commit, ignoring ======= alone', async () => {
  // repo with a.md containing a lone '=======' line and b.ts containing '<<<<<<< ours' … '>>>>>>> theirs' lines, committed
  assert.deepEqual(await conflictMarkers(repo, sha, ['a.md', 'b.ts', 'gone.ts']), ['b.ts']);
});

test('shipProblem: refuses with no approval, an unapproved council, or a released commit that does not contain the approved one', async () => {
  // run without approval → NO_APPROVAL
  // approval.council { status: 'blocked', overridden: false } → COUNCIL_NOT_PASSED
  // approval.sha not an ancestor of run.release.sha in appDir → NOT_APPROVED_COMMIT
  // good run → null
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-gate.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/gate.js`**

- `councilPassed(council, { sha, report })`, in order:
  1. `council` not an object, or `report` null → `COUNCIL_MISSING`;
  2. `council.sha !== sha` → `COUNCIL_OLDER_COMMIT`;
  3. status `approved` or `approved-with-warnings` → ok;
  4. status `blocked` and `overridden === true` → ok with `overridden: true`;
  5. everything else → `COUNCIL_NOT_PASSED`.
- `readCouncilReport(projectDir, runId)`: `RUN_ID_RE` check, then read and parse `builds/<runId>/council-report.json`. Any failure gives `null`.
- `makeChangeGate({ projectDir, approveBuild, extraText, check, onApproved, onRefused, now = () => new Date() })` returns `async (arg)`:
  1. `report = readCouncilReport(projectDir, arg.runId)`; `councilPassed(arg.council, { sha: arg.sha, report })`. On failure: `onRefused(reason)`, return `false`.
  2. `const problem = await check(arg)`. If truthy: `onRefused(problem)`, return `false`.
  3. `summary = \`${arg.summary}\n\nIf you approve:\n  ${extraText(arg).split('\n').join('\n  ')}\``, plus `\nYou chose to ship although the council still found problems.` when overridden.
  4. `const answer = await approveBuild({ ...arg, summary })`. If `answer !== true`, return `answer`.
  5. `await onApproved({ sha: arg.sha, branch: arg.branch, at: now().toISOString(), council: { status, overridden, verdict: report.verdict, round: report.round } })`. The pipeline adds `expectedVersion`, `changelogLines` and `deployments` in its own `onApproved`. If it throws: `onRefused(APPROVAL_NOT_SAVED)`, return `false`.
  6. Return `true`.
- `conflictMarkers(dir, sha, files)`: for each file, `git show <sha>:<file>` (a missing file is skipped). A line matching `/^(<{7}|>{7})( |$)/m` marks it.
- `shipProblem(run, { appDir })`:
  1. `NO_APPROVAL` if `!run.approval?.sha`;
  2. the saved council: status `approved`/`approved-with-warnings`, or `blocked` with `overridden === true`, else `COUNCIL_NOT_PASSED`;
  3. `git merge-base --is-ancestor <approval.sha> <run.release.sha>` must exit 0, else `NOT_APPROVED_COMMIT`;
  4. return `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-gate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/gate.js test/factory-change-gate.test.js
git commit -m "feat(change): the change gate refuses without a passing or overridden council, and the ship guard

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
