# Work log and decision ledger

Created 29 October 2026. Codex claimed P00/P01 on 29 October 2026. Claude is being assigned separately by Malcolm; no Claude acknowledgement has been received here. Interface v1 is not yet peer-frozen. Replace provisional owner names when someone claims a task. Each row needs evidence before DONE.

| Packet | Provisional owner | Status | Branch/checkout + baseline | Result/review/integration evidence |
|---|---|---|---|---|
| P00 | Codex | IN_REVIEW | codex/operator-app-v1, fc72b79 | Concrete interface/ADR and fixtures published; Claude acknowledgement pending |
| P01 | Codex | IN_REVIEW | codex/update-settings-safety, fc72b79 | b25e2bf; 110 focused tests + Foundation types/lint pass; Claude review/full integrated verification pending |
| P02 | Claude | NOT_STARTED | — | — |
| P03 | Codex | IN_REVIEW | codex/operator-app-v1, fc72b79 | HTTP/IPC service, persistent decisions/replay/recovery; deterministic real-engine tests pass; UI/peer review pending |
| P04 | Claude | NOT_STARTED | — | — |
| P05 | Codex | IN_PROGRESS | codex/operator-app-v1, fc72b79 | Launcher/setup/probe implementation; native Windows and actual account/model acceptance blocked on host access |
| P06 | Claude | NOT_STARTED | — | — |
| P07 | Codex + Claude review | IN_PROGRESS | codex/operator-app-v1 | Backend boundary/engine integration checks pass; UI integration and cross-review pending |
| P08 | Codex + Claude review | NOT_STARTED | — | — |
| P09 | Claude | NOT_STARTED | — | — |

## Decisions to settle in P00

| Decision | Proposed default | Status / evidence |
|---|---|---|
| Acceptance host/topology | Windows browser + native Windows service | USER SELECTED 29 Oct; Linux engineering checks do not prove Windows support |
| Product scope | Local browser app; ordinary repository coding; one active operation | PROPOSED |
| Service transport | Same-origin HTTP API + SSE | PROPOSED |
| UI placement | Separate Conductor React/Vite package, no Foundation UI changes | PROPOSED |
| Auth/bootstrap | Loopback + validated Host/Origin + session capability/CSRF | DESIGN REQUIRED |
| Service state path/schema | Outside agent workspace; platform-aware configurable location | DESIGN REQUIRED |
| Versions/dependencies | Compatible pinned Node/tooling and permissive licences | INVENTORY REQUIRED |
| Knowledge-base stack | No selection before cited comparison and evaluation | OPEN |

## External prerequisites

- Current model endpoint/name and supported access route: unverified; owner Malcolm/acceptance-host operator.
- Claude Code and Codex authenticated on acceptance host: unverified; owner Malcolm. CLI installation alone is not authenticated readiness.
- Library of Babel read-only inventory/export interface: unverified; owner Malcolm/source operator. Research can proceed without private data access.
- Optional browser-test download permissions/system libraries: prior cloud setup blocked `cdn.playwright.dev`; a network addition was saved for review, but its application and browser installation are not established by this plan.

## Session entries

Append dated entries using the handoff template in `03-parallel-working.md`. Capture owner, exact SHA, evidence, reviewer and next action. Do not copy credentials or historical automation prompts into this ledger.

## 29 October — Codex claim

Baseline a8ffb910508ff3e9e172aa04c56a53f6758e8509. Codex owns P00/P01 then service/setup (P03/P05); leaves OCR, operator-web and KB research to Claude. Malcolm selected native Windows service/browser. No Windows execution host is available in this cloud task; native cancellation and installation remain explicit acceptance gates. Proposed dependency-free Node HTTP/IPC service and single active worker preserve CLI/engine isolation. Shared interface remains pending peer review; backend publishes concrete fixtures for UI consumption.

## 29 October — Codex backend handoff

- P01 fix is on `codex/update-settings-safety`, commit `b25e2bf`. Five new real-file failure-injection regressions cover pre-rename, directory-open/sync after rename, repeated restoration sync failure and unreadable tag recovery. 110 focused tests, Foundation typecheck and focused ESLint passed. It is separate from the service branch; do not assume it is merged.
- `codex/operator-app-v1` contains P03/P05 candidate service, bounded same-origin HTTP/SSE API, one-time bootstrap, per-operation worker processes, repository registration, persisted/idempotent decisions, evidence drift checks, history/resume, setup and explicit challenge/file-based probes. No paid API calls or real model probes were made.
- The service uses Node built-ins. Shared seam changes: Windows cmd.exe test execution and PID-scoped taskkill cancellation; native acceptance remains unverified. Production startup is `npm run app`; no UI files are changed.
- Claude: read `conductor/docs/operator-app/interface.md` and `architecture.md`, and consume `conductor/test/fixtures/operator-app/contract-v1.json`. SSE event name is `run`; fallback choice IDs are `continue` / `pause`; other approvals are `approve` / `reject`; send reviewedCommit=null when the decision has no Git evidence. Fetch this branch for backend integration; propose interface changes explicitly.
- Broad Linux Conductor regression passed 1,535 tests with the cloud orphan-reaping wrapper. Subsequent focused launcher tests cover a real start/stop/restart without any model calls. Final command/count details are in `conductor/docs/operator-app/acceptance.md`.
- Git pushes work. `gh pr create` failed with GitHub API Forbidden; no PR was created. Branches remain directly reviewable. No automatic merge or client ship.
- External gates: Claude UI/peer review, native Windows host installation/cancellation, and supported sign-in + configured local-model access for live acceptance. These are not inferred from Linux or mock results.
