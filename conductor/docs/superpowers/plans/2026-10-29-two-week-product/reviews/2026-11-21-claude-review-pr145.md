# Claude review: PR145, portable secret-environment probes

- **Reviewed:** Codex's PR145 (`codex/native-secret-env-fixtures`). Code at `eadfbb5`, merged into `main` as `bac32f7`. I reviewed `conductor/test/secrets.test.js` on `main` at `bac32f7`.
- **Requested by:** `work-log/2026-11-21-1458-codex-submitted-native-secret-env-fixtures.md`, under "Reviewer Claude". Malcolm merged the PR before this review, so this is a post-merge review.
- **Host:** native Windows 11 Home 10.0.26300, Node v24.12.0. Only synthetic keys and local child processes were used. No model, subscription, SSH or release call.
- **Disposition: no defect found.** I checked each of the submission's three questions by breaking the runtime code on purpose (a mutation) and confirming the tests catch it. Every mutation fails the intended test, for the intended reason.

## What changed

The four tests (inventory rows W189–W192) used to read variables through `sh -c 'echo "$VAR"'` and `printf`. They now read them with a Node probe, run through the real `runCommand` and `Workspace.runTests` entry points:

- **Exit codes:** each probe's exit code is asserted, and `passed` is asserted for every `runTests` call.
- **Positive controls:** an explicitly allowed key (`LOCALAI_API_KEY`, and the custom `MY_LOCAL_PROVIDER_KEY`) must reach the child.
- **`PATH`:** on Windows the `PATH` key is found case-insensitively. A real child then has to resolve `node` through the strict environment's search path.
- **Database URL:** the probe exits 2 unless `TEST_DATABASE_URL` equals the synthetic URL. Otherwise it prints the URL and password and exits 1.

No runtime source changed.

## Reproduced

`node --test test/secrets.test.js` from `conductor` at `bac32f7`: **12/12 pass**.

I applied each mutation in a scratch worktree at `bac32f7`, ran the same file, then reverted it. The worktree was removed afterwards and the checkout is untouched.

| Mutation (runtime code) | Result | Caught by |
|---|---|---|
| M1 `childEnv` no longer drops `LOCALAI_API_KEY` | 8 pass / 4 fail | the two changed runCommand/runTests tests, plus two unchanged ones |
| M2 `strictChildEnv` keeps secret-named vars | 10 / 2 | "runCommand and runTests do not pass…", "…no secret-named vars… (N2)" |
| M3 `runTests` passes `process.env` instead of the strict env | 10 / 2 | the same two |
| M4 `runTests` drops `TEST_DATABASE_URL` from the child | 11 / 1 | "final-fix 2", at `r.code`: **actual 2, expected 1** ("the failing probe actually received the database URL") |
| M5 `strictChildEnv` drops `PATH` (any case) | 11 / 1 | "…(N2)", the new search-path check |
| M6 `runTests` output not redacted | 11 / 1 | "final-fix 2", the password assertions |

## The three questions

1. **Credential inheritance is still detected.**
   - M1–M3 each turn at least one test red.
   - The new positive controls rule out a probe that prints `[]` whatever it receives. An allowed key must arrive verbatim.
2. **A failed probe cannot look successful.**
   - Every `runTests` call asserts `code` and `passed`.
   - The leak-file probe also fails loudly if it never ran, because `readFileSync` throws.
   - In the database test, `code === 1` alone would also match a probe that never started: a missing `node`, a quoting fault under `cmd`, or a syntax error all exit 1. The `connect failed [redacted]` match closes that gap, because that line is printed only after the URL check passes. The combination is sound; neither assertion is enough on its own.
3. **The database check proves the URL was delivered before redaction.**
   - M4 fails at the exit-code assertion with exit 2. So the probe really compares the delivered value, and the earlier in-process `strictChildEnv()` check is not what catches it.
   - M6 shows that the redaction assertions still bite.

## Not covered here

- The full native suite was not rerun for this review; the change touches one test file. Codex's submission reports 1,746 total, 1,683 pass, 62 fail and 1 skip at `eadfbb5`.
- Linux: PR145's required checks were green at merge (`conductor`, `foundation`, `knowledge`, `operator-web`, `risk-gate`).
