# Native Windows retest — 5 November 2026

P08 retest by Codex on Malcolm's native Windows host, explicitly authorized by
Malcolm in this chat. Baseline: merged PR79 `07fc9d50a405caf0ebb422cb5eb43136bbcc0a71`.
Candidate probe correction: `9b284fd538b9aac27c55cf92c50332f21c7aa058`.
This is live service/API evidence; browser presentation is not certified by it.

Host/tools: Windows 11 (10.0.26300), Node 24.12.0, Claude Code 2.1.316,
Codex CLI 0.163.0, configured LocalAI model `shingon-qwen3.8-27b-q4`.
All tasks use fresh synthetic repositories/data. Original trial and client files
are preserved. Raw traces, session capabilities and authentication stay private.

## Connection results and prerequisite failures

| Check | Result | Evidence |
|---|---|---|
| UI dependency install and production build | PASS | `npm ci --no-audit --no-fund`, `npm run build`; Vite build succeeds |
| Three native installation checks | PASS | Actual service workers find Claude and both Codex participants |
| Claude challenge and file write | PASS | Live subscription; fresh response/file verification |
| Frontier Codex challenge and file write | PASS after dedicated login | Initial `unauthorized` correctly directs to dedicated-home login; Malcolm completes supported login; subsequent challenges/writes verify |
| LocalAI challenge | PASS after worker startup | Initial failure with stopped dedicated WSL worker; no health listener. Malcolm separately authorizes existing startup script; readiness becomes HTTP 200 and challenge verifies |
| LocalAI file write | PASS after probe correction | Initial reviewer-role attempt times out at 60 seconds; executor-role retry verifies in 18.4 seconds |
| Repeated corrected writing checks | PASS | Claude 7.9 s, Codex 23.0 s, LocalAI 19.4 s; same actual file/nonce verification |
| Writing checks after orderly service restart | PASS | Fresh service process; LocalAI 18.3 s and Codex 20.5 s; same config/bin/cache |

The nine backend check types have successful results after these explicit setup
actions/correction. Initial failures remain part of the evidence. No API-billing
fallback, copied subscription authentication or extended check timeout was used.
The LocalAI worker was started only after Malcolm's separate permission; its
existing networking configuration needed no change.

## Reproduced probe defect and correction

`performProbe` passed the adversarial `reviewer` role even when asking for a file
implementation. The local live trace followed that assignment by inspecting the
empty repository and Git history, then hit the unchanged 60-second deadline.
The correction selects `grunt` only for agentic checks. Authentication challenges
remain read-only; nonce equality, file existence and time limits are unchanged.

The role-sensitive native regression first fails (6 pass / 1 fail in the probe
file), then passes. The focused native config/service suite passes **70 tests**,
zero failures/skips, 11.46 seconds. All three real coding adapters pass corrected
file-writing checks afterwards. No stand-in model result is labelled live.

## Windows observations and fixture limitations

- Malcolm reports no UAC prompt for the first frontier Codex write, then **three
  administrator-consent prompts** across subsequent checks. Individual participant
  attribution was not supplied. **Repeated UAC remains OPEN**; retained homes do
  not establish that prompt recurrence is solved. Ordinary console flashes were
  not independently established by these API checks.
- Personal Codex config is compared by hash only and remains unchanged through
  the final checkpoint after coding/recovery and post-restart probes. No personal
  auth contents or keyring entries are read.
  Dedicated-home behavior is observed; exhaustive system/project/plugin-policy
  isolation is not claimed.
- The parent environment has no manual Codex search-helper prefix; the configured
  native installation has adjacent `rg.exe`. Full successful search evidence is
  recorded separately from executable discovery.
- The first coding attempt used an overly restrictive private artifact parent.
  Sandboxed tools could not navigate that parent. Stop produced `interrupted`;
  all three tracked run processes disappeared, no source branch was created and
  source HEAD/index/files remained unchanged. This attempt does not establish a
  successful coding result.
- A profile-folder fixture was redirected through the packaged desktop app's
  cache. The workspace identity guard refused the differing Git common-dir path;
  it was not relaxed. Remaining tests use a fresh ordinary `C:\` trial data path,
  matching the original live-test layout. Packaged-app profile-path compatibility
  remains a separate limitation, not a passed default-path acceptance claim. A
  read-only control confirms `fs.realpathSync.native` matches Git's physical path,
  while `fs.realpathSync` returns a different logical path. Any correction needs
  its own security-preserving regression/review; none is included here.
- A private local controller starts the actual production launcher/real workers,
  authenticates immediately, and can request its SIGINT handler and start a fresh
  service process. It inherits the operator-entered local key normally. It supplies
  no fake models or approvals; API decisions still require current evidence.

## Coding and recovery scenarios

| Scenario | Result | Evidence |
|---|---|---|
| Approve multiply change | PASS | Local model implements one step; Anthropic/OpenAI both complete calls; reviewed diff changes only math source/tests; actual workspace and committed branch files pass 4/4 tests |
| Source preservation after approval | PASS | Source remains clean at original `main` commit `2f5df06`; exactly one new `conductor/...` branch, no merge |
| Reject rename change | PASS | Local execution and both subscription vendors complete; reviewed rename is rejected; no branch created, prior branch count stays one and source remains clean |
| Stop a live local coding call | PASS | State becomes interrupted; all 3 tracked run processes disappear; source and branch count unchanged; explicit Resume succeeds |
| Orderly service restart with approval pending | PASS | Production SIGINT handler closes service/worker, then a fresh service PID starts; run is interrupted with no active decision |
| Refuse stale approval | PASS | Previous decision/revision/commit submission returns HTTP 409 `stale-decision`; no branch lands |
| Resume completed work without recoding | PASS | New decision ID/revision, same reviewed commit; local execution-call count stays 2 (one interrupted and one completed), completed-step count stays 1; final review is refreshed |
| Approve recovered subtraction result once | PASS | Exactly one additional branch, committed files independently pass 4/4 tests; source remains clean on original `main`, two branches total |

`rg` succeeds with actual math-file matches (exit 0) in the ordinary trial
workspace, without a manual parent PATH prefix. Known personal Agent Mail/Babel
MCP tool names are absent from the recorded private-frontier sessions inspected;
this is a bounded observation, not exhaustive plugin/policy validation.

An executed failing-test live observation, abrupt crash/power-loss durability and
complete browser presentation remain NOT RUN unless separately demonstrated.

The Windows shell test report has an empty output string despite successful exit
status; independent Node runs on reviewed/committed files establish the 4/4 pass
above. A separate native deliberately failing test through the same command runner
returns exit 1 (no timeout), so empty captured output is not treated as success.
This command-runner control is offline evidence, not a live F8 step-gate run.

## Remaining work and review boundary

The native service workflow above passes in the ordinary trial layout. P08 is
still a partially validated candidate: recurring UAC, packaged-app profile-path
identity handling, empty captured Windows test output, full browser presentation,
live failing-step gating and abrupt/power-loss recovery are not closed by this
report. The profile-path refusal and UAC observations should drive bounded
follow-ups after review; do not relax workspace identity or approval checks.

The probe-role correction and this report are submitted together for independent
review. No client deployment, remote credential extraction or shared-worker
shutdown is performed. The isolated Conductor service is stopped after the test;
the separately authorized LocalAI worker is left running.
