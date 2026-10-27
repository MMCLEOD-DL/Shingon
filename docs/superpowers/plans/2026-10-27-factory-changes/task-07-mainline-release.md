# Task 7: Main line, changelog and release check

After the gate, the approved work is on its own branch in the app (the core's `land()` only ever creates a new branch). Shipping it needs three things, each checked so nothing unapproved slips in:

1. **The changelog lines** the operator saw at the gate are added in one commit on top of the approved commit, touching only `CHANGELOG.md`. The foundation's release script refuses to release with an empty `Unreleased` section, so this is required, and doing it in code (not by a model) keeps it exactly as shown.
2. **The app's `main` moves forward** from exactly the commit recorded when the run started to the changelog commit (index Ruling 8). If `main` moved, nothing moves.
3. **After Plan 10's release**, check that `main` now points at the release commit, that its tag `v<version>` points there too, that the version is the one shown at the gate, and that the release commit changed only release files.

**Files:**
- Create: `src/factory/change/mainline.js`
- Test: `test/factory-change-mainline.test.js`

**Interfaces:**
- Consumes: `git`, `Workspace` from `src/workspace.js`; `parseVersion` from Task 2; `makeProject`, `makeFoundation` from Task 1.
- Produces: `RELEASE_FILES`, `nextVersion`, `appMain`, `appCheckoutProblem`, `appVersionAt`, `addChangelogLines`, `commitChangelog`, `advanceMain`, `releaseProblem` (index), and these exact texts:
  - `MAIN_MOVED = 'The app changed while this change was being built (its main line is no longer where it was when the run started), so the change was not added. The approved work is safe on its own branch in the app; start the change again to build it on top of the newer app.'`
  - `APP_FOLDER_EDITED = 'The app folder has edits that were never committed, so Conductor did not touch it. Commit or remove them, then resume.'`
  - `NO_MAIN = 'The app has no main line (branch "main"), so Conductor cannot tell what is live. See docs/BUILDING-ON.md.'`
  - `` RELEASE_TOUCHED_CODE(files) = `The release step changed more than the version and changelog (${files.join(', ')}), so nothing was shipped.` ``
  - `` RELEASE_VERSION_DIFFERS(expected, got) = `The release came out as version ${got}, but you approved ${expected}, so nothing was shipped.` ``
  - `RELEASE_NOT_ON_MAIN = 'The release is not on the app\'s main line, so nothing was shipped.'`

- [ ] **Step 1: Write the failing tests**

```js
test('nextVersion: patch and minor bumps; pre-release and junk are refused', () => {
  assert.equal(nextVersion('0.2.3', 'patch'), '0.2.4');
  assert.equal(nextVersion('0.2.3', 'minor'), '0.3.0');
  assert.throws(() => nextVersion('0.2', 'minor'), /is not a version number/);
});
test('addChangelogLines adds under Unreleased, creates the section if missing, and does not add a line twice', () => {
  const t = '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-11-20\n- x\n';
  const once = addChangelogLines(t, ['- A.']);
  assert.equal(once, '# Changelog\n\n## [Unreleased]\n- A.\n\n## [0.2.0] - 2026-11-20\n- x\n');
  assert.equal(addChangelogLines(once, ['- A.']), once);
  assert.equal(addChangelogLines('# Changelog\n\n## [0.2.0] - 2026-11-20\n', ['- A.']), '# Changelog\n\n## [Unreleased]\n- A.\n\n## [0.2.0] - 2026-11-20\n');
});
test('commitChangelog: one commit on top of the approved commit, changing only CHANGELOG.md, in the app\'s object store', async () => {
  const sha = await commitChangelog({ appDir, sha: approved, lines: ['- Change (brief v3): added Mileage claims.'], scratchDir, message: 'changelog: brief v3' });
  assert.equal((await git(appDir, ['rev-parse', `${sha}^`])).stdout.trim(), approved);
  assert.deepEqual((await git(appDir, ['diff', '--name-only', approved, sha])).stdout.trim().split('\n'), ['CHANGELOG.md']);
  assert.equal(existsSync(scratchDir), false, 'the scratch clone is removed');
});
test('advanceMain moves main from exactly the recorded commit; with main checked out and clean the files follow', async () => {
  const r = await advanceMain({ appDir, from: mainAtStart, to: sha });
  assert.deepEqual(r, { ok: true });
  assert.equal(await appMain(appDir), sha);
  assert.equal((await git(appDir, ['status', '--porcelain'])).stdout, '');
  assert.match(readFileSync(path.join(appDir, 'CHANGELOG.md'), 'utf8'), /Mileage claims/);
});
test('advanceMain refuses when main moved since the run started, and changes nothing', async () => {
  // commit something else on main first
  assert.deepEqual(await advanceMain({ appDir, from: mainAtStart, to: sha }), { ok: false, reason: MAIN_MOVED });
  assert.equal(await appMain(appDir), movedSha);
});
test('advanceMain with another branch checked out moves main without touching the files on disk', ...)
test('appCheckoutProblem: uncommitted edits on main → APP_FOLDER_EDITED; no main → NO_MAIN; clean → null', ...)
test('advanceMain is safe to repeat: main already at the target is ok', ...)   // from: mainAtStart, to: sha, when main === sha → { ok: true }
test('releaseProblem accepts a release commit that changed only release files, tagged, on main, with the expected version', async () => {
  // simulate the foundation's release: raise package.json, package-lock.json, foundation.json to 0.3.0, move Unreleased, commit, tag v0.3.0, main → it
  assert.equal(await releaseProblem({ appDir, from: changelogSha, release: { version: '0.3.0', sha: rel }, expectedVersion: '0.3.0' }), null);
});
test('releaseProblem refuses: code changed, other version, not on main, tag missing or elsewhere', ...)
  // a release commit also touching apps/server/src/app.ts → RELEASE_TOUCHED_CODE(['apps/server/src/app.ts'])
  // version '0.3.1' vs expected '0.3.0' → RELEASE_VERSION_DIFFERS('0.3.0', '0.3.1')
  // main not at release.sha → RELEASE_NOT_ON_MAIN
  // tag v0.3.0 missing or pointing elsewhere → /the release tag v0\.3\.0 is not on the release/
  // release.sha not a descendant of from → RELEASE_NOT_ON_MAIN
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/factory-change-mainline.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `src/factory/change/mainline.js`**

- `RELEASE_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'foundation.json']`.
- `appMain`: `rev-parse --verify --quiet refs/heads/main^{commit}`, else throw `NO_MAIN`.
- `appCheckoutProblem`: `NO_MAIN` if no main; if `symbolic-ref -q HEAD` is `refs/heads/main` and `status --porcelain` is not empty → `APP_FOLDER_EDITED`; else `null`.
- `appVersionAt(appDir, sha)`: `git show <sha>:package.json`, parse, return `version`; throw plain-English if unreadable.
- `addChangelogLines(text, lines)`: find `## [Unreleased]`; insert each line not already present in that section directly after the heading, in order (keep a single blank line before the next `## [`); if the heading is missing, insert `## [Unreleased]\n<lines>\n\n` before the first `## [` (or at the end).
- `commitChangelog`: clone the app into `scratchDir`, `checkout -q -b factory/changelog <sha>`, edit `CHANGELOG.md` with `addChangelogLines`, commit with `message`. If nothing changed (resume after a crash) return `sha` itself. Fetch the commit into the app under a temporary ref and delete the ref afterwards (objects stay), as `land()` does; check `diff --name-only <sha> <new>` is exactly `CHANGELOG.md`; remove `scratchDir` in a `finally`.
- `advanceMain({ appDir, from, to })`:
  1. `const now = await appMain(appDir)`; if `now === to` return ok (repeat after a crash);
  2. if `now !== from` return `MAIN_MOVED`;
  3. `merge-base --is-ancestor <from> <to>` must hold, else `MAIN_MOVED`;
  4. `appCheckoutProblem` → return it;
  5. if `main` is checked out: `git merge --ff-only --quiet <to>`; otherwise `git update-ref refs/heads/main <to> <from>`; on failure return `MAIN_MOVED`.
- `releaseProblem({ appDir, from, release, expectedVersion })`: `appMain === release.sha` and `merge-base --is-ancestor from release.sha`, else `RELEASE_NOT_ON_MAIN`; `release.version === expectedVersion`; `appVersionAt(release.sha) === release.version`; `rev-parse refs/tags/v<version>^{commit}` equals `release.sha` (`` `the release tag v${version} is not on the release, so nothing was shipped.` `` capitalised as a sentence); `diff --name-only from release.sha` minus `RELEASE_FILES` must be empty, else `RELEASE_TOUCHED_CODE`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/factory-change-mainline.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/factory/change/mainline.js test/factory-change-mainline.test.js
git commit -m "feat(change): changelog commit, compare-and-swap move of main, release check"
```
