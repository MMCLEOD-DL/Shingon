# Native Windows failure inventory — 19 November 2026

PR130 R1 is valid: a repeated failure count is not an accepted baseline. This inventory reconciles **all201 distinct failures** from the saved full native run at code `80b90be846b35455d2329ce61dbd01e433f02689` (1,728total; 1,526pass / 201fail / 1skip, exit1). The [CSV](windows-failure-inventory-2026-11-19.csv) identifies every test by its saved name/location, primary observed cause, owner and required action. Locations refer to that pinned revision. Private logs and host paths are excluded.

Rows remain OPEN until their named assertions run successfully or receive an explicitly agreed alternative. The first isolated rerun at `293eb161b042f27dd092902b1b6e4157c9b32d72` had **1,732total; 1,532pass / 199fail / 1skip**, exit1, fixing W029/W055 with zero new failure identities. The tool-discovery follow-up below advances that result; it does not turn the remaining failures into an accepted baseline. No existing assertions were weakened and no Windows skips were added. P07/P08 remain IN_PROGRESS; native acceptance is not established.

## Latest native checkpoint — release fixture writes, 21 November

At tested code `a49a68df8cec1533357fa015156dcd0f4e344fcc`, full native
`node --test --test-concurrency=4 --test-reporter=tap` completed with **1,744 total;
1,677 pass / 66 fail / 1 skip**, exit1 (746.530 seconds). Exact file/name comparison
against the preceding72 failures resolves **W115, W119, W120, W125, W126 and W127**,
with **zero new failure identities**. All66 current failures match OPEN inventory
rows; cumulative disposition is **135 FIXED_NATIVE / 66 OPEN**. The six additional
tests since the preceding checkpoint come from the integrated local-down work.

The release test file previously had12 pass /6 fail, all six stopping at
`spawnSync sh ENOENT`; after replacing its four shell file-write sites with Node
filesystem calls it passes18/18, zero skips. Fixture content and all assertions
are unchanged, including unexpected-file/extra-commit refusal, package script and
dependency refusal, and crash recovery preserving operator edits. Production
source is unchanged. Linux code-head CI passed all five checks; Conductor has
1,741 pass /0 fail /3 skips. This is synthetic validation, not live release or
native acceptance;66 failures remain open.

PR142 was merged into `d970ed9` while the native full run was still in progress;
Codex had left it draft and did not request readiness or merge. Runtime/test trees
at that merge are identical to the tested code. Final inventory/evidence is a
separate documentation continuation, not a push claimed to update the closed PR.

The PR140 handoff's native keyleak failure was not reproduced: the existing test
passes one isolated invocation, four concurrent isolated invocations and this
full run. No keyleak source/test change or closure of the peer-observed discrepancy
is claimed. Do not add an independently reproduced failure claim from that report.

## Previous native checkpoint — fixture file URLs

At test code `0aa6c87a34db2936ed25e7735f3cfcc2151e58b8`, the full isolated native suite has **1,738 total; 1,665 pass / 72 fail / 1 skip**, exit1 (519.573 seconds). Exact file/name comparison against the preceding91 failures resolves **19**, all originally FIX-URL, with **zero new failure identities**. All72 current failures match inventory rows. The cumulative inventory is now **129 FIXED_NATIVE / 72 OPEN**. The additional test relative to the preceding checkpoint is PR135's final batch-shell control, already included in this baseline.

Seven conversions in six test/helper files now use Node `fileURLToPath` for native filesystem paths. Existing assertions and fixture bytes are unchanged. The affected six test files reproduce **97 total; 77 pass / 20 fail**, exit1 before correction, and **97 total; 96 pass / 1 fail**, exit1 afterward, with no skips in either focused run. The focused and full runs resolve exactly the same19 original identities.

W018 remains OPEN: correct report loading now reaches `symlinkSync`, which Windows refuses with EPERM before the screenshot-exclusion assertion. Its latest category is ENV-SYMLINK; its original FIX-URL category remains historical. Codex owns a fixture adaptation retaining the security assertion; Malcolm owns any privilege decision. No Windows skips, privilege changes or relaxed assertions were introduced. Native acceptance remains open;72 failures are not an accepted passing baseline. These runs use synthetic participants; no live model/worker/remote acceptance was performed.

## Previous native checkpoint — tool discovery and transport cleanup

At production code `f3d08164e751d270ff3770c66ac4e758c832ca67`, the full isolated native suite has **1,737total; 1,645pass / 91fail / 1skip**, exit1. Exact file/name-set comparison with the prior199 failures resolves **108**, all initially assigned to WIN-TOOLS, with **zero new failure identities**. Together with PR131's two fixes, the CSV now has **110 FIXED_NATIVE / 91 OPEN** rows. Its original `category` and `observed_cause` retain the baseline classification; `latest_category`/`latest_observation` record progress and newly reached blockers.

Native bare executable lookup now handles mixed-case Path, PATHEXT and quoted directories, while keeping executable-file and bare-name boundaries. SSH fixtures use the host delimiter and verify their exact stub before running. Once discovery worked, the transport tests exposed surviving native child processes; using the existing owned-tree stop helper fixes cancellation and timeout cleanup. The file-close check now observes the actual ReadStream's closed state instead of Linux /proc. Final focused checks pass23/23, including a real executable outside PATH being refused at test head5a8493c.

Only W119/W120 remain open in the original110 WIN-TOOLS cases. They now reach fixture setup and fail because `sh` is unavailable (`cat > CHANGELOG.md` / `echo mine >> CHANGELOG.md`). Their latest category is FIX-SHELL. Port those fixture writes to Node without removing the release-tampering/crash assertions. Generic Windows batch-file invocation and full native factory support are not established by executable discovery.

| Initial category at80b90be | Count | Evidence and disposition |
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
| WIN-CMD |2|**Real false-green test execution**, independently reproduced below. Corrected by PR131; original named cases remain passing. Rows W029/W055 are FIXED_NATIVE; the latest checkpoint above records108 further fixes.|
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
