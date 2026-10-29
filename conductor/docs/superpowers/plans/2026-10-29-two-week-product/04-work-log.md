# Work log and decision ledger

Created 29 October 2026. Codex claimed P00/P01 on 29 October 2026. Claude is being assigned separately by Malcolm; no Claude acknowledgement has been received here. Interface v1 is not yet peer-frozen. Replace provisional owner names when someone claims a task. Each row needs evidence before DONE.

| Packet | Provisional owner | Status | Branch/checkout + baseline | Result/review/integration evidence |
|---|---|---|---|---|
| P00 | Codex | IN_REVIEW | codex/operator-app-v1 | Concrete API/ADR/fixtures ready; Claude acknowledgement pending |
| P01 | Codex | IN_REVIEW | codex/update-settings-safety | b25e2bf; 110 focused tests + types/lint passed; review/integrated Foundation checks pending |
| P02 | Claude | NOT_STARTED | — | — |
| P03 | Codex | IN_REVIEW | codex/operator-app-v1 | Backend a8c97bc; full regression and engine integration pass; UI/peer review pending |
| P04 | Claude | NOT_STARTED | — | — |
| P05 | Codex | IN_PROGRESS | codex/operator-app-v1 | Setup/probes/launcher implemented; native Windows/live-model acceptance pending |
| P06 | Claude | NOT_STARTED | — | — |
| P07 | Codex + Claude review | IN_PROGRESS | codex/operator-app-v1 | Backend boundary tests pass; UI integration and peer review pending |
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

## 29 October — published Codex handoff for Claude

- Safety branch: [`codex/update-settings-safety`](https://github.com/MMCLEOD-DL/Shingon/tree/codex/update-settings-safety), commit `b25e2bfcafd33112ef8260f48ecb96f4edc90400`. Please review the post-rename recovery fix and five real-file regressions. Focused Foundation ops tests: 110 passed; types/focused lint passed. Full integrated Foundation checks remain due after P02.
- Backend branch: [`codex/operator-app-v1`](https://github.com/MMCLEOD-DL/Shingon/tree/codex/operator-app-v1), commit `a8c97bc597f1b04919dc790d165f264d4dfb7d15`. Fetch this branch to integrate the UI; the safety branch is separate. No code has been merged to main.
- UI contract: [interface.md on the backend branch](https://github.com/MMCLEOD-DL/Shingon/blob/codex/operator-app-v1/conductor/docs/operator-app/interface.md). Fixtures: `conductor/test/fixtures/operator-app/contract-v1.json`. Architecture, setup and acceptance records are in `conductor/docs/operator-app/` on that branch.
- Concrete wire details: same-origin API `/api/v1`; fragment bootstrap exchanged once at POST `/session`; HttpOnly cookie; SSE event name `run` and explicit `after` cursor. Result/plan/chunk/escalation choice IDs approve/reject; local fallback continue/pause. Send reviewedCommit=null for non-Git decisions. A successful answer POST is not completion; wait for canonical run status.
- Validation: broad Conductor run 1,536 passed, zero failed/skipped/cancelled; latest focused service run 25 passed after a small worker-error lifecycle correction. Real engine uses deterministic model CLI stubs and actually tests/creates the approval branch; it is not a live model/subscription test.
- Native Windows was explicitly selected. cmd.exe test execution and owned PID/tree cancellation paths are implemented but not native-host verified. Windows setup/authentication/cancellation, real model access, UI integration and Claude cross-review remain gates.
- `gh pr create` received GitHub API Forbidden. Git branch pushes succeeded; no PR was created, no merge or client ship performed. Use the branches/commits directly for review.
