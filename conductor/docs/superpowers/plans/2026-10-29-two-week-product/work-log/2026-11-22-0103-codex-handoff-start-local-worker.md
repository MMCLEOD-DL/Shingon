# Codex handoff — start the local worker: contract and service

Packet: next.md item 7, W1–W8 (P05/P07 backend); owner Codex / BlueLake, Claude reviewer and subsequent UI owner. Branch codex/start-local-worker. Baseline694d75d includes PR161 finalf2e9314, verified merged. Final production code2e652180c094c66bacf0ebea4b0f90b9145ae10d; initial implementation73c5a8e. Malcolm's direct22November scope supersedes routine backlog. Hoon/PR158 review cancelled: no further Hoon work.

## Result and boundaries

- Optional trusted on-disk local.worker is parsed with loadConfig: argv startCommand, credential-free HTTP(S) readyUrl, startTimeoutMs default180000. Any argument containing -ExecutionPolicy in any case is refused. No shell, policy override, implicit elevation or second script.
- GET/setup exposes only worker.startConfigured. Browser PUT/setup and POST/setup/validate reject the worker section, including read-only echoes; other saves preserve it and setup never creates a command. Plain-HTTP readiness is separate from unchanged model/setup HTTPS-or-loopback validation.
- Start appears only on the pre-run worker-offline question with a configured command. Unauthorized/model-missing/unavailable and mid-run questions get no start action. No separate endpoint, setup-page Start control or UI page implementation.
- Existing decision answer path preserves expectedRevision/clientRequestId. One accepted start leaves the question pending; all second answers during it get409/worker-start-in-progress. Saved receipts replay without a second command after completion/restart. Failure and readiness timeout rotate the revision; only timeout offers explicit Try again.
- Readiness is checked first, without Authorization, cookies or redirects. An initial200 skips the command and says the worker is up but busy. Command success starts bounded readiness polling. A200 sends a distinct worker-started IPC answer; prepare/buildTeam runs again. Only a fresh healthy probe continues locally. No outcome chooses subscriptions automatically.
- Non-zero/launch/command-timeout failures keep only Pause and Use subscriptions, with the exact heading “The start command failed. Nothing else was tried.” The last output is redacted before clipping, terminal controls removed, up to eight lines/600characters. Readiness timeout keeps Pause / Use subscriptions / Try again.
- local-worker-start/wait/ready/failed progress is saved/replayed with optional decision.workerStart state. Command/config fields never enter run metadata or setup output.
- Independent detached launcher and command use windowsHide and credential-free strict child environments, outside engine child tracking. Configured provider variable names are also removed case-insensitively; database credential URLs are omitted. The trusted launcher receives redaction strings via private IPC only, never in the configured command environment or browser. No launcher output/status file.
- Launcher handshake5seconds, command30seconds, parent outcome watchdog35seconds, bounded pipe-drain grace; readiness budget starts after command success. A late200 cannot overrun that budget. Cancel/finish/killAllChildren/service-close/abrupt-parent death never call tree/group cleanup on this launcher/worker. Only an over-deadline short command may be terminated by its PID. Active starts are abandoned, not resumed, after service restart.
- A start script must itself create a long-lived keeper. Node stand-ins on Windows explicitly detach their keeper because Node's own child job otherwise terminates it on script exit. Native synthetic tests verify a live heartbeat/HTTP readyz after parent termination, not merely an unreaped PID. Actual PowerShell/WSL/Docker/script compatibility, console/UAC and live model start remain unrun by scope.

Owned seams: src/config.js and new src/localWorkerConfig.js; service/config.js, runs.js, worker.js, server.js and new localWorker.js/localWorkerLauncher.js; interface.md; both contract-v1.json copies; fake-worker.cjs, guarded synthetic service host, local-worker.test.js and engine.test.js. team.js, conductor.js and chunkPhase.js are unchanged. Only the explicitly authorized operator-web fixture copy changed; no UI source, manifest or lock changes.

## Native Windows evidence

Host Node v24.12.0; cwd E:/SHINGON-codex-native-review/conductor unless stated otherwise.

- Feature checks: node --test --test-reporter=tap test/service/local-worker.test.js —24pass/0fail/0skip at final code, exit0,13811.884ms. Covers all W1–W8 examples with fake command/readiness, 70second fake clock, real literal argv, environment/output/privacy controls, duplicate answers, failure/timeout/retry, restart and actual synthetic keeper survival.
- Real engine seam: node --test --test-reporter=tap --test-name-pattern='start-worker re-enters' test/service/engine.test.js —1pass/0fail/0skip, exit0,3446.4748ms. Real prepare/buildTeam re-probe reaches the local executor with stand-in model CLIs; no subscription fallback answer.
- Broader service/config command: node --test --test-reporter=tap test/service/*.test.js test/config.test.js test/config-bom.test.js —121total/120pass/1fail/0skip, exit1,38759.4314ms. Sole failure is existing W193, real-launcher Windows exit status. It remains OPEN and is not waived.
- UI fixture consumers, from operator-web: npm test —113pass/0fail; npm run build PASS. node e2e/journey.mjs with existing global Playwright via temporary NODE_PATH —22fixture-service +6real-engine +4resume/fallback checks PASS, exit0. Initial direct invocation could not resolve local Playwright; existing global installation resolved it without installing anything. These are existing browser regressions, not the new Start page, which Claude owns.
- Complete final native: node --test --test-concurrency=4 --test-reporter=tap —1792tests/1745pass/46fail/1skip/0cancelled, exit1,647634.7069ms at2e65218. Exact file/test-name reconciliation: same46original failures,0new/0resolved. All201inventory rows unchanged,155FIXED_NATIVE/46OPEN. Full native suite remains red.
- Earlier complete run73c5a8e had the same1792/1745/46/1,617266.9957ms. Additional overlapping-value control then failed0pass/1fail: a shorter redaction could expose fragments of a longer case-variant provider value. Corrected to longest-first at2e65218, all24feature cases passed, and the complete native run above was repeated on that exact corrected code. No actual secret was involved.
- Native forced termination case uses taskkill /F on only the disposable synthetic service PID. The fake worker still answers200 afterwards. Cancel, run end, service close and engine cleanup also preserve its executing heartbeat. Linux uses SIGKILL in the corresponding test; no platform skip substitutes for survival.

Private TAP/browser logs remain under the task temporary log names and private coordination area, outside Git. No raw private trace or actual credential material is committed. No real worker, model, WSL, remote machine, host policy or shared service operation was performed. No Hoon review/development.

## Linux evidence

Not run locally: no WSL call. GitHub Linux CI will be recorded separately before final submission/readiness. The high-risk service path needs Malcolm's label or merge under the existing risk-gate; Codex leaves auto-merge off and never changes labels, workflow or repository settings.

## Claude UI handoff after merge

Use interface.md and the two byte-identical contract-v1.json copies. New examples: workerOfflineConfiguredDecision, workerOfflineUnconfiguredDecision, workerUnauthorizedDecision, workerStartInProgressDecision, workerStartFailedDecision, workerStartTimeoutDecision, setup configured/unconfigured projections, progress events and the409in-progress error. fake-worker.cjs distinguishes pre-run/mid-run and worker-started; the service/fake commands own failure/timeout behavior.

Render only offered choices; show pending workerStart/progress, failed output and timeout retry. After failure/timeout read the fresh revision and use a new request ID for a new action. Do not automatically retry a409 or select subscriptions. No setup Start control or mid-run action. Actual live worker proof requires a later operator-authorized run after the UI lands.

P05/P07/P08 broader acceptance remains IN_PROGRESS; this completes only the requested contract/service subpacket once reviewed/merged. Current chat owns Linux evidence/final submission/checks; no next task before Malcolm's final merge.

