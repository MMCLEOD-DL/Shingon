# Task 6: Foundation upgrade merge

`conductor foundation-upgrade <slug> --to <tag>` brings a newer foundation release into an app (spec §5; `docs/BUILDING-ON.md` "Taking foundation fixes"). This task does the git side, before any model is called:

1. **Check the target:** the tag is a release tag `vX.Y.Z`, exists in the foundation repo, and is newer than the project's recorded tag.
2. **Merge in a scratch clone** of the app (`builds/<runId>/merge/`), never in the app folder itself: fetch the tag's commit **from** the foundation repo (read-only), check the app shares history with the foundation, and `git merge --no-ff --no-commit`.
3. **Settle what is mechanical** (index Ruling 5): `foundation.json` takes the foundation's, `CHANGELOG.md` keeps the app's, and `package.json`/`package-lock.json` conflict hunks that are only the `"version"` line keep the app's.
4. **Stop on what cannot be resolved by editing text:** delete-versus-edit and binary conflicts. Nothing is changed in the app.
5. **Commit the merge**, with conflict markers left in the remaining files, on a new branch `factory/upgrade-<tag>-<runId>` that is landed into the app create-only (the core's `land()`; the app's `main` is not touched). The build then starts from that branch (Task 4 `baseRef`).

It also produces the single build item for Plan 8's loop and the changelog lines.

**Files:**
- Create: `src/factory/change/upgradeMerge.js`
- Test: `test/factory-upgrade-merge.test.js`

**Interfaces:**
- Consumes: `git`, `Workspace` (for `land()`) from `src/workspace.js`; `releaseTags`, `compareVersions` from Task 2; `makeFoundation`, `makeProject` from Task 1.
- Produces: `MAX_CONFLICT_FILES`, `upgradeTargetProblem`, `resolveVersionHunks`, `prepareUpgradeMerge`, `upgradeItem`, `upgradeChangelogLines` (index), and these exact texts:
  - `` `The foundation has no release called ${toTag}. Releases available: ${tags.join(', ')}.` ``
  - `` `${toTag} is not a foundation release name. Use the form v1.2.3.` ``
  - `` `This app is already on the foundation's ${fromTag}.` `` / `` `${toTag} is older than the foundation release this app is on (${fromTag}). Conductor does not move apps back to older foundation releases.` ``
  - `NOT_FROM_FOUNDATION = 'This app does not share any history with the foundation, so the foundation release cannot be merged into it. It may not have been cloned from a foundation release tag (see docs/BUILDING-ON.md).'`
  - `UNRESOLVABLE(list)` = `` `The foundation release cannot be merged automatically. ${list} A person needs to decide each of these, so nothing was changed in the app.` `` where each entry is `"<file>: the app deleted it but the foundation changed it."`, `"<file>: the foundation deleted it but the app changed it."` or `"<file>: both changed this file and it is not text."`.

- [ ] **Step 1: Write the failing tests**

Fixtures: `makeFoundation({ versions: ['0.1.0', '0.1.1'] })`, `makeProject({ foundation, tag: 'v0.1.0' })`. Give the app its own history first (a release commit raising `package.json`/`package-lock.json`/`foundation.json` to `0.2.0` and a `## [0.2.0]` changelog section, plus an app feature file), so the version and changelog conflicts are real.

```js
test('upgradeTargetProblem: not a release name, missing, same, older; null for a newer release', () => {
  const tags = ['v0.1.0', 'v0.1.1', 'v0.2.0'];
  assert.match(upgradeTargetProblem({ fromTag: 'v0.1.0', toTag: '0.1.1', tags }), /not a foundation release name/);
  assert.match(upgradeTargetProblem({ fromTag: 'v0.1.0', toTag: 'v0.3.0', tags }), /no release called v0\.3\.0\. Releases available: v0\.1\.0, v0\.1\.1, v0\.2\.0\./);
  assert.match(upgradeTargetProblem({ fromTag: 'v0.1.1', toTag: 'v0.1.1', tags }), /already on/);
  assert.match(upgradeTargetProblem({ fromTag: 'v0.2.0', toTag: 'v0.1.1', tags }), /older than/);
  assert.equal(upgradeTargetProblem({ fromTag: 'v0.1.0', toTag: 'v0.1.1', tags }), null);
});

test('resolveVersionHunks keeps the app side of a hunk that is only the version line, and leaves any other hunk', () => {
  const text = '{\n<<<<<<< HEAD\n  "version": "0.2.0",\n=======\n  "version": "0.1.1",\n>>>>>>> v0.1.1\n  "x": 1,\n<<<<<<< HEAD\n  "a": 1\n=======\n  "b": 2\n>>>>>>> v0.1.1\n}\n';
  const r = resolveVersionHunks(text);
  assert.equal(r.remaining, 1);
  assert.match(r.text, /^\{\n  "version": "0\.2\.0",\n  "x": 1,\n<<<<<<< HEAD/);
});

test('a clean upgrade with only mechanical conflicts: merge committed on a new branch, no conflicts left, app main untouched', async () => {
  const before = (await git(appDir, ['rev-parse', 'main'])).stdout.trim();
  const r = await prepareUpgradeMerge({ appDir, foundationRepo: f.dir, fromTag: 'v0.1.0', toTag: 'v0.1.1', runId: 'upgrade-20261027-143205', scratchDir });
  assert.equal(r.status, 'ready');
  assert.equal(r.branch, 'factory/upgrade-v0.1.1-upgrade-20261027-143205');
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.autoResolved.sort(), ['CHANGELOG.md', 'foundation.json', 'package-lock.json', 'package.json']);
  assert.equal(r.mainAtStart, before);
  assert.equal((await git(appDir, ['rev-parse', 'main'])).stdout.trim(), before);
  assert.equal((await git(appDir, ['rev-parse', `refs/heads/${r.branch}`])).stdout.trim(), r.mergeSha);
  const show = (p) => git(appDir, ['show', `${r.mergeSha}:${p}`]).then((x) => x.stdout);
  assert.equal(JSON.parse(await show('package.json')).version, '0.2.0', 'the app keeps its own version');
  assert.equal(JSON.parse(await show('foundation.json')).version, '0.1.1', 'foundation.json records the foundation release');
  assert.match(await show('CHANGELOG.md'), /## \[0\.2\.0\]/);
  assert.equal((await git(appDir, ['rev-parse', `${r.mergeSha}^1`])).stdout.trim(), before, 'first parent is the app main');
  assert.equal((await git(appDir, ['rev-parse', `${r.mergeSha}^2`])).stdout.trim(), f.tagSha('v0.1.1'));
});

test('a real code conflict is committed with its markers and named for the loop', ...)
  // both the app and v0.1.1 edit the same line of apps/server/src/app.ts
  // r.conflicts deepEqual ['apps/server/src/app.ts']; the file at r.mergeSha contains '<<<<<<< ' and '>>>>>>> '

test('delete-versus-edit stops with a plain list and changes nothing in the app', async () => {
  // the app deleted docs/RUNBOOK.md; v0.1.1 edits it
  const refs = await refsOf(appDir);
  const r = await prepareUpgradeMerge({ … });
  assert.equal(r.status, 'stopped');
  assert.match(r.reason, /docs\/RUNBOOK\.md: the app deleted it but the foundation changed it\./);
  assert.match(r.reason, /nothing was changed in the app\.$/);
  assert.equal(await refsOf(appDir), refs);
});

test('a binary file changed on both sides stops the same way', ...)          // /both changed this file and it is not text/
test('an app with no shared history with the foundation is refused', ...)    // NOT_FROM_FOUNDATION; app refs unchanged
test('the foundation repo is never written', ...)                             // refsOf(f.dir) and `git status --porcelain` unchanged after a ready run
test('upgradeItem names every conflicted file and lists what the foundation changed', () => {
  const item = upgradeItem({ fromTag: 'v0.1.0', toTag: 'v0.1.1', conflicts: ['apps/server/src/app.ts'], changes: [{ version: '0.1.1', lines: ['**[security]** Sessions now expire after 12 hours.'] }] });
  assert.equal(item.id, 'foundation-upgrade-v0-1-1');
  assert.equal(item.change, 'foundation-upgrade');
  assert.match(item.story, /apps\/server\/src\/app\.ts/);
  assert.match(item.story, /keep both the foundation's fix and the app's own behaviour/);
  assert.match(item.story, /npm run verify/);
  assert.match(item.story, /Do not edit the foundation's own files beyond resolving the conflicts/);
});
test('upgradeChangelogLines: one upgrade line plus each security fix, marked so the app\'s own changelog records it', () => {
  assert.deepEqual(upgradeChangelogLines({ fromTag: 'v0.1.0', toTag: 'v0.1.1', security: [{ version: '0.1.1', lines: ['Sessions now expire after 12 hours.'] }] }), [
    '- Foundation upgraded from v0.1.0 to v0.1.1.',
    '- **[security]** Sessions now expire after 12 hours. (foundation 0.1.1)',
  ]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-upgrade-merge.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/upgradeMerge.js`**

- `upgradeTargetProblem`: check the name form first (`^v\d+\.\d+\.\d+$`), then membership in `tags`, then `compareVersions` against `fromTag`.
- `prepareUpgradeMerge`:
  1. `git clone --quiet --no-hardlinks <appDir> <scratchDir>`; `checkout -q -b <branch> refs/remotes/origin/main`; record `mainAtStart`; `remote remove origin`.
  2. `git fetch --quiet --no-tags <foundationRepo> refs/tags/<toTag>:refs/foundation/<toTag>`, then resolve `refs/foundation/<toTag>^{commit}`.
  3. `git merge-base HEAD <tagSha>` must succeed, else `NOT_FROM_FOUNDATION`.
  4. `git merge --no-ff --no-commit -m "foundation: merge <toTag>" <tagSha>`. Exit 0: nothing conflicted.
  5. Classify unmerged paths with `git ls-files -u -z` (stage 2 = app, stage 3 = foundation). A path missing stage 2 or 3 is delete-versus-edit. A path with both but whose working copy has no `<<<<<<<` line is binary. Any of these → `UNRESOLVABLE` (remove the scratch folder) and return `stopped`.
  6. Mechanical rules: `git checkout --theirs -- foundation.json`, `git checkout --ours -- CHANGELOG.md`, `resolveVersionHunks` on `package.json` and `package-lock.json` (fully resolved files go to `autoResolved`, others stay as conflicts). `git add` the resolved ones.
  7. The remaining files are `conflicts`. `git add -A`, then commit `foundation: merge <toTag>` (or `… (N files need their conflicts resolved: a, b)`), keeping both parents (`git commit --no-edit -m`).
  8. `new Workspace(scratchDir, branch, mainAtStart).land({ repoDir: appDir, branch, sha: mergeSha })`; any failure → `stopped` with `` `Conductor could not add the foundation merge to the app: ${error}. Nothing else was changed.` ``
  9. Remove the scratch folder and return `ready`.
- `resolveVersionHunks`: scan for `<<<<<<< …` / `=======` / `>>>>>>> …` blocks; a block whose two sides, trimmed, each match `/^"version":\s*"[^"]*",?$/` becomes the ours side; others are left as they are and counted.
- `upgradeItem({ fromTag, toTag, conflicts, changes })`: `id` `foundation-upgrade-<toTag with dots as dashes, no v>`, `title` `Upgrade the foundation to <toTag>`, `change: 'foundation-upgrade'`, `roles: []`, `data: []`, `acceptance: [{ given: 'the upgraded app', when: 'npm run verify and the browser tests run', then: 'they pass, and the role-crossing report shows no failures' }]`. The story lists the foundation's changelog lines (`changes`), then either "These files contain both versions side by side: …; keep both the foundation's fix and the app's own behaviour in each" or "The merge had no conflicts: check the app still builds and passes its tests", then "Do not edit the foundation's own files beyond resolving the conflicts."
- `upgradeChangelogLines`: as in the test.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-upgrade-merge.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/upgradeMerge.js test/factory-upgrade-merge.test.js
git commit -m "feat(change): merge a foundation release into an app on its own branch, with mechanical rules"
```
