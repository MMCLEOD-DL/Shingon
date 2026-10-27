# Task 2: Foundation changelog reader

Conductor needs to read the foundation's `CHANGELOG.md` in two places: to say which `[security]` fixes a project is missing (Task 10), and to tell the operator what a foundation upgrade brings in (Task 6). The foundation's own reader (`scripts/changelog.ts`) is TypeScript and uses `semver`, which zero-dependency Conductor cannot load (index Ruling 12). This task ports it to plain JS, **with the foundation's own messages**, and adds two git helpers that read the foundation repo without writing to it.

The port must fail closed exactly like the original: a heading it does not understand **throws**, because a misread heading could hide a security fix.

**Files:**
- Create: `src/factory/foundationLog.js`
- Test: `test/factory-foundation-log.test.js`

**Interfaces:**
- Consumes: `git` from `src/workspace.js`; `makeFoundation` from Task 1's fixtures.
- Produces: `parseVersion`, `compareVersions`, `parseChangelog`, `securityFixesSince`, `changesBetween`, `releaseTags`, `readChangelogAt` (signatures in the index).

- [ ] **Step 1: Write the failing tests**

```js
const LOG = `# Changelog

## [Unreleased]
- **[security]** not released yet

## [0.2.0] - 2026-11-20
- New reports page.

## [0.1.1] - 2026-11-02
- **[security]** Sessions now expire after 12 hours.
- * **[ Security ]** Password reset links can be used once.
- Tidier audit page.

## [0.1.0] - 2026-10-26
- First foundation release.
`;

test('securityFixesSince matches the foundation: newer released versions with a [security] line, newest first, marker removed', () => {
  assert.deepEqual(securityFixesSince(LOG, '0.1.0'), [
    { version: '0.1.1', lines: ['Sessions now expire after 12 hours.', 'Password reset links can be used once.'] },
  ]);
  assert.deepEqual(securityFixesSince(LOG, '0.1.1'), []);
});
test('Unreleased is never counted as a fix the project is missing', ...)   // securityFixesSince(LOG, '0.0.1') has no 'Unreleased'
test('a heading that is not understood throws the foundation\'s message', () => {
  assert.throws(() => parseChangelog('## [0.1.1] - 2026-1-2\n- x\n'),
    { message: 'CHANGELOG.md has a heading that is not in the expected form: "## [0.1.1] - 2026-1-2". Use "## [1.2.3] - 2026-01-31" (a two-digit month and day) or "## [Unreleased]".' });
  assert.throws(() => parseChangelog('## [banana]\n'), /a version that is not a version number: "## \[banana\]"/);
});
test('securityFixesSince refuses a version that is not a version number', ...)   // '"v0.1.0" is not a version number such as 1.2.3.'
test('compareVersions follows semver precedence, including pre-releases', () => {
  assert.equal(compareVersions('0.1.10', '0.1.9'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.throws(() => compareVersions('1.0', '1.0.0'));
});
test('changesBetween returns the sections after from, up to and including to, oldest first', ...)
  // changesBetween(LOG, '0.1.0', '0.2.0').map(s => s.version) deepEqual ['0.1.1', '0.2.0']
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
```

Copy the three foundation messages verbatim from `/root/highland-foundation/scripts/changelog.ts` (heading form, version heading, invalid version).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-foundation-log.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/foundationLog.js`**

- `parseVersion`: `/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/`; numeric pre-release identifiers become numbers.
- `compareVersions`: major, minor, patch; a version without pre-release is higher than one with; identifiers compared left to right (numbers numerically and below strings; strings by code point); a shorter list is lower when all earlier ones are equal.
- `parseChangelog`, `securityFixesSince`: the same heading regex, the same `[security]` regex (`/^\s*[-*+]\s*\*\*\[\s*security\s*\]\*\*\s*/i`) and the same splitting as the TypeScript; "valid version" means `parseVersion` is not null.
- `releaseTags(repoDir)`: `git tag --list 'v*'`, keep `^v\d+\.\d+\.\d+$`, sort with `compareVersions`. A git failure throws `` `The foundation repository at ${repoDir} could not be read, so Conductor cannot tell which foundation releases exist.` ``
- `readChangelogAt(repoDir, tag)`: `git show <tag>:CHANGELOG.md`; refuse a tag not matching `^v\d+\.\d+\.\d+$` before running git; failure throws `` `The foundation's CHANGELOG.md at ${tag} could not be read.` ``

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-foundation-log.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/foundationLog.js test/factory-foundation-log.test.js
git commit -m "feat(change): read the foundation's changelog and release tags (port of securityFixesSince)"
```
