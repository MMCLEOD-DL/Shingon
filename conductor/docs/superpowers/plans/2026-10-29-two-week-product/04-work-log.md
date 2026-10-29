# Work log and decision ledger

Created 29 October 2026. Codex claimed P00/P01 on 29 October 2026. Claude is being assigned separately by Malcolm; no Claude acknowledgement has been received here. Claude acknowledged on 29 October 2026 and claimed P02, P06, P09 and then P04 (see the Claude entries below). Interface v1 is not yet peer-frozen. Replace provisional owner names when someone claims a task. Each row needs evidence before DONE.

| Packet | Provisional owner | Status | Branch/checkout + baseline | Result/review/integration evidence |
|---|---|---|---|---|
| P00 | Codex | IN_REVIEW | codex/operator-app-v1 | Concrete API/ADR/fixtures ready; Claude acknowledgement pending |
| P01 | Codex | IN_REVIEW | codex/update-settings-safety | b25e2bf; 110 focused tests + types/lint passed; review/integrated Foundation checks pending |
| P02 | Claude | IN_REVIEW | `claude/adoring-carson-gaa3xh` from `a8ffb91` | See 29 Oct P02 entry; awaiting Codex review |
| P03 | Codex | IN_REVIEW | codex/operator-app-v1 | Backend a8c97bc; full regression and engine integration pass; UI/peer review pending |
| P04 | Claude | IN_REVIEW | `claude/adoring-carson-gaa3xh`; contract v1 fixtures from `codex/operator-app-v1` @ `a8c97bc` | `conductor/operator-web`: 43/43 unit, 13/13 browser journey against real P03 service; see 29 Oct P04 entry; awaiting Codex review |
| P05 | Codex | IN_PROGRESS | codex/operator-app-v1 | Setup/probes/launcher implemented; native Windows/live-model acceptance pending |
| P06 | Claude | IN_REVIEW | `claude/adoring-carson-gaa3xh` from `a8ffb91` | See 29 Oct P06 entry; awaiting Codex review and Malcolm's decisions D1–D5 |
| P07 | Codex + Claude review | IN_PROGRESS | codex/operator-app-v1 | Backend boundary tests pass; UI integration and peer review pending |
| P08 | Codex + Claude review | NOT_STARTED | — | — |
| P09 | Claude | IN_REVIEW | `claude/adoring-carson-gaa3xh` from `a8ffb91` | See 29 Oct P09 entry; awaiting Codex review and Malcolm's prioritisation |

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
### 29 October 2026 — P02 (Claude)

```
Packet/subpacket: P02 — refuse incomplete PDF extraction
Owner and reviewer: Claude; reviewer Codex
Status: IN_REVIEW
Baseline SHA: a8ffb91 (planning commit on top of 8c712e9)
Result commit(s) / patch artifact: the P02 commit on claude/adoring-carson-gaa3xh (see git log)
Owned files and shared seams changed: foundation/modules/ocr/src/pdfWorker.ts, src/pdfText.ts,
  test/helpers.ts (new textPdf builder), test/pdf-text.test.ts, foundation/CHANGELOG.md. No ops/P01 files.
Contract version: n/a (Foundation module; no operator-app contract)
What now works: the reader checks numPages before reading any page. More than 3 pages -> worker
  replies {ok:false, problem:'too-many-pages'} -> UnreadableError(TOO_MANY_PAGES_PDF), which the server
  queue already stores as the reading's problem (status 'unreadable'). 1-3 page PDFs read every page.
  Chose the plan's preferred refusal over incomplete-document metadata: no consumer changes needed and
  no partial read exists to carry a confidence.
Checks (cloud Linux, Node v22.22.0, npm 10.9.4, cwd foundation/, npm ci from lockfile):
  - Reproduced before fix: 4-page synthetic PDF -> lines of pages 1-3 only, readReceipt amount
    {value:1000, confidence:1}, no warning.
  - New tests with src/ stashed: 3 failed (4-page total, 4-page date, 200-page) / 2 passed (1- and 3-page).
  - npx vitest run --project @hf/ocr --maxWorkers=1 -> 7 files, 316 tests passed, exit 0
    (includes existing compression-bomb, memory-ceiling, deadline and queue tests, unchanged).
  - npm run lint -> exit 0; npm run typecheck -> exit 0.
Live / fake / skipped / unrun distinctions: synthetic PDFs only. Full Foundation suite (needs
  PostgreSQL), licences, web build and verify:full NOT run here; the plan runs them after P01 integrates.
  No server-level test added: apps/server already maps any UnreadableError to its userMessage.
Open defects or unknowns: product trade-off - legitimate 4+ page receipts (invoices with T&Cs pages)
  now need manual entry where they previously got a (possibly wrong) partial reading. Raising the page
  cap is a separate resource-limit decision; the memory/deadline watchdogs would bound it.
External blocker and exact owner/action: none.
Next packet unblocked: none directly; P07 integrates it with P01.
Reviewer disposition and reviewed SHA: pending (Codex).
Integration SHA: —
```

### 29 October 2026 — P06 (Claude)

```
Packet/subpacket: P06 — knowledge-base research and recommendation
Owner and reviewer: Claude; reviewer Codex
Status: IN_REVIEW
Baseline SHA: a8ffb91
Result commit(s): the P06 commits on claude/adoring-carson-gaa3xh (see git log)
Owned files: conductor/docs/knowledge-base/**, conductor/spikes/knowledge-base-evaluation/**,
  status line in conductor/docs/RESEARCH-BACKLOG.md. No Conductor/Foundation code changed.
Contract version: retrieval contract v0 (proposal), separate from operator-app contract.
What now works: inventory, options, recommendation, retrieval contract, migration plan and a synthetic
  evaluation (`bash run.sh` in the spike folder).
Checks: spike run on cloud Linux, PostgreSQL 16.15, Python 3.13.17: 21/21 permission/sync/deletion checks;
  0 unauthorised results in 3 sweeps of 100 searches; keyword retrieval 17/25 (21/25 with superseded
  demotion). Evidence: spikes/knowledge-base-evaluation/results/results.json.
Live / fake / skipped / unrun: Babel inventory from live read-only MCP calls (no writes). Hybrid
  retrieval, reranking, OCR, answer generation and live connectors NOT run (network policy blocks model
  and extension downloads). Several vendor pricing pages were blocked; such figures are tagged [U]/[S].
Open defects or unknowns: inventory §6 questions; CPU throughput of parser/embedder/reranker; Onyx price.
External blocker and exact owner/action: Malcolm — answer inventory §6, decide D1–D5; a host with
  Ollama for the hybrid experiment (K3/K4).
Next packet unblocked: P09 (in progress).
Reviewer disposition and reviewed SHA: pending (Codex).
Integration SHA: —
```

### 29 October 2026 — P09 (Claude)

```
Packet/subpacket: P09 — next-phase backlog
Owner and reviewer: Claude; reviewer Codex
Status: IN_REVIEW
Baseline SHA: 3e696db
Owned files: conductor/docs/operator-app/next.md; link added in conductor/docs/RESEARCH-BACKLOG.md
What now works: five items (expenses, desktop packaging, KB implementation, lessons ledger, research
  sessions) each with repo overlap (paths checked at 3e696db), gaps, dependencies, owner and
  given/when/then acceptance examples. Proposes an order that differs from 00-index §7, with reasons.
Checks: documentation only; spot-checked the overlap claims (MODULES list, absence of
  expenses:approve, workerMemory scope, council "no debate" rule) against the source.
Live / fake / skipped / unrun: n/a. Older Windows-project records treated as history only.
Open defects or unknowns: order of items is Malcolm's call; the repo has no AGENTS.md although
  03-parallel-working.md asks sessions to read one.
External blocker: none.
Next packet unblocked: none in this fortnight (all items are post-fortnight).
Reviewer disposition and reviewed SHA: pending (Codex).
Integration SHA: —
```

### 29 October 2026 — Claude review of P01, P03 and the P00 interface

Findings, reproduction and disposition: [`reviews/2026-10-29-claude-review-P01-P03.md`](reviews/2026-10-29-claude-review-P01-P03.md).
- **P01 @ `b25e2bf`:** approve, subject to the owner's answer on R1-1. The suggestion there is a settings-only undo before a full restore. 125/125 focused ops tests pass with a test database; 4 of the 5 new tests fail on `a8ffb91`.
- **P03 @ `a8c97bc`:** changes requested. P3-1 is **blocking**: cancelling after approval can leave a branch in the source repo while the run reports `interrupted` with no landed branch. A reproduction is included.
- **P00 interface:** acknowledged as the P04 working contract. It is not frozen until I-1 is settled.

### 29 October 2026 — P02 follow-up evidence (Claude)

Full Foundation verification on `claude/adoring-carson-gaa3xh` (P02 included), against a throwaway local PostgreSQL 16.15 test role:
- `npm run licences`: all 449 installed packages and 553 lock entries permissive.
- `npm test -- --maxWorkers=1`: 1,098 passed, 6 skipped. One suite (`sessions.test.ts`) failed only in teardown, because the test role lacked `pg_signal_backend`. After granting it, re-run: 5/5 passed.
- Lint and typecheck: passed earlier. Web build and `verify:full` (browsers) were not run for P02, which touches only the OCR module.

### 29 October 2026 — P04 (Claude)

```
Packet/subpacket: P04 — browser operator experience
Owner and reviewer: Claude; reviewer Codex
Status: IN_REVIEW
Baseline SHA: branch claude/adoring-carson-gaa3xh after merging main 44b8674
Owned files: conductor/operator-web/** (own package.json + package-lock.json), conductor/docs/operator-app/ux.md.
  No service, root-manifest or Foundation UI files touched.
Contract version: v1 as published at codex/operator-app-v1 @ a8c97bc (fixture copied with a drift-guard test).
What now works: five views (Connections, New task, Run with decisions/review, History) over the
  real API/SSE contract; bootstrap per interface.md; idempotent create/answer; stale-decision handling;
  reconnect/resync; evidence-gated approval; untrusted text rendered as text only.
Checks (cloud Linux, Node 22.22.0): `npm test` 43/43; `npm run build` OK; `node e2e/journey.mjs --service
  <archive of a8c97bc>/conductor` in Chromium (Playwright 1.63.0): 13/13 against the REAL service with
  Codex's deterministic fixture worker.
Live / fake / skipped / unrun: engine is the fixture worker (no models, no Git landing) — not coding evidence.
  No live models, no native Windows, no automated accessibility audit. Real-engine journey is P07.
Open defects or unknowns: cancel-after-approval truthfulness depends on P3-1; probe timeouts undocumented
  (P3-5). dist/ is not committed; the P05 start command must run `npm ci && npm run build` in operator-web.
External blocker: none for review. Integration (P07) needs P03 merged so `--service ..` resolves.
Next packet unblocked: P07 UI integration.
Reviewer disposition and reviewed SHA: pending (Codex).
Integration SHA: —
```
