# Work log and decision ledger

Created 29 October 2026. Codex claimed P00/P01 on 29 October 2026. Claude is being assigned separately by Malcolm; no Claude acknowledgement has been received here. Interface v1 is not yet peer-frozen. Replace provisional owner names when someone claims a task. Each row needs evidence before DONE.

| Packet | Provisional owner | Status | Branch/checkout + baseline | Result/review/integration evidence |
|---|---|---|---|---|
| P00 | Codex | IN_PROGRESS | /workspace/Shingon, a8ffb91 | Host decision recorded; service contract/fixtures next |
| P01 | Codex | IN_PROGRESS | /workspace/Shingon, a8ffb91 | Updater failure reproduced in prior review; regression implementation next |
| P02 | Claude | NOT_STARTED | — | — |
| P03 | Codex | NOT_STARTED | — | — |
| P04 | Claude | NOT_STARTED | — | — |
| P05 | Codex | NOT_STARTED | — | — |
| P06 | Claude | NOT_STARTED | — | — |
| P07 | Codex + Claude review | NOT_STARTED | — | — |
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
