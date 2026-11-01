# Codex task submitted — P08 F5 hidden child consoles

Owner Codex; independent reviewer Claude pending. IN_REVIEW (draft pending CI).
Branch codex/windows-hidden-children; baseline630598d8cd2f3988d486232d92e677085a63c7ec.
Last code commit b556a62677a0f530c283473fc81eb30c6f21af3e.
PR https://github.com/MMCLEOD-DL/Shingon/pull/73

runCommand and spawnTracked now set windowsHide:true; detached tracking, pipes,
arguments, environment handling and PID/tree cancellation remain. No UAC handling
or actual administrator operation. No UI/service/auth/secret module change.

Native Windows Node24.12.0: both new launch-contract regressions fail before fix
(missing/overridden windowsHide). After correction: node --test
test/hidden-children.test.js test/exec.test.js test/private-codex-home.test.js
test/local-windows-sandbox.test.js:24 PASS/0 FAIL/0 SKIP, exit0,1.551seconds.
Actual native I/O, stdin, timeout, descendant-held pipe and killAllChildren tests
run real synthetic processes. New spawn boundary tests capture exact options,
including conflicting caller settings, preserving arguments/env/cwd/stdio.
Baseline exec suite8/9: existing POSIX-only SIGKILL expectation fails on Windows
taskkill despite terminated PID. Corrected assertion keeps POSIX SIGKILL, checks
Windows nonzero exit and additionally requires PID absence on both platforms.
Whitespace PASS. Full native suite retains unrelated shebang limitations and is
not rerun; full Linux CI pending on final head. Actual visible-window count and
real-model desktop presentation NOT_RUN, no native visual acceptance claim.

No live model/subscription, real credential read/copy, worker/policy/UAC or deploy
operation. Keep this PR DRAFT until every required final-head check is green;
then watcher should mark ready and notify Malcolm. Auto-merge disabled; manual
merge/independent review boundary retained. This avoids the earlier PR71 merge
while its CI correction was still being prepared.

F3/F4 source audit in this task's claim: keyring namespace also follows CODEX_HOME.
Required next architecture is dedicated frontier home plus supported explicit
sign-in preparation; no transparent auth reuse claimed. References:
https://developers.openai.com/codex/auth
https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/login/src/auth/storage.rs
https://github.com/openai/codex/blob/rust-v0.163.0/codex-rs/config/src/loader/local.rs
No auth migration was performed. F6 search-path/versions and F7 diagnostics remain
independent queued work. F1/F2 live file-write/UAC acceptance remains open.
