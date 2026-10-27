# Task 2: Foundation changelog reader additions

Conductor reads the foundation's `CHANGELOG.md` in two places: to say which `[security]` fixes a project is missing (Task 10), and to tell the operator what a foundation upgrade brings in (Task 6).

`src/factory/foundationLog.js` is **owned by Plan 10** (Contract 7.1). It holds the zero-dependency port of the foundation's `parseChangelog` and `securityFixesSince`, with `parseVersion` and `compareVersions`, pinned by Plan 10's parity tests. This task **extends** that file with three functions Plan 11 needs, and never redefines Plan 10's:
- `changesBetween(text, from, to)`: the sections a foundation upgrade brings in;
- `releaseTags(repoDir)`: the foundation's release tags, in version order, read without writing to the repo;
- `readChangelogAt(repoDir, tag)`: the foundation's changelog at a tag, read without writing to the repo.

They fail closed like Plan 10's reader: a heading `parseChangelog` does not understand **throws**, because a misread heading could hide a security fix.

**Files:**
- Modify: `src/factory/foundationLog.js` (add three exports; Plan 10's exports unchanged)
- Test: `test/factory-foundation-log-change.test.js` (new file; Plan 10's `foundationLog` tests stay as they are)

**Interfaces:**
- Consumes: `parseChangelog`, `compareVersions`, `parseVersion` (Plan 10, same file); `git` from `src/workspace.js`; `makeFoundation` and `refsOf` from Task 1's fixtures and `test/helpers/gitRepo.js`.
- Produces: `changesBetween`, `releaseTags`, `readChangelogAt` (signatures in the index).

- [ ] **Step 1: Write the failing tests**

```js
const LOG = `# Changelog

## [Unreleased]
- **[security]** not released yet

## [0.2.0] - 2026-11-20
- New reports page.

## [0.1.1] - 2026-11-02
- **[security]** Sessions now expire after 12 hours.
- Tidier audit page.

## [0.1.0] - 2026-10-26
- First foundation release.
`;

test('changesBetween returns the sections after from, up to and including to, oldest first, never Unreleased', () => {
  assert.deepEqual(changesBetween(LOG, '0.1.0', '0.2.0').map((s) => s.version), ['0.1.1', '0.2.0']);
  assert.deepEqual(changesBetween(LOG, '0.1.1', '0.1.1'), []);
  assert.deepEqual(changesBetween(LOG, '0.0.1', '0.1.0').map((s) => s.version), ['0.1.0']);
});
test('changesBetween throws Plan 10\'s message on a heading that is not understood', () => {
  assert.throws(() => changesBetween('## [0.1.1] - 2026-1-2\n- x\n', '0.1.0', '0.1.1'), /not in the expected form/);
});
test('changesBetween refuses a version that is not a version number', ...)   // 'v0.1.0' → /is not a version number/
test('releaseTags lists only vX.Y.Z tags in version order; readChangelogAt reads the file at a tag without touching the repo', async () => {
  const f = await makeFoundation({ versions: ['0.1.0', '0.1.1', '0.1.10'] });
  await git(f.dir, ['tag', 'v0.2.0-rc.1']); await git(f.dir, ['tag', 'nightly']);
  const before = await refsOf(f.dir);
  assert.deepEqual(await releaseTags(f.dir), ['v0.1.0', 'v0.1.1', 'v0.1.10']);
  assert.match(await readChangelogAt(f.dir, 'v0.1.1'), /\[security\]\*\* Sessions now expire/);
  assert.equal(await refsOf(f.dir), before);
});
test('releaseTags on a folder that is not a git repo throws a plain sentence naming the folder', ...)
  // /The foundation repository at .* could not be read/
test('readChangelogAt refuses a tag that is not a release name before running git', ...)
  // 'main', '-x', 'v0.1.1~1' → rejects /could not be read/ (the tag check runs first, so even a missing repo gives this message)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-foundation-log-change.test.js`
Expected: FAIL (the three exports do not exist yet).

- [ ] **Step 3: Implement the three functions in `src/factory/foundationLog.js`**

- `changesBetween(text, from, to)`:
  - both versions must pass `parseVersion`, else throw `` `"${v}" is not a version number such as 1.2.3.` `` (Plan 10's wording, if Plan 10 exports the message, use it);
  - `parseChangelog(text)` (throws on a bad heading), drop `Unreleased`;
  - keep sections with `compareVersions(v, from) > 0 && compareVersions(v, to) <= 0`, sorted oldest first.
- `releaseTags(repoDir)`: `git tag --list 'v*'`, keep `^v\d+\.\d+\.\d+$`, sort with `compareVersions` on the version without the `v`. A git failure throws `` `The foundation repository at ${repoDir} could not be read, so Conductor cannot tell which foundation releases exist.` ``
- `readChangelogAt(repoDir, tag)`: refuse a tag not matching `^v\d+\.\d+\.\d+$` before running git; then `git show <tag>:CHANGELOG.md`. Any failure throws `` `The foundation's CHANGELOG.md at ${tag} could not be read.` ``

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-foundation-log-change.test.js && npm test`
Expected: PASS, Plan 10's tests included.

- [ ] **Step 5: Commit**

```bash
git add src/factory/foundationLog.js test/factory-foundation-log-change.test.js
git commit -m "feat(change): foundation changes between versions, release tags and changelog at a tag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
