# Task 5: The change gate and ship guard

This task enforces the safety rule: **a change never ships without a passing council or an explicit operator override** (index Ruling 7). It does so in two places.

1. **`makeChangeGate`** wraps the operator's gate hook that Plan 8's loop calls after the council. Before asking, it checks:
   - the council report exists;
   - the council passed, or the operator overrode it through the council escalation (`report.overridden === true`, which only the core's "approve" answer to the council escalation sets);
   - the pipeline's own check passes (for an upgrade: no conflict markers left in the conflicted files at the approved commit).

   If any check fails, it does **not** ask. It returns `{ note: <reason> }`, which the core treats as "not approved", and saves the reason as `run.refusal` so the pipeline reports the real cause rather than "you rejected it". If the checks pass, it adds Plan 11's text (what happens next) to the summary and asks. On exactly `true` it writes the approval record **before** returning `true`, so a crash straight after landing still knows what was approved.
2. **`shipProblem`** runs again before the first deployment is touched (Task 8), from the saved record alone, because a resumed run did not see the gate.

**Files:**
- Create: `src/factory/change/gate.js`
- Test: `test/factory-change-gate.test.js`

**Interfaces:**
- Consumes:
  - the core gate argument `{ summary, files, tests, finalReview, diff, council, sha }` (Task 4 added `sha`);
  - `CouncilReport` from Plan 5/9 (`verdict`, `overridden`, `round`);
  - `git` from `src/workspace.js`. (The check that the release commit touched only release files is Task 7's `releaseProblem`; `shipProblem` checks the approval and ancestry.)
- Produces: `councilPassed`, `conflictMarkers`, `makeChangeGate`, `shipProblem`, and these exact texts:
  - `COUNCIL_MISSING = 'The full council did not review this change, so it cannot be shipped. Nothing was added to the app. Check that the council is set up (conductor doctor) and run the change again.'`
  - `COUNCIL_NOT_PASSED = 'The council still found problems that must be fixed, and you did not choose to ship anyway, so this change cannot be shipped. Nothing was added to the app.'`
  - `MARKERS_LEFT(files) = \`The foundation merge is not finished: these files still contain both versions side by side: ${files.join(', ')}. Nothing was added to the app.\``
  - `NOT_APPROVED_COMMIT = 'What reached the app is not exactly what you approved, so nothing was shipped. The approved work is still on its own branch in the app.'`
  - `NO_APPROVAL = 'There is no record that you approved this change, so nothing was shipped.'`

- [ ] **Step 1: Write the failing tests**

```js
const report = (over = {}) => ({ round: 1, verdict: 'approved', overridden: false, blocking: [], warnings: [], text: 'Council report: approved', ...over });
const arg = (over = {}) => ({ summary: 'S', files: ['a.ts'], diff: '', council: report(), sha: 'a'.repeat(40), ...over });

test('councilPassed: approved and approved-with-warnings pass; blocked passes only when overridden; missing never passes', () => {
  assert.deepEqual(councilPassed(report()), { ok: true, overridden: false });
  assert.deepEqual(councilPassed(report({ verdict: 'approved-with-warnings' })), { ok: true, overridden: false });
  assert.deepEqual(councilPassed(report({ verdict: 'blocked', overridden: true })), { ok: true, overridden: true });
  assert.deepEqual(councilPassed(report({ verdict: 'blocked' })), { ok: false, reason: COUNCIL_NOT_PASSED });
  assert.deepEqual(councilPassed(null), { ok: false, reason: COUNCIL_MISSING });
  assert.deepEqual(councilPassed(report({ verdict: 'something-new' })), { ok: false, reason: COUNCIL_NOT_PASSED });
  assert.deepEqual(councilPassed(report({ verdict: 'blocked', overridden: 'yes' })), { ok: false, reason: COUNCIL_NOT_PASSED });
});

test('the gate refuses without asking when the council is missing or blocked', async () => {
  for (const council of [null, report({ verdict: 'blocked' })]) {
    const asked = [];
    const approved = [];
    const gate = makeChangeGate({ approveResult: async (a) => { asked.push(a); return true; }, extraText: () => 'X', check: async () => null, onApproved: async (r) => approved.push(r) });
    const out = await gate(arg({ council }));
    assert.equal(asked.length, 0);
    assert.equal(approved.length, 0);
    assert.match(out.note, /cannot be shipped/);
  }
});

test('the gate refuses without asking when the pipeline check fails (conflict markers left)', ...)
  // check: async () => MARKERS_LEFT(['apps/server/src/app.ts']) → out.note === that text, not asked

test('passing checks: the operator sees the summary plus what happens next, and the approval is saved before true is returned', async () => {
  const order = [];
  const gate = makeChangeGate({
    approveResult: async (a) => { order.push('asked'); assert.equal(a.summary, 'S\n\nIf you approve:\n  X'); return true; },
    extraText: () => 'X', check: async () => null,
    onApproved: async (r) => { order.push('saved'); assert.equal(r.sha, 'a'.repeat(40)); assert.deepEqual(r.council, { verdict: 'approved', overridden: false, round: 1 }); },
  });
  assert.equal(await gate(arg()), true);
  assert.deepEqual(order, ['asked', 'saved']);
});

test('anything but exactly true from the operator is passed back unchanged and nothing is saved', ...)
  // approveResult returns { note: 'not yet' } → gate returns { note: 'not yet' }; returns 'yes' → returns 'yes'; onApproved never called

test('an overridden council is approved but the summary says so in plain words', ...)
  // summary contains 'You chose to ship although the council still found problems.'

test('if saving the approval fails, the gate does not return true', ...)
  // onApproved throws → gate returns { note: /could not record your approval/ }

test('conflictMarkers finds files that still hold <<<<<<< or >>>>>>> lines at a commit, ignoring ======= alone', async () => {
  // repo with a.md containing a lone '=======' line and b.ts containing '<<<<<<< ours' … '>>>>>>> theirs' lines, committed
  assert.deepEqual(await conflictMarkers(repo, sha, ['a.md', 'b.ts', 'gone.ts']), ['b.ts']);
});

test('shipProblem: refuses with no approval, an unapproved council, or a released commit that does not contain the approved one', async () => {
  // run without approval → NO_APPROVAL
  // approval.council { verdict: 'blocked', overridden: false } → COUNCIL_NOT_PASSED
  // approval.sha not an ancestor of run.release.sha in appDir → NOT_APPROVED_COMMIT
  // good run → null
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-gate.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/gate.js`**

- `councilPassed(report)`: `null`/non-object → `COUNCIL_MISSING`; verdict `approved` or `approved-with-warnings` → ok; verdict `blocked` and `overridden === true` → ok with `overridden: true`; everything else → `COUNCIL_NOT_PASSED`.
- `makeChangeGate({ approveResult, extraText, check, onApproved })` returns `async (arg)`:
  1. `councilPassed(arg.council)`; on failure return `{ note: reason }`;
  2. `const problem = await check(arg)`; if truthy return `{ note: problem }`;
  3. `summary = \`${arg.summary}\n\nIf you approve:\n  ${extraText(arg).split('\n').join('\n  ')}\``, plus `\nYou chose to ship although the council still found problems.` when overridden;
  4. `const answer = await approveResult({ ...arg, summary })`; if `answer !== true` return `answer`;
  5. `await onApproved({ sha: arg.sha, at: new Date().toISOString(), council: { verdict, overridden, round } })` — the pipeline adds `expectedVersion`, `changelogLines` and `deployments` in its own `onApproved`; if it throws return `{ note: 'Conductor could not record your approval, so the change was not added to the app. Run the change again.' }`;
  6. return `true`.
- `conflictMarkers(dir, sha, files)`: for each file, `git show <sha>:<file>` (a missing file is skipped); a line matching `/^(<{7}|>{7})( |$)/m` marks it.
- `shipProblem(run, { appDir })`: `NO_APPROVAL` if `!run.approval?.sha`; `councilPassed({ verdict: run.approval.council?.verdict, overridden: run.approval.council?.overridden })`; `git merge-base --is-ancestor <approval.sha> <run.release.sha>` must exit 0, else `NOT_APPROVED_COMMIT`; return `null`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-gate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/gate.js test/factory-change-gate.test.js
git commit -m "feat(change): the change gate refuses without a passing or overridden council, and the ship guard"
```
