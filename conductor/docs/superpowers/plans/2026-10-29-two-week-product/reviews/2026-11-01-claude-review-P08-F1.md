# Claude review: P08 F1, the local agent's Windows sandbox (PR 68)

Date: 1 November 2026 (UTC). Owner: Codex; reviewer: Claude.
Reviewed: code `a00f06091ccab64acebae9ea35d2b5512b872662`, merged as `5627443` (PR 68), against baseline `789c6a2`.

**Verdict: approved.** The change does what F1 needs, it is minimal, and its tests have teeth. Two notes, one of
which (R1) should decide what Codex does next. No blocking finding.

## Reproduced (cloud Linux, Node 24)

- `node --test test/local-windows-sandbox.test.js test/localAgent.test.js test/config.test.js`: **34 passed, 0
  failed, 0 skipped** on `5627443`.
- The new test file run against the pre-fix source (`789c6a2`, in a separate worktree): **4 of 5 fail** as they
  should. The fifth (`Windows default is elevated; other hosts omit Windows config`) **passes on the old code too**:
  on Linux it only checks the non-Windows branch. See R2.
- Read every changed line. The value is allow-listed (`elevated` / `unelevated`; `null`, `false`, case variants and a
  TOML-injection string are refused), so no arbitrary TOML reaches the private config. The `[windows]` table follows
  the only top-level key (`model_context_window`) and precedes the provider table, which is valid TOML ordering.
  Personal `~/.codex` is still never read. `extraConfig` (`-c`) still wins, so the first run's workaround line keeps
  working until removed, as setup.md says.
- Not reproduced here: anything on Windows. Codex's native Windows run (20/20 focused; 22 pre-existing failures in the
  wider selection, identical on the baseline, from shebang stand-ins that native Windows cannot launch) is accepted
  as its evidence, not re-run. The corrected build has not yet written a file with the real local model.

## R1 (P2, decides the next task): the Windows default is "elevated", and homes are still new per call

- **Where:** `src/adapters/localAgent.js` `localCodexConfig` (default `elevated` on win32), with the per-call private
  `CODEX_HOME` in `src/adapters/codex.js`.
- **Trigger:** a fresh Windows install, any local-agent call.
- **Consequence:** this default reproduces exactly the configuration of the first live run (the `extraConfig`
  workaround also set `elevated`), and on that run Malcolm saw a UAC "Do you want to allow this app to make
  changes?" prompt on local-model runs. Until F2 is fixed, every new user gets those prompts by default, possibly
  one per local attempt (up to `localRounds` per step). The cause is still a hypothesis (elevated set-up recorded per
  home), as the submission says.
- **Not a defect of this PR:** it makes the out-of-box behaviour equal to the working workaround, which is right.
  **Recommendation:** make F2 Codex's next Windows task, and decide the default from evidence: either a persistent
  private home for the local agent (set-up once), or `unelevated` if Malcolm's pending test shows it writes files
  without a prompt. Record his result in the F2 task before choosing.

## R2 (P3): the Windows default is not covered by Linux CI

- **Where:** `test/local-windows-sandbox.test.js`, test 2; `test/localAgent.test.js` expectation, both branch on
  `process.platform`.
- **Consequence:** CI runs on Linux, so a change that broke the win32 default (for example dropping the `elevated`
  fallback) would pass CI. Only a native Windows run would catch it.
- **Suggested fix (small):** let `localCodexConfig` take the platform as a parameter defaulting to
  `process.platform`, and test `'win32'` and `'linux'` explicitly on every host.

## Claude's follow-up (done with this review)

The first-run checklist (`real-run-checklist.md`, step 5) still told the operator to add the
`"extraConfig": ["windows.sandbox=elevated"]` workaround. It now uses the supported `"windowsSandbox"` field and says
to remove the old line, matching setup.md.
