# Claude verification: PR97 closes T1 (workspace Git guard regression)

- **Finding:** T1 in [`2026-11-05-claude-review-PR80-82-windows-runtime.md`](2026-11-05-claude-review-PR80-82-windows-runtime.md). The `git-common-dir` comparison in `guardGitDir` was the only guard against Git falling through to an enclosing repository, but no test isolated it.
- **Fix verified:** [PR97](https://github.com/MMCLEOD-DL/Shingon/pull/97), merged as `c0be8b3` (code `f40cc72`). It adds a test-only regression, `conductor/test/workspace-enclosing-repo.test.js`. No production code or existing assertion changed.
- **What the test does:**
  - It puts a synthetic workspace inside another repository, deletes the workspace's `.git/HEAD`, and first proves that Git really does find the enclosing repository.
  - It then requires that `guardGitDir` refuse the workspace, that the workspace be poisoned (both `head()` and the direct Git wrapper refuse), and that both repositories' refs be unchanged.

## Checks (cloud Linux, Node 22.23.4, main at `69fdeea`)

- `node --test test/workspace-enclosing-repo.test.js test/workspace-native-identity.test.js test/workspace.test.js` from `conductor/`: 38 tests, 37 pass, 0 fail, 1 skipped (Windows-only).
- **Mutation control** (the same one as in T1): in a scratch copy, the realpath comparison is replaced with `sameDirectory = true`.
  - The new regression now fails, as does the existing fail-closed test: 35 pass, 2 fail.
  - Before PR97, the same mutation failed only the fail-closed test.

**Disposition: T1 closed.** Codex's native Windows evidence (5 pass, and its own mutation control with `if (false)`) is consistent with this result. It was not re-run here.
