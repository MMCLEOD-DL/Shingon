# Claude review: PR80, PR81, PR82 (5 November Windows runtime fixes)

- **Reviewed (merged; post-merge review):**

  | PR | Merge | Change |
  |---|---|---|
  | [80](https://github.com/MMCLEOD-DL/Shingon/pull/80) | `f091777` | The agentic connection check runs as `grunt` (executor), not `reviewer` |
  | [81](https://github.com/MMCLEOD-DL/Shingon/pull/81) | `04dd0f5` | `workspace.js` compares Git's common dir and the workspace `.git` by native realpath, and fails closed if either cannot be resolved |
  | [82](https://github.com/MMCLEOD-DL/Shingon/pull/82) | `b68e3b0` | `runCommand` no longer detaches children on Windows (cmd.exe lost inherited output handles); POSIX keeps its process group |

  Requested as "independent Claude/Malcolm review" in Codex's 5 November submissions. PR77, PR83 and PR84 are evidence reports from live native runs. I cannot reproduce them here, and they change no code, so they are not reviewed.
- **Disposition: no defects. One test gap (T1, low-medium) on the `workspace.js` guard, which is a high-risk path.**

## What holds

- **PR80:** `grunt` is a defined role for every adapter (`roles.js`). The agentic check now asks the model to *execute* a bounded write, which is what it measures. The read-only check stays `reviewer`.
- **PR81:**
  - Both sides use `realpathSync.native`, so Windows profile redirection and 8.3 or case differences compare on the OS identity.
  - A resolution failure leaves `sameDirectory = false`, which poisons the workspace. Two unresolvable but equal strings no longer pass.
  - A real `.git` directory, planted `commondir`/`config.worktree`, and a linked `.git` are still handled by the earlier checks.
- **PR82:** on Windows, cancellation is `taskkill /PID … /T /F` on the tracked PID, which does not need a detached group. POSIX still detaches, so `process.kill(-pid)` reaches the whole tree.

## T1 (low-medium, test gap): the Git common-dir comparison is load-bearing, but no test isolates it

- **What it protects:** if an agent breaks the workspace's own `.git`, for example by deleting `.git/HEAD`, Git no longer recognises it and searches parent folders. If the workspace base is inside another repository, Git commands would then run against that enclosing repository. The other guards don't see this, because `.git` is still a real directory with no planted redirect files. Only the `git-common-dir` comparison catches it.
- **Reproduction:** [`fixtures/pr81-enclosing-repository.mjs`](fixtures/pr81-enclosing-repository.mjs) uses synthetic repos. The workspace base is inside a repo with one commit, and the workspace's `.git/HEAD` is deleted.
  - **main:** `guardGitDir` reports "the workspace git directory was tampered with". The workspace is poisoned, and `head()` refuses to run Git.
  - **With the comparison forced to true:** `guardGitDir` accepts it, and `head()` returns the *enclosing* repository's HEAD, so Git ran against the wrong repository.
- **Gap:** with that same mutation, `test/workspace.test.js`, `workspace-native-identity.test.js`, `conductor.test.js` and `chunkPhase.test.js` give 135 pass and 1 fail. The only failure is the fail-closed resolution test. Nothing checks that a real mismatch is refused.
- **Proposed correction (Codex, test-only):** add the scenario above as a regression in `test/workspace-native-identity.test.js` or `test/workspace.test.js`. This is not a defect in PR81, which keeps the protection working. The gap predates it.

## Checks (cloud Linux, Node 22.23.4, main at `5d7973a`; code unchanged since `40b8388`)

- **The three PRs' own tests:** `hidden-children`, `service/probe`, `test-command-output`, `workspace-native-identity`: 13 pass, 0 fail, 2 skipped (Windows-only).
- **All test files that exercise the tamper guard:** `chunkPhase`, `conductor`, `workspace-native-identity`, `workspace`: 136 pass, 0 fail, 1 skipped.
- **Mutation control** as above.

## Not verified here

Native Windows: profile redirection, cmd.exe output inheritance without detaching, and the agentic probe against real CLIs. Codex's native runs are the evidence for those. No live models.
