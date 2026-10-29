# Proposed operator-app contract v1

**Status: proposal for P00 to freeze, not an implemented API.** Codex owns service implementation; Claude owns UI consumption. Agree on fixtures before diverging. Changes require both owners' acknowledgement and a version/fixture update. Internal engine events need not become permanent public API shapes.

## Service and persistence boundary

- One local service process, bound to loopback only, serves built UI assets and `/api/v1/` on the same origin. A separate Vite development origin, if used, must be explicitly restricted in development; production has no permissive CORS.
- The service owns config references, registered repositories, run mappings, normalized events and pending decisions. The existing Conductor engine owns its workspace, Git operations and completed-step state. Keep service metadata outside agent-writable workspaces. Define configurable data/cache paths for Linux and the designated Windows/WSL topology in P00.
- The browser owns no model credentials and cannot supply executable names, executable arguments or arbitrary shell commands to a generic endpoint. Registered repository IDs and run IDs are opaque service-generated identifiers; canonical paths remain server-controlled.
- A single active coding run or model probe at a time in v1. Return a conflict rather than start a second process. The UI may show multiple historical runs. This restriction avoids pretending current process-global child tracking is run-scoped.
- Persist state/decision updates atomically, account for post-rename uncertainty, and reconstruct interrupted runs conservatively. A service restart does not silently resume work or auto-answer a prompt.

## Common shapes

`RunSummary`:

```
{ id, repositoryId, title, createdAt, updatedAt,
  status, phase, resumable, lastEventSeq,
  activeDecisionId: string|null,
  workspaceCommit: string|null, landedBranch: string|null,
  coverage: { local: 'used'|'not-used'|'unknown',
              vendors: string[], weakened: boolean, reasons: string[] } }
```

Statuses: `queued`, `running`, `awaiting-decision`, `paused`, `interrupted`, `completed`, `rejected`, `failed`. A queued run may only be accepted when capacity can be reserved; v1 need not implement a multi-run queue. `completed` maps to an engine success whose resulting branch is known; it does not mean merged, released or deployed. `resumable` is validated from engine state, never inferred just from a label.

`Event`:

```
{ schema: 1, runId, seq, at, type,
  phase: string|null, participant: string|null,
  message, data: object }
```

Normalize existing redacted engine events into a bounded allow-listed shape. Sequence is monotonically increasing per run and persisted before broadcast. Replay after a sequence is ordered; duplicate delivery is acceptable, duplicate application is not. If replay is unavailable or cursor invalid, return an explicit resync requirement and canonical state. Do not equate transport loss with a run failure.

`Decision`:

```
{ id, runId, kind, createdAt, status: 'pending'|'resolved'|'invalidated',
  prompt, choices: [{ id, label, consequence }],
  evidence: { commit: string|null, diffId: string|null, testReportIds: string[] },
  revision, resolvedAt: string|null }
```

Kinds cover result approval, escalation, local fallback, optional plan/chunk approval. The service translates explicit choice IDs into each engine hook's existing return type. Do not assume every hook takes a boolean. Freeze a fixture for every used kind. A result approval requires the displayed commit/diff/evidence; missing or changed evidence invalidates the prompt. A browser-supplied text field can be feedback, never a replacement executable command or fabricated approval record.

`ConnectionStatus` separates checks:

```
{ participantId, adapter, executable: 'found'|'missing'|'unknown',
  authentication: 'verified'|'required'|'unknown'|'not-applicable',
  endpoint: 'reachable'|'unreachable'|'unknown'|'not-applicable',
  agenticExecution: 'verified'|'unknown', checkedAt: string|null,
  probeKind: 'installation'|'authenticated'|'agentic',
  reason: string|null, action: string|null }
```

Omit secrets, sensitive raw endpoint query strings and account identifiers. Last successful probe is historical; show its time. Successful local chat does not establish agentic Responses API compatibility. Authentication has no verified state without a real authenticated operation.

## Endpoint sketch to freeze in P00

| Method/path | Contract |
|---|---|
| GET `/health` | Service ready/version; no secrets or raw environment |
| GET `/setup` | Sanitized config and participant check status |
| POST `/setup/validate` | Validate proposed non-secret configuration; no model request or install side effect |
| PUT `/setup` | Atomically save validated settings, preserving unrelated existing config |
| POST `/participants/:id/probe` | Explicit bounded probe with requested kind; conflict if another active operation |
| GET/POST `/repositories` | List/register canonical accessible Git roots; registration grants only this local user's selected scope |
| GET `/runs` | Bounded, paginated run summaries |
| POST `/runs` | `{repositoryId, request, presetId, clientRequestId}`; idempotent creation; return 202 with run ID |
| GET `/runs/:id` | Canonical summary and currently pending decision |
| GET `/runs/:id/events?after=N` | SSE stream with replay; JSON snapshot/replay fallback if needed |
| GET `/runs/:id/review` | Exact commit/diff artifact and actual test results; bounded/paginated large content |
| POST `/runs/:id/decisions/:decisionId` | `{choiceId, expectedRevision, reviewedCommit, clientRequestId, feedback?}`; reject stale evidence |
| POST `/runs/:id/cancel` | Idempotent request; acknowledge request separately from confirmed process cessation |
| POST `/runs/:id/resume` | Validate saved workspace/repository/state; explicit restart; reject invalid or already-active run |

All paths are beneath `/api/v1`. Pick one event transport in P00; SSE is the default proposal. Do not add WebSockets merely for future features. Tests commands come from a confirmed named preset or a separately confirmed repository configuration. V1 need not expose arbitrary command editing in the browser. Saving config cannot cause automatic model calls, package installs or wake commands.

Errors: `{error: {code, message, retryable, requestId}}`, with appropriate 400/401/403/404/409/413/429/500 status. No stack, credential, raw process environment or arbitrary filesystem contents. UI treats unknown codes as errors, never completion. Create/decision idempotency keys must be stored durably with body identity; conflicting reuse returns 409.

## Browser and approval safeguards

- Use a cryptographically random per-session capability, delivered by a local bootstrap and stored in an HttpOnly/SameSite cookie where supported. Do not put it in a query string, localStorage, model context or logs. Freeze a concrete bootstrap/session/CSRF design before implementing mutation endpoints; a path on localhost alone is not authentication.
- Validate Host against the configured loopback host/port and Origin against the actual UI origin; protect against DNS rebinding and cross-site requests. Require capability/CSRF protection for mutations and appropriate checks on reads/streams. Refuse accidental non-loopback binding. Support an explicitly documented local browser access topology; no unauthenticated LAN mode.
- Bound request bodies, artifact size, event buffers and outstanding decisions. Escape output, strip terminal control sequences, and allow-list link schemes. No raw HTML rendering of model/diff/document content.
- Tie every decision to one pending hook and state revision. Record resolution durably before continuing once, with fail-closed handling if persistence is uncertain. Revalidate commit and required checks at approval, not only when the screen first loaded.
- CLI prompts continue through their original adapter. Browser prompts use service hooks. Engine logic must not depend on DOM state or terminal response parsing.
- A disappeared UI never defaults to consent. A rejected answer or cancel cannot report that a branch landed; a requested cancel cannot report all descendants stopped until checked.

## Required contract fixtures

Commit sanitized examples for: initial setup; missing CLI; authenticated probe; local down; running with local author; weakened vendor coverage; awaiting each decision kind; stale decision; reconnect replay; failed required tests; missing test report; approved branch; rejected result; interrupted resumable run; corrupt/unresumable run; service busy; malicious diff/log strings. Include request/response examples for happy and error paths.

P03 tests service output against these fixtures; P04 tests its API client and screens against the same version. P07 adds browser-to-real-service tests. A matching fixture alone is not proof the real engine behaviour works.
