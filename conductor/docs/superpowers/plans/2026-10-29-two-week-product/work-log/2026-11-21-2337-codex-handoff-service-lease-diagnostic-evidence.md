# Codex handoff — service lease diagnostic evidence

Packet P07; Codex / BlueLake owner, Claude reviewer invited. Tested code39b3845fea9bbccb671a0b581b32d64f337dbc81, merged by Malcolm through PR159 asd29ba1a while native validation was running. Documentation continuation branch codex/service-lease-diagnostic-evidence fromd29ba1a. No source/test change in this continuation.

The error boundary previously discarded the underlying listen code. It now preserves only an allowlisted `listenCode` and appends that safe code to the existing error message; unknown/malformed codes produce UNKNOWN. Raw OS messages, data paths, addresses, ports and causes are not copied. Existing409/data-in-use compatibility, port derivation, actual singleton refusal and release/reacquisition remain. Diagnostic behavior is tested; the cause of PR157's historical intermittent failure is not established or fixed by this change.

Native Windows, Node v24.12.0, cwd E:/SHINGON-codex-native-review/conductor:

- Before: new real duplicate-lease diagnostic check0pass/1fail/0skip, exit1, because listenCode was absent.
- `node --test --test-reporter=tap test/service/lease.test.js test/service/server.test.js`:39pass/0fail/0skip, exit0,21583.1917ms. Real synthetic duplicate refusal/reacquisition plus known/unknown diagnostic/privacy controls and36service server cases. Final fixture cleanup refinement only prevents leaking an unexpected second listener if refusal regresses; final lease file rerun3pass/0fail/0skip, exit0,114.3191ms.
- `node --test --test-concurrency=4 --test-reporter=tap`:1,766tests/1,719pass/46fail/1skip/0cancelled, exit1,610193.6259ms. Compared with prior1,748 total, baseline PR158 adds15synthetic rare-language harness tests and this task adds3lease tests. No live model, Hoon or Urbit execution follows from those synthetic tests.
- Exact file/test-name comparison against original inventory OPEN cohort: all46same failures,0resolved,0new. All201rows unchanged at155FIXED_NATIVE/46OPEN. TAP paths normalized/line-column shifts ignored. No inventory edits or closure from diagnostic coverage.
- PR157's additional receipt-test lease failure did not recur in this completed run. Its earlier47fail result is retained; absence in a later run does not close its cause or establish collision/access-denial provenance. Future genuine recurrence should now expose a sanitized code. Codex owns subsequent evidence reconciliation; do not manufacture repeated runs or waive the failure.

Private logs shingon-lease-diagnostics-before.tap, shingon-lease-diagnostics-focused.tap, shingon-lease-diagnostics-final-focused.tap and shingon-service-lease-diagnostics-full.tap remain outside Git. No raw OS trace or credential material in this handoff.

Code-head four CI suites allPASS: Foundation, Operator Web, Conductor, Knowledge in44961896255. Risk-gate44961896253 failed solely because conductor/src/service/lease.js is a high-risk path: its actual job log requires Malcolm's label or merge. Malcolm merged PR159; no label, gate or repository setting was changed by Codex. Final documentation-head CI must be checked separately before readiness.

P07/P08 remain IN_PROGRESS and native suite remains red. Existing skip retained/no Windows skip added. No shared service/worker restart, model, actual credential, remote, release or policy action. Synthetic loopback/test-worker fixtures only; peer UI/h2j4/spent-binding/native-gate exclusions preserved. PR158 rare-language peer review remains separately queued, with no peer implementation edits here. Current chat owns final evidence submission/checks, then waits for Malcolm merge before another task.
