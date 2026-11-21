# Claude review: PR148 and PR150, explicit path for the keyleak fixture

- **Reviewed:** Codex's PR148 (`codex/native-keyleak-command-path`), with its code at `bbf1f1c`, merged as `c1aa721`. Also PR150 (`codex/native-keyleak-command-evidence`), its evidence, merged as `1580361`. I reviewed them on `main` at `1580361`.
- **Requested by:** `work-log/2026-11-21-1758-codex-submitted-native-keyleak-command-path.md`, which asks Claude to "confirm explicit-path fixture resolution under restricted lookup and retained redaction assertions". Malcolm asked me in chat on 21 November 2026 to look at PR150. This is a post-merge review.
- **Host:** native Windows 11 Home 10.0.26300, Node v24.12.0. I used only synthetic keys and local child processes.
- **Disposition: no defect.** This closes L1 from `2026-11-21-claude-review-pr142-pr144.md`.

## What changed

PR148 changes one line in `test/keyleak.test.js`. The Windows `testCommand` goes from `leak-check.cmd` to `.\leak-check.cmd`. PR150 adds the evidence entries only.

## Checks

| Check | Result |
|---|---|
| `NoDefaultCurrentDirectoryInExePath=1 node --test test/keyleak.test.js` (the restricted lookup that failed before) | **1/1 pass** |
| `env -u NoDefaultCurrentDirectoryInExePath node --test test/keyleak.test.js` | **1/1 pass** |
| Assertion lines added or removed in `test/keyleak.test.js` since `94bc63a` | **0** |
| Mutation: `strictChildEnv` keeps secret-named vars, run with the restricted lookup | **0/1**, at "secret-named vars are absent from failed-test feedback" |

- **The script really runs under the restricted lookup.** The retry-prompt assertions need the script's `env=[]` and `local=[]` lines. A passing run therefore proves it ran, not just that the baseline exited 0.
- **The test still catches a leak.** The mutation shows the repaired fixture still detects secret-named variables reaching the test command. I applied it in a scratch worktree at `1580361`, then removed the worktree.

## Still open (not a defect here)

The product question from L1 is still open for Codex or Malcolm. An operator's own configured test command that names a script with no path would hit the same baseline stop whenever Conductor inherits `NoDefaultCurrentDirectoryInExePath`. Fixing or documenting that would be its own change.
