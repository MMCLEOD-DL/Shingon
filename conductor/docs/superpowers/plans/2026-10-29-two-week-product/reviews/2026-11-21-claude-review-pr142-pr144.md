# Claude review: PR142 and PR144, release fixture writes without `sh`

- **Reviewed:** Codex's PR142 (`codex/native-release-fixture-writes`), with its code at `a49a68d`, merged as `d970ed9`. Also PR144 (`codex/native-release-fixture-evidence`), the inventory and evidence at `01bb025` and the submission at `185f5a6`, merged as `28334dd`. I reviewed them on `main` at `76387fa`, where `test/factory-release.test.js` and `src/factory/ship/release.js` are unchanged since `a49a68d`.
- **Requested by:** `work-log/2026-11-21-1438-codex-submitted-native-release-fixture-writes.md` ("Claude review invited through the shared ledger"). Malcolm asked for this review in chat on 21 November 2026. It is a post-merge review.
- **Host:** native Windows 11 Home 10.0.26300, Node v24.12.0. I used only synthetic fixtures and fake npm: no release, model, SSH or credential.
- **Disposition: no defect in PR142 or PR144.** One note (L1) answers the keyleak discrepancy that PR144 left open. It gives the exact environment difference and a reproduction. The fix belongs to Codex.

## What changed

- **PR142:** four `sh` file writes in `test/factory-release.test.js` became Node calls:
  - two `sh -c 'cat > CHANGELOG.md'` writes became `writeFileSync`;
  - `echo mine >> CHANGELOG.md` became `appendFileSync(…, 'mine\n')`;
  - `commitFiles`'s `cat > '<name>'` became `writeFileSync(path.join(dir, name), body)`.

  The bytes written are the same in each case. No assertion or product source changed.
- **PR144:** inventory rows W115, W119, W120 and W125–W127 move to FIXED_NATIVE, with a new checkpoint section in `windows-failure-inventory-2026-11-19.md`.

## Reproduced

`node --test test/factory-release.test.js` from `conductor`: **18/18 pass**, 0 skipped.

I applied each mutation to `src/factory/ship/release.js` in a scratch worktree at `76387fa`, ran the release file, then reverted it. The worktree was removed afterwards and the checkout is untouched.

| Mutation | Result | Caught by |
|---|---|---|
| R1 the stray-file check (Ruling S20) is off | 16 pass / 2 fail | W119, and the trimmed-name test |
| R2 the commit-count check is off | 17 / 1 | W119 |
| R3 `releaseApp` ignores `releaseCommitProblem` | 17 / 1 | W125 (package scripts edited) |
| R4 `releaseCommitProblem` always returns null | 15 / 3 | W125, W126 (untagged dependency change not adopted), W127 (tag changed more than the version) |
| R5 the crash tidy resets even when the operator has edits | 17 / 1 | W120 (`mine` must survive) |

The rewritten tests check the behaviour the submission names: unexpected-file and extra-commit refusal, script and dependency refusal, and crash recovery that keeps operator edits. W115 checks the changelog move. I did not mutate it, because its one fixture change writes the same bytes as before.

## L1 (low, Codex): why the keyleak test fails on some Windows hosts

Codex could not reproduce the native `keyleak.test.js` failure from the PR140 handoff. The cause is the environment variable **`NoDefaultCurrentDirectoryInExePath`**.

- **Trigger:** the test's Windows `testCommand` is the bare name `leak-check.cmd`. `cmd` finds a bare name in the current directory only when `NoDefaultCurrentDirectoryInExePath` is unset. Claude Code sessions on this host set it to `1`. `strictChildEnv` passes it through, because the name does not look secret.
- **Consequence:** the baseline test run prints `'leak-check.cmd' is not recognized as an internal or external command`. The run then stops with "The configured tests already fail or could not run before any changes", and the test fails with `status` `stopped`, expected `landed`. None of the redaction assertions run.
- **Reproduction**, from `conductor` in Git Bash, at `76387fa`:
  - `env -u NoDefaultCurrentDirectoryInExePath node --test test/keyleak.test.js`: **1/1 pass**.
  - `NoDefaultCurrentDirectoryInExePath=1 node --test test/keyleak.test.js`: **0/1**, as above.

  That explains Codex's passes and the peer's failures without any code difference.
- **Scope:** a search of `conductor/test` finds no other test that runs a bare `.cmd` or `.bat` name as a command.
- **Suggested fix (Codex's call):**
  - Give the fixture's command a path, for example `.\leak-check.cmd`, and add an inventory row.
  - Separately, decide whether a configured test command should be documented to need a path on Windows. An operator whose command is a bare script name would hit the same baseline stop whenever Conductor inherits this variable.

## Not covered here

- I did not rerun the full native suite for this review. Codex reports 1,744 total, 1,677 pass, 66 fail and 1 skip at `a49a68d`.
- Linux: the code-head and final-head required checks were green at merge, according to the submission and the PR checks.
