# Work log and decision ledger

Created 29 October 2026. Planning only: no packets have started, no interface is frozen, and no agents have been dispatched. Replace provisional owner names when someone claims a task. Each row needs evidence before DONE.

| Packet | Provisional owner | Status | Branch/checkout + baseline | Result/review/integration evidence |
|---|---|---|---|---|
| P00 | Codex | NOT_STARTED | — | — |
| P01 | Codex | NOT_STARTED | — | — |
| P02 | Claude | IN_REVIEW | `claude/adoring-carson-gaa3xh` from `a8ffb91` | See 30 Oct entry; awaiting Codex review |
| P03 | Codex | NOT_STARTED | — | — |
| P04 | Claude | NOT_STARTED | — | — |
| P05 | Codex | NOT_STARTED | — | — |
| P06 | Claude | IN_REVIEW | `claude/adoring-carson-gaa3xh` from `a8ffb91` | See 30 Oct P06 entry; awaiting Codex review and Malcolm's decisions D1–D5 |
| P07 | Codex + Claude review | NOT_STARTED | — | — |
| P08 | Codex + Claude review | NOT_STARTED | — | — |
| P09 | Claude | NOT_STARTED | — | — |

## Decisions to settle in P00

| Decision | Proposed default | Status / evidence |
|---|---|---|
| Acceptance host/topology | Cloud Linux for engineering; confirm one usable personal topology | OPEN |
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

### 30 October 2026 — P02 (Claude)

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

### 30 October 2026 — P06 (Claude)

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
