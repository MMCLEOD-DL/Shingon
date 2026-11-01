# Codex task submitted — local Windows sandbox (P08 F1)

Owner Codex; independent reviewer Claude (review pending).
Status IN_REVIEW. Branch codex/local-windows-sandbox.
Baseline 789c6a23327ed722cd50b00236d12362eacee3c6; code a00f06091ccab64acebae9ea35d2b5512b872662.
PR: https://github.com/MMCLEOD-DL/Shingon/pull/68

Local-agent private configuration now includes the recommended elevated Windows
sandbox on native Windows. The participant field windowsSandbox accepts exactly
elevated or unelevated; other hosts omit the table by default. Personal config is
not read. Existing extraConfig CLI overrides retain precedence, workspace-write
and read-only selection is unchanged, and credential exclusions stay last.
Shared seams: localAgent.js and config.js, with regression/expectation tests and
setup documentation. No service/UI/secret handling or persistent-home changes.
Interface v1 unchanged; optional on-disk participant setting only.

Evidence (native Windows, Node 24.12.0):
- Five new regressions all fail against original source, all pass after correction.
- node --test test/local-windows-sandbox.test.js test/config.test.js: 20/20 PASS,
  zero skips. Real native Node stand-in captures private config and write/read-only
  args on three repeated calls; separate homes are removed after each call.
- Wider adapter/config selection: candidate 25 PASS/22 FAIL/0 SKIP; clean baseline
  20 PASS/22 FAIL/0 SKIP. All 22 failing names MATCH. Existing shebang-script fake
  executables cannot be launched directly by native Windows spawn. This is not a
  clean wider-suite pass. Baseline comparison ran in a separate archived checkout.
- Full native node --test --test-concurrency=4 was attempted, then deliberately
  stopped after numerous unrelated harness/platform failures; ABORTED, no final
  pass count. Only that tracked test process/tree was stopped; checked PIDs absent.
- git diff --check PASS.
- Linux CI at code SHA: risk-gate, knowledge and operator-web green at submission;
  conductor and foundation still running. Final-head CI remains required. No green
  full-suite claim is made by this entry. PR readiness/auto-merge follows separately.

These are synthetic/stand-in checks, not live Codex or LocalAI acceptance. No model,
subscription, key read, worker restart, sandbox installation, UAC action, remote
host, policy change or deployment. F1's actual corrected-build file write needs
Malcolm's Windows live acceptance. F2 recurring UAC cause remains unproven and
private homes are still per-call. F3/F4 frontier isolation, F5/F6/F7 follow-ups and
the newly approved F8 failing-test rule are separate queued tasks. Claude retains
U1/U2. No other worker's files changed.

Merge accepts the bounded F1 configuration correction, not complete P08 acceptance.
Next invocation after merge: continue ordered Windows reliability follow-ups;
preserve the real-model and repeated-UAC acceptance items and record their result.
