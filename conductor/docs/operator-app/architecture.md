# ADR 001: local operator service over the existing Conductor engine

29 October 2026. Backend implementation proposal for cross-review; consumer contract acknowledgement pending. Malcolm selected a native Windows service process and Windows browser as the personal acceptance topology.

## Decision

Use Node built-ins for a same-origin loopback HTTP/SSE service, with a separate child process for each coding run and each explicit connection probe. Serve Claude's independently built React/Vite operator UI from Conductor's own package. No extra production service dependencies, no hosted control plane, and no Foundation account database in the harness.

The existing `runTask`/`resume` entry points and hooks remain the orchestration engine. A worker adapts hook return types to browser decision choices, without parsing terminal output. `RunLog` continues to own completed coding state and transcripts. The service owns repository registration, run-to-workspace mapping, normalized events, pending browser decisions, idempotency receipts and historical connection status in a local data directory outside the agent working copy.

## Why one worker and one operation

`src/exec.js` tracks running children in a process-global set. Running multiple tasks in that process would make cancellation unsafe. Each operation now gets a disposable process, and the API refuses a second active run/probe. There is no promise of multi-run concurrency or a scheduler. UI disconnects do not kill the worker. Parent disconnect/service shutdown stops the owned worker and its tracked children; native Windows cancellation still requires real-host acceptance.

A kernel-owned loopback lease derived from the canonical data directory prevents two service instances on the same host/network namespace from editing the same state, even when HTTP ports differ. This avoids inventing another stale-file-lock takeover protocol. Hash/port collisions fail closed; use another data directory if an unrelated process occupies that lease port. Shared/network filesystem deployment is unsupported.

## Decisions and recovery

Before broadcasting a decision, persist it with revision, worker question ID and review evidence. Before approval is forwarded, verify the same clean workspace/commit/diff; the worker repeats that check immediately before resolving its hook. A late change refuses approval and requires explicit resume/review. Duplicate answers replay only the recorded receipt; conflicting/stale answers are refused.

On service startup, formerly active persisted runs become interrupted and old decisions invalid. Explicit resume re-enters the engine from its saved completed steps and creates new hooks/questions. An in-memory promise is never treated as restorable. Engine result status, not an HTTP answer acknowledgement, determines branch completion. Store failures poison the service's mutation path and stop the owned operation; no approval is forwarded after a failed save. Retain evidence for repair/recovery rather than attempting an unsafe automatic rollback of JSON in memory.

State writes flush a temporary file and rename. POSIX also flushes the directory. Windows cannot consistently expose directory fsync, so its power-loss behaviour remains an acceptance limitation, not a guaranteed durable commit. For ordinary process interruption, the saved engine state and regenerated decisions provide recovery.

## Local browser trust boundary

Loopback alone is insufficient against malicious web pages. Exact Host/origin/fetch-site checks, bounded requests, one-time short-lived fragment bootstrap and an HttpOnly/SameSite session cookie guard the API. The capability is not inherited by model processes. No arbitrary shell, executable, credential or file-download API is exposed. The browser selects a registered Git root and a trusted configured test preset; model/diff/document text is untrusted data.

All artifacts/decisions are bounded. API responses never dump the process environment or subscription session files. Explicit probe/run workers drop API-billing key variables while preserving supported CLI subscription authentication. Current local credentials use existing envKey bindings. User-triggered authenticated probes may consume subscription allowance; merely opening setup does not run them.

## Native Windows seam changes

The old test command always used `sh`. It now chooses cmd.exe on Windows with AutoRun disabled, while retaining the POSIX shell elsewhere. Child-tree cancellation uses taskkill against the tracked numeric PID on Windows, with existing process-group handling on POSIX. These are small shared engine changes requiring reciprocal review and native-host verification. Vendor-supported native CLI executables are the intended target; npm .cmd shim support is unverified.

## Alternatives deferred

- Terminal scraping: rejected because prompts/status are presentation and cannot safely carry durable approvals.
- A second engine or copying Foundation's server/auth stack: duplicates behaviour and mixes operator and client concerns.
- Electron/Tauri and a registered Windows Service: deferred until the local workflow and native subprocess behaviour are proven.
- WebSockets: unnecessary for one-way progress; SSE plus ordinary POST decisions is sufficient.
- Concurrent runs: deferred until process ownership and cancellation contracts support them explicitly.

## Evidence and remaining gates

Automated checks use deterministic local CLI stubs, not real subscriptions or a real local model. They exercise the existing engine's Git/test/approval/resume path. The HTTP/worker transport fixture is separately labelled synthetic. Full CLI regression, peer review, Claude UI integration and native Windows/live-model acceptance are required before declaring a personal app ready. See `setup.md`, `interface.md` and the packet work log.
