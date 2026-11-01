# Codex task submitted — P08 F7 safe probe failure guidance

Owner Codex; independent reviewer Claude pending. IN_REVIEW (draft pending CI).
Branch codex/probe-failure-guidance; baseline76a0579e23e33a2587a7fa87033985f39c77282e.
Code commit fea22410aa3094a4d9b4cdf4cf21bfed4e3690e0.
PR https://github.com/MMCLEOD-DL/Shingon/pull/75

Existing public action field now contains fixed bounded diagnostic guidance for
observed file/challenge failures and recognized CLI errors; no raw stdout/stderr,
model replies, paths, URLs, nonces, account details or stacks are interpolated.
Success still requires actual fresh nonce/file verification. Installation timeout
leaves executable unknown. Adapter exceptions become safe failed-probe results.
No UI or interface-v1 schema change. Setup already renders action as What to do.

Native Windows Node24.12.0:
- Five initial diagnostic regressions FAIL on original source, PASS after fix.
- node --test --test-concurrency=2 test/service/probe-guidance.test.js
  test/service/probe.test.js test/service/platform.test.js
  test/service/server.test.js:44 PASS/0 FAIL/0 SKIP, exit0,12.044seconds.
- Controls cover missing/wrong/unreadable verification file, wrong reply, timeout,
  sign-in/rate/version/sandbox/read-only/unknown errors, private diagnostic payloads,
  exceptions and positive checks. Existing API/auth/origin/recovery checks pass.
- Wider health suite19/22 in combined selection: three unchanged shebang-launch
  failures. Independently archived clean76a0579 health suite8PASS/3FAIL, same known
  native fixture limitation. Health module untouched, no full native pass claimed.
- Whitespace PASS. Final-head full Linux CI pending. No actual model/CLI connection
  probe, real credential, worker/policy/UAC or deployment action; only synthetic
  adapters and local disposable service/Git fixtures.

High-risk approval: .github/workflows/risk-gate.yml protects conductor/src/service/**.
Do not add/remove malcolm-approved or change the workflow. Malcolm's label after
review is required for risk-gate green (or he merges himself). Keep draft until
all required latest-head checks pass. If other checks pass and this is the only
remaining gate, notify once with the concrete approval requirement. Auto-merge off.
Next after merge: dedicated frontier Codex home plus supported explicit sign-in
preparation for F3/F4, preserving credential boundaries; F1/F2 live acceptance stays
open. Claude-owned UI/checklist and other workers' tasks remain untouched.
