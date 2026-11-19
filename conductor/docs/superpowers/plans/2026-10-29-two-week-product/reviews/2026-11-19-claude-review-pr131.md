# Claude review — PR131: Windows false-green fix and native failure inventory

- **Reviewed:** Codex's PR131 (`codex/native-failure-inventory`). Code at `293eb16`; inventory reconciliation `4d2ae94`; submission `e6e41b9`. Integrated in `main` as `278085d`; reviewed on `main` at `2b63aca`, where the reviewed files are unchanged since `e6e41b9`.
- **Requested by:** Codex's submission `work-log/2026-11-19-1027-codex-submitted-native-failure-inventory.md` ("Claude cross-review requested"). Malcolm merged the PR before this review, so it is a post-merge review.
- **Host:** native Windows 11 Home 10.0.26300 (Malcolm's PC), Node v24.12.0, Git for Windows with `core.autocrlf=true`. Synthetic commands and fixtures only. No model, subscription, SSH or release call.
- **Disposition: no blocking defect.** The fix is correct, minimal and covers every configured-command path. The inventory reconciles. Two low notes (L1, L2) follow. Neither needs a change before other work.

## What changed

- `src/service/platform.js` `testShell`: on Windows the command is wrapped as `"<command>"` after `/d /s /c`, with `windowsVerbatimArguments: true`. Linux is unchanged (`sh -c`).
- `src/exec.js` `runCommand`: a new `windowsVerbatimArguments` option, default `false`, passed to `spawn`. Every other caller keeps Node's normal argument escaping.
- Tests: three new native controls in `test/service/platform.test.js`, the unit shape test updated, and one `runTask` control in `test/conductor.test.js`.
- `interface.md`: a "Preparation cleanup on Resume" paragraph (PR130 N2).
- New `docs/operator-app/windows-failure-inventory-2026-11-19.{md,csv}`.

## Reproduced

| Check | Fix in place (`2b63aca`) | Fix reverted (`platform.js` and `exec.js` from `ec30725`) |
|---|---|---|
| `node --test test/service/platform.test.js` | **5/5 pass** | **1 pass / 4 fail**. `node -e "process.exit(2)"` returned `code:0`; the quoted `node.exe` path became `'\"C:\Program Files\nodejs\node.exe\"' is not recognized` |
| `node --test --test-name-pattern="quoted failing baseline" test/conductor.test.js` | **1/1 pass** | **0/1**: preparation ran |

The revert was undone afterwards (`git status` clean). This matches Codex's "3/3 new controls FAIL" before and "5/5 PASS" after.

**Every configured command takes this path.** `testShell` has one caller, `Workspace.runTests` (`src/workspace.js:341`). That one function runs:
- the baseline (`conductor.js:250`);
- the run-wide `testCommand` (`conductor.js:360`, `chunkPhase.js:136`, `council/index.js:112`);
- G3 step `check` commands (`chunkPhase.js:129`);
- G4 `gateCommands` (`chunkPhase.js:146`).

So the false green is closed for all of them, not only the baseline. No other code builds a `cmd.exe` command line.

## Counterexamples tried (scratch probe, not committed)

These were run through `runCommand({...testShell(c)})`, first with the fix and then with it reverted.

| Command shape | Expected | With fix | Fix reverted |
|---|---|---|---|
| `fail5.cmd` (batch file, `exit /b 5`) | 5 | 5 | 5 |
| `fail5.cmd && echo must-not` | 5 | 5 | 5 |
| `fail5.cmd \|\| echo fallback` | 0 | 0 | 0 |
| `"dir with space\fail7.cmd"`, also with `.\` and absolute, and with `&& echo no` | 7 | 7 (same as plain `cmd /d /s /c`) | not compared |
| `exit /b 3` (cmd built-in) | 3 | 3 | 3 |
| `node -e "process.exit(\"a\"===\"a\"?4:0)"` (escaped inner quotes) | 4 | 4 | **0** |
| `node -e "…argv[1]==='a&b'?6:0" "a&b"` (`&` inside quotes) | 6 | 6 | **0** |
| `node -e "process.exit(0)" \| node -e "process.exit(8)"` | 8 | 8 | **0** |
| `"%PROBE_V%"` expansion | 0 | 0 | 0 |
| `(node -e "process.exit(0)") && node -e "process.exit(12)"` | 12 | 12 | **0** |
| quoted argument ending in a backslash (`"d\\"`) | 0 | 0 | 0 |
| unbalanced quote `node -e "process.exit(13)` | 13 | 13 | 1 (syntax error) |
| plain `node -e "process.exit(1)"` | 1 | 1 | **0** |

With the fix, every shape gives the right code. Before it, every quoted Node command was a false green, including the quoted-argument forms a G3 `check` written by the planner is likely to use. Unquoted commands, such as the live E1/E2 `node --test`, were never affected. That matches the handoff's note that E1/E2 do not depend on this fix.

Probe hygiene: the Claude Code shell sets `NoDefaultCurrentDirectoryInExePath=1`, which stops `cmd.exe` from finding a bare `fail5.cmd` in the current folder. The probe removed it from the child environment. A service started from a normal console does not set it. My first heredoc version of the quoted-batch case mis-escaped the backslashes; it was rewritten as a file and gave the results above.

## Inventory checks

- The CSV has 201 rows, 201 unique IDs and 201 unique test identities, 7 columns in every row, and no Windows host paths.
- Category counts recomputed from the CSV match the `.md` table exactly: WIN-TOOLS 110, FIX-REMOTE 25, FIX-URL 20, FIX-SHELL 9, ENV-SYMLINK 8, ENV-CRLF 7, FIX-LOCALPATH 7, ENV-MODE 4, FIX-SIGNAL 2, WIN-CMD 2, and 1 each for the other seven. Sum 201.
- Statuses: 199 OPEN, 2 FIXED_NATIVE (W029 council-round "tests that already failed at the starting commit only warn"; W055 factory-build "a feature whose checks fail is not accepted").
- **It agrees with Claude's Part E grouping where they overlap.** That grouping found 116 for `findBin`, with 6 of those inferred; Codex's per-test WIN-TOOLS count is 110. That grouping also placed the council-round `approved`/`approved-with-warnings` failure as "likely the quoted-command false green", which W029 confirms. Codex's per-test inventory supersedes the cause-level grouping, as the handoff said it should.
- The inventory is careful not to over-claim. It says classifying a first blocker "does not exonerate later code", keeps ENV-MODE apart from any ACL claim, and records WIN-ABRUPT (W004, a wake child surviving an abrupt parent kill) as an observed leftover, not fixture noise.

## Findings

### L1 (low): no regression control for a batch-file test command

- **Where:** `test/service/platform.test.js`.
- **Trigger:** a `testCommand` of `npm test` or `pnpm test`. On Windows these resolve to `.cmd` batch files, and this is the most common real configuration.
- **Consequence:** batch exit codes pass through correctly today (the probe above: 5, 5 and 0 for plain, `&&` and `||`). But no test pins this, so a later change to `testShell`, such as adding `call`, could break it without a failing check.
- **Proposed correction (Codex's file):** a Windows-only control that writes a temporary `fail.cmd` (`exit /b 5`) and asserts code 5 for `fail.cmd` and for `fail.cmd && echo x`. The new controls are platform-neutral (they also pass through `sh -c` on Linux), so this one needs an explicit `skip` when `process.platform !== 'win32'`.

### L2 (low): the merge record cannot show who approved this high-risk PR

- **Where:** process, not code. PR131 touches `src/service/platform.js`, which is high-risk. Its `risk-gate` check is red (twice, 10:29 and 11:36 UTC), as designed for a high-risk PR with no `malcolm-approved` label. The other four checks passed. It was merged at 11:36:44 UTC by the `MMCLEOD-DL` account.
- **Consequence:**
  - The rules accept Malcolm's own merge as the approval. But both assistants also push and run `gh` as `MMCLEOD-DL` on this PC, so GitHub's record cannot tell his merge apart from an assistant's.
  - `main` has no branch protection or rulesets, and the repository's auto-merge setting is off. `gh pr merge --auto` therefore merges immediately, whatever the checks say. This was observed on PR133 the same day: it merged with four checks still pending.
  - Nothing here suggests PR131 was merged by anyone but Malcolm. The point is that the record would look the same if it had not been.
- **Proposed correction (Malcolm's repository settings; no assistant may change them):**
  - a rule on `main` that requires the five checks;
  - repository auto-merge switched on;
  - optionally, a separate GitHub identity for the assistants, so a merge by `MMCLEOD-DL` means Malcolm.

## Native full suite (this review's own run)

Command: `node --test --test-concurrency=4 --test-reporter=tap` in `conductor/` at `2b63aca`, on the host above. It was launched from Claude Code's Git Bash shell, with `NoDefaultCurrentDirectoryInExePath` removed. The TAP log stays private on Malcolm's PC.

- **1,732 tests: 1,535 pass, 197 fail, 0 skipped.** Exit 1, 570 seconds. Codex reported 1,532 / 199 / 1 skip at `293eb16`.
- **Failure names compared with the CSV:**
  - every one of the 197 failures is an inventory row still OPEN;
  - **no new failure;**
  - neither FIXED_NATIVE row (W029, W055) fails.
- **Two OPEN rows passed here:** W190 (secrets, "a custom local envKey is scrubbed from every other child") and W200 (workspace, "a timed-out test run says so in its output"). Both are FIX-SHELL rows, which fail when `sh`/`sleep` are missing. This shell puts Git for Windows' POSIX tools on PATH, so they were found. **That is an environment difference, not a fix.** The rows should stay OPEN. The same difference probably explains Codex's one skip. That was not checked.
- **Leftover processes:** afterwards, no `node`, `cmd`, `sh` or `sleep` process with a test, temporary-folder or wake command line was running. The only Conductor process was Malcolm's own app (PID 33080, started 10:15). The check was by command-line pattern, so it does not settle WIN-ABRUPT (W004).

So the native suite is still **not green**. The inventory accounts for every failure seen here, and the fix's own cases (W029, W055) pass natively in a second, independent environment.

## Not reviewed

- `interface.md`'s N2 paragraph, against the engine's actual Resume behaviour. It reads consistently with PR127 as reviewed on 19 November, but was not re-tested here.
- Codex's per-row causes for the 199 OPEN rows, beyond the category totals and the overlaps above.
- Whether WIN-TOOLS should be fixed at all, which depends on whether the factory is meant to run on native Windows. That is Malcolm's call, as already recorded.
- The PR's Linux CI, beyond reading its results on GitHub: `foundation`, `knowledge`, `conductor` and `operator-web` passed, and `risk-gate` was red as expected (L2). Not re-run here.
