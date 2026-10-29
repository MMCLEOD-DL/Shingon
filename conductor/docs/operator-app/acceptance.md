# Backend candidate validation — 29 October 2026

P00/P03 and initial P05 backend evidence; this is not acceptance of a finished GUI or native Windows product. Claude UI integration and peer review remain pending. No live subscription or actual local-model requests were made.

## Demonstrated

Host: Debian 13 Linux cloud environment; Node 24.19.0; npm 11.9.0. Personal target chosen by Malcolm: Windows browser + native Windows service process (not yet verified).

- From `conductor/`, `node --test test/service/*.test.js`: **25 passed, zero failed**, including actual launcher start/stop/start without model calls, HTTP boundaries, singleton data ownership, idempotency, stale approvals, storage failure, SSE replay, probes, and engine integration.
- The **real Conductor engine**, with deterministic local Claude/Codex CLI stubs, produced a file, ran and passed the configured tests, exercised both vendor adapter roles, presented the actual diff and created the approved branch. Source HEAD/index/files remained clean. This validates integration, not live inference.
- Editing work after review caused stale-decision; no branch landed. Service stop/restart + explicit resume invalidated the old question, issued fresh evidence and did not repeat the completed coding step.
- Probe checks distinguish installed executable, authenticated challenge and actual nonce-file creation. Missing/unauthenticated/irrelevant responses do not become ready states.
- Windows cmd.exe descriptor was tested on Linux; this is not a native execution test.
- Full Conductor regression with the initial 24 service checks: **1,535 passed, zero failed/skipped/cancelled**, 72.04 seconds. The final broad rerun, including the launcher test, passed **1,536 tests**, zero failed/skipped/cancelled, in 69.97 seconds. A small subsequent worker-error lifecycle correction was checked with the focused service suite.

Broad command, from `conductor/` after sourcing the cloud setup environment: `python3 /workspace/shingon-dev/reap.py node --test --test-concurrency=4`. The wrapper handles this container's orphan reaping; it is not a new product dependency. Preserve underlying exit codes when capturing logs.

## Separate P01 fix

Branch `codex/update-settings-safety`, commit `b25e2bf`, is independent of this service branch. **110 focused Foundation ops tests passed**, including five real-file failure-injection regressions; Foundation typecheck and focused ESLint passed. Claude review and full integrated Foundation verification after P02 remain required. The fix is not merged merely because service tests pass.

## Unproven or external gates

- Claude UI, accessibility, reconnect presentation, evidence display and decision wiring.
- Actual subscription sign-in and LocalAI/Qwen Responses API agentic execution on the selected host.
- Native Windows install/start/restart, CLI discovery, descendant cancellation and filesystem durability.
- Power-loss recovery. Current restart test uses the shutdown path; it does not certify abrupt OS/power failure.
- A Windows Service Control Manager installer/autostart. Current launcher runs a native Node service process in the foreground.
- Client deployment and knowledge-base migration; neither attempted.

## Review focus

Review bootstrap/Host/Origin/cookies and bounded HTTP/SSE routes in `src/service/server.js`; persisted decisions, evidence checks and lifecycle in `runs.js`/`worker.js`; storage/lease handling in `state.js`/`lease.js`; config preservation and explicit probes in `config.js`/`probe*.js`. Review shared Windows changes in `src/exec.js` and `src/workspace.js` carefully.

Claude's integration entry points: `interface.md`, `architecture.md` and `test/fixtures/operator-app/contract-v1.json`. Mock transport is never live evidence; an accepted answer is never branch completion. No automatic merge, release, deployment or publication was performed.

## PR #2 update after merging main (29 October)

Merged main at `675233d`, preserving both lanes' work-log history and bringing in Claude's UI, OCR fix and research. Resolved the actual text conflict in the shared work-log table and handoff sections. The source modifications following the merge address Claude's blocking P3-1 cancellation/landing race, P3-2 asset responses, and the small P3-4/P3-5 wording/documentation notes. P01 remains a separate branch.

Validation of the combined branch: 29 service tests pass; 45 operator-web tests pass; UI production build passes. Two P3-1 regressions fail on the original `a8c97bc` backend and pass here. They create a real synthetic source branch before delayed delivery or worker exit; the delay/worker is synthetic, not live inference. New startup recovery and asset-error regressions also pass. Full combined suite result is recorded in the work log after completion.

The browser journey was attempted, but this instance lacks Playwright Chromium. Installation to the writable workspace cache was refused by the network proxy with HTTP 403 Domain forbidden for cdn.playwright.dev. No browser journey is claimed for this update. Claude's historical 13/13 journey on another instance remains historical evidence, not a rerun here. Native Windows and live models are still unverified.

Final combined validation for the PR #2 update: **1,541 Conductor tests passed, zero failed/skipped/cancelled** (70.40 seconds); **45 UI tests passed**, UI build passed. The launcher regression now verifies the built UI when present instead of assuming the pre-UI placeholder. No unresolved Git conflicts remain; main at 675233d is an ancestor of the review branch. Browser rerun remains blocked as described above.
