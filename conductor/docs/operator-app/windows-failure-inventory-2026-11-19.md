# Native Windows failure inventory — 19 November 2026

PR130 R1 is valid: a repeated failure count is not an accepted baseline. This inventory reconciles **all201 distinct failures** from the saved full native run at code `80b90be846b35455d2329ce61dbd01e433f02689` (1,728total; 1,526pass / 201fail / 1skip, exit1). The [CSV](windows-failure-inventory-2026-11-19.csv) identifies every test by its saved name/location, primary observed cause, owner and required action. Locations refer to that pinned revision. Private logs and host paths are excluded.

Rows remain OPEN until their named assertions run successfully or receive an explicitly agreed alternative. The isolated full rerun at `293eb161b042f27dd092902b1b6e4157c9b32d72` has **1,732total; 1,532pass / 199fail / 1skip**, exit1. Exact file/name-set reconciliation identifies **W029 and W055 as fixed, zero new failure identities, and the other199 still OPEN**; the CSV records those statuses. Classifying the first blocker does not exonerate later code that the test never reached. No existing assertions were weakened and no Windows skips were added. P07/P08 remain IN_PROGRESS; native acceptance is not established.

| Category | Count | Evidence and disposition |
|---|---:|---|
| WIN-TOOLS |110|Real native tool-discovery defect plus fixture cascades. `findBin` reads only PATH and looks for literal bare filenames; Windows .exe/PATHEXT and mixed-case Path are not handled. Independently, a directory containing the current Node executable resolves `node.exe` with PATH, but neither `node` with PATH nor `node.exe` with Path. The fakeSsh fixture also joins search paths with colon. SSH/release assertions consequently stop before their intended scenario; some fail later on missing calls/tags. Codex owns discovery and fixture repair, then reruns every case with synthetic transport. No real SSH was invoked.|
| FIX-REMOTE |25|Native temporary paths are substituted into POSIX remote workRoot/script fields and are correctly rejected by existing remote path validation. Separate host storage from simulated remote paths; do not relax validation.|
| FIX-URL |20|Fixture reports and CLI entry points use file URL `.pathname` as a Windows path. This leaves an invalid drive path and missing reports, followed by coverage/design assertion cascades. Use fileURLToPath and rerun every dependent assertion.|
| FIX-SHELL |9|Tests require absent sh/sleep or POSIX semicolon/$VAR syntax under cmd. Port synthetic commands to Node or use an explicitly scoped POSIX harness; no automatic installation, WSL operation or skip is authorized.|
| ENV-SYMLINK |8|Symlink creation fails with EPERM before the intended security/cleanup assertion. Codex owns fixture adaptation; Malcolm owns any privilege decision. No policy change or skip approval is inferred.|
| ENV-CRLF |7|Actual and expected bytes differ by CRLF/LF after Git checkout. Make test fixture Git settings deterministic, preserving content assertions and user configuration.|
| FIX-LOCALPATH |7|Tests hardcode POSIX spelling for local paths or persist `/repo` while the reader normalizes a native local path. Normalize the fixture/expectation with host path APIs.|
| ENV-MODE |4|Windows stat reports0666 where0600/0700 is asserted. This is not an ACL assessment: privacy remains an open native requirement. Define and verify actual synthetic-file ACL behavior without weakening permissions.|
| FIX-SIGNAL |2|Node child.kill(SIGINT/SIGTERM) abruptly terminates the native child and returns a null exit code, rather than exercising a graceful console interrupt. Keep graceful handling and forced termination distinct in a safe harness.|
| WIN-CMD |2|**Real false-green test execution**, independently reproduced below. Corrected by this PR; original named cases pass in the isolated full native rerun. Rows W029/W055 are FIXED_NATIVE; all other rows remain OPEN.|
| WIN-ABRUPT |1|A synthetic wake child survives abrupt parent termination. This is observed, not dismissed as harmless fixture noise. Codex must investigate owned orphan cleanup separately from genuine console Ctrl-C. Cancellation acceptance stays open.|
| WIN-REPORTPATH |1|Native path.join inserts backslashes into a generated POSIX-style report command. Codex must settle the local-versus-shell path contract and correct the appropriate source/fixture seam.|
| FIX-CLEANUP |1|A fixture finally-block removes a directory before its synthetic catcher children have exited; Windows rm fails EPERM and can obscure the earlier remote-path refusal. Await owned child exit; retain cleanup assertions.|
| FIX-ENVCASE |1|The strict-child-env assertion reads `.PATH` when the host key is `Path`. This assertion alone does not establish lost child search paths; verify actual synthetic child resolution. Product findBin case handling is tracked under WIN-TOOLS.|
| FIX-GITCONFIG |1|Raw native backslashes interpolated into a Git config payload cause a parse error before hostile-hook controls execute. Escape the fixture correctly and prove the hostile control still fires without protection.|
| FIX-PERM |1|chmod000 does not create the intended Windows write denial. Use injected filesystem refusal or a separately scoped ACL fixture, retaining the nonthrowing error-path assertion.|
| FIX-UTILITY |1|The fixture calls unavailable POSIX `which` before checking a restricted executable environment. Resolve the synthetic dependency portably.|

Every action above is Codex-owned unless explicitly assigned to Malcolm's host/skip decision. None requires contacting a real remote host. Further defects may emerge after these first blockers are removed; keep them as failures rather than changing counts into a waiver.

## Critical reproduction and correction

The original `testShell` passed `/d /s /c` and an ordinary command argument to Node spawn. Windows CRT escaping adds backslashes around its inner quotes; cmd interprets those differently. Independent native controls observed:

- Configured `node -e "process.exit(2)"` returned **code0**, empty output.
- A quoted executable path containing spaces failed to resolve.
- A runTask baseline using that failing command reached deferred preparation **once** instead of refusing it.

All three new controls failed before the fix. The correction explicitly uses cmd's outer-quote convention with `windowsVerbatimArguments:true` only for the configured test shell; generic subprocess calls retain normal argument escaping. It preserves AutoRun-disabled `/d /s /c`. Focused controls now verify code2, exact literal arguments, a failing baseline stopping before preparation, and compound-command short-circuiting. This addresses a real product defect rather than skipping a failing test.

## PR130 notes

- **N1:** keep high-risk PRs draft and label in-progress native evidence plainly. PR128's original body did state the full native suite was running; nevertheless, no merge request/readiness should precede the completed native submission. Retain exact commands/counts and unresolved native failures before requesting approval. A draft can still be merged by the operator, so its state is not proof validation finished.
- **N2:** interface.md now documents no-plan preparation refusal on Resume, archive cleanup, null workspace and the saved-plan/keepWorkspace exceptions.
- **N3:** Claude owns richer G4 UI rendering; this task does not edit those files.

R1 remediation remains open: the inventory supplies a complete per-test queue, not a passing suite or approval for skips. The critical command fix and its validation are recorded in the accompanying submission ledger.
