# Operator app backend v1: UI handoff

Status: implemented backend candidate; Claude review and UI integration pending. This concretises the proposed plan contract; it does not claim bilateral freeze. Default service: Node's HTTP server, same-origin API and SSE, one isolated engine worker per active run. No new runtime dependencies.

Start from `conductor/` with `npm run app -- --config <existing-config.json> --data <local-state-directory> --port 4318`. Node 22.13+ and Git are the intended shared toolchain. `operator-web/dist` is served when Claude's build exists. Until then, the root page explicitly says the UI has not been built.

## Bootstrap in Claude's UI

The launcher prints a private URL whose fragment contains `bootstrap=<random-token>`. On initial page load, parse that fragment in memory, clear it immediately with `history.replaceState`, then POST `{bootstrapToken}` to `/api/v1/session`. No token in query strings, localStorage, console logs or model context. The HTTP fragment is not transmitted by the browser. Bootstrap is single-use, expires five minutes after server start, and yields an HttpOnly/SameSite=Strict cookie. Reloads use that cookie. After a service restart the operator must use the new bootstrap link.

All other `/api/v1` reads/streams/mutations require the cookie. Use same-origin fetch credentials and SSE. The service accepts exactly its printed `127.0.0.1:port` Host/origin, not an arbitrary LAN name or localhost alias. Mutations need the browser's same-origin Origin header. Do not expose a permissive Vite proxy/CORS exception; serve the built UI from this origin for integration. A shell/network extension cannot bootstrap without the private capability.

```js
const token = new URLSearchParams(location.hash.slice(1)).get('bootstrap');
if (token) {
  history.replaceState(null, '', location.pathname + location.search);
  const res = await fetch('/api/v1/session', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken: token }),
  });
  if (!res.ok) { /* show restart/sign-in guidance; never silently simulate */ }
}
```

## Implemented wire details

- GET `/setup`: configured flag, sanitized participants, local model/endpoint, default test preset and routing. Probe statuses are historical with checkedAt; settings edits invalidate cached probe results. Existing CLI config fields not managed by the browser are preserved.
- POST `/setup/validate` and PUT `/setup` accept only `{local:{baseUrl,model},routing:{author,reviewer,local}}`, either section optional. The initial setup requires local model configuration and creates the three default participants. Browser cannot set executables, keys, shell commands or API adapters. Plain HTTP endpoints are loopback-only; existing remote routes require HTTPS. Secrets stay in supported host environment/CLI authentication.
- POST `/participants/:participantId/probe` takes `{kind:'installation'|'authenticated'|'agentic'}`. Installation executes only `--version`. Authenticated and agentic checks use bounded synthetic prompts in a disposable Git directory; the latter verifies a fresh nonce file actually exists. These are user-initiated and may consume subscription allowance. No background authenticated probes. The production launcher enables this worker; direct `createAppServer` tests can inject a fake probe.
- GET `/repositories` returns `{repositories:[...]}`; POST accepts `{path:<absolute Git root>}` and returns the registered repository. User confirms this local filesystem scope. Browser folder selection alone is not backend authorisation.
- POST `/runs`: `{repositoryId,request,presetId:'default',clientRequestId}`. The default test command comes from the trusted on-disk Conductor config. Returns 202 with RunSummary. No arbitrary browser test-command endpoint. Same request ID/body replays; conflicting reuse or a second active operation returns 409.
- GET `/runs`: `{runs,nextCursor}` with up to 50 newest-first records; use `?cursor=<returned offset>`. GET `/runs/:id` adds `decision` (or null). Internal workspace path and raw request/idempotency metadata are not returned.
- GET `/runs/:id/review`: actual engine summary, diff, files, tests, commit/diffId/testReportIds, and final review/council when provided. Do not render model text as HTML. Missing or failing tests must remain visible. This is not a general file-download endpoint.
- GET `/runs/:id/events?after=N`: `text/event-stream`, **event name `run`**, numeric `id`, JSON Event data. Add `source.addEventListener('run', handler)` rather than only `onmessage`. Track the largest applied sequence and reconnect using that `after` query; server does not use Last-Event-ID. Future/invalid cursors return 409/resync-required. GET the run snapshot to recover. Duplicate delivery may happen; duplicate application must not. The SSE connection alone does not control worker lifetime.
- POST `/runs/:id/decisions/:decisionId`: `{choiceId,expectedRevision,reviewedCommit,clientRequestId,feedback?}`. `reviewedCommit` must be explicitly null for decisions without Git evidence. Result/plan/chunk choices are approve/reject; escalation approve/reject returns engine strings; fallback choices **continue/pause** return engine booleans. Feedback is optional, bounded, and only becomes a rejection note for a result. Success `{accepted:true,decisionId}` means the answer was saved/delivered, not that work finished or a branch landed. Observe canonical run state afterward.
- POST `/runs/:id/cancel`: 202 `{requested,status}`. `cancelling` is a request, followed by `interrupted` when the worker exits. Pending prompts become invalid. A successful engine result racing ahead of cancellation remains a known completed result, not rewritten as an imaginary rejection.
- POST `/runs/:id/resume`: 202 RunSummary, explicit re-entry through engine resume. Completed steps remain in engine state. Old decision IDs do not revive; fresh review is required. Engine validates saved workspace/repository before continuation. Config edits/probes/runs conflict with active work.
- GET `/health` is authenticated and reports service readiness only, not model or client-app health.

Errors use `{error:{code,message,retryable,requestId}}`. HTTP status is authoritative. Implemented codes include unauthorized (401), forbidden (403), invalid-request/invalid-json (400), not-found (404), busy/conflict/stale-decision/not-resumable/resync-required (409), too-large (413), rate-limit/stream-limit (429), and storage-unavailable/probe-failed (503). Do not rely on every error being retryable. Unknown errors become a generic message, without a stack/environment dump.

## Data and process limits

Maximum API body 32 KiB, task 16,000 characters, feedback 2,000, review payload 1 MiB, 5,000 normalized events per run, 500 retained run records, 16 MiB service-state snapshot, 8 SSE streams, 300 API requests/minute per process. Oversized reviews stop with CLI guidance; the UI must not display a clipped review as complete. Store metadata only on a local disk. A kernel-owned loopback lease prevents two processes from owning the same data directory even with different HTTP ports; an unrelated lease-port collision fails closed with guidance to select another data directory.

Persistent state is `service-state.json` outside workspaces; the engine's own `.conductor` sidecars remain authoritative for completed coding work. A write failure blocks mutation and stops the owned worker; restart/repair is explicit. Browser refresh does not answer questions. Startup converts active persisted runs to interrupted and invalidates old questions. A rejected/completed engine run may archive/delete its workspace; do not offer resume simply because a historical path exists.

## Consumer fixtures and tests

Use `test/fixtures/operator-app/contract-v1.json` for UI states and `fake-worker.cjs` only for transport tests. The JSON includes result/escalation/plan/chunk/fallback decisions, stale errors, failed/unrun tests, malicious content and terminal states. These are synthetic fixtures, not live acceptance evidence.

`node --test test/service/*.test.js` covers the service, probes and real engine with deterministic model CLI stubs. No live models or accounts are called. Real-engine tests verify actual test output and Git branch creation, reject changed evidence, and restart/resume without another completed chunk. UI and native Windows acceptance remain separate gates.
