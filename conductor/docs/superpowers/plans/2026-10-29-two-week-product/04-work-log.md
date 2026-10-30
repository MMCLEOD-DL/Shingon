# Work log and decision ledger

Created 29 October 2026. Codex claimed P00/P01 on 29 October 2026. Claude acknowledged on 29 October 2026 and claimed P02, P06, P09 and then P04 (see the Claude entries below). Interface v1 is not yet peer-frozen. Replace provisional owner names when someone claims a task. Each row needs evidence before DONE.

| Packet | Provisional owner | Status | Branch/checkout + baseline | Result/review/integration evidence |
|---|---|---|---|---|
| P00 | Codex | IN_REVIEW | codex/operator-app-v1 | Concrete API/ADR/fixtures ready; Claude acknowledgement pending |
| P01 | Codex | DONE | `codex/updater-settings-recovery` | Claude approved `06678be`; PR #6 merged as `8e5bf13`; evidence below |
| P02 | Claude | CHANGES_REQUESTED | `2405aff` reviewed on integrated `18f8f5b` | Original triggers now refused; P02-R2 resolved at reviewed scope. P02-R1 partially fixed: harmless scanner footer still yields unwarned GBP 10.00 at confidence 1 while ignoring GBP 12.40 image. Codex re-review: 323 passed / 6 Linux-only tests filtered out; follow-up review and reproducer below. |
| P03 | Codex | DONE | `codex/decision-receipt-keys` from `d9e88e2` | #12 and #14 independently approved/merged; N5 approval `43d8b0d`, merge `01350f7`; Claude N6 UI merged in #15; optional N7 remains |
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

## 29 October — Codex backend handoff

- P01 fix is on `codex/update-settings-safety`, commit `b25e2bf`. Five new real-file failure-injection regressions cover pre-rename, directory-open/sync after rename, repeated restoration sync failure and unreadable tag recovery. 110 focused tests, Foundation typecheck and focused ESLint passed. It is separate from the service branch; do not assume it is merged.
- `codex/operator-app-v1` contains P03/P05 candidate service, bounded same-origin HTTP/SSE API, one-time bootstrap, per-operation worker processes, repository registration, persisted/idempotent decisions, evidence drift checks, history/resume, setup and explicit challenge/file-based probes. No paid API calls or real model probes were made.
- The service uses Node built-ins. Shared seam changes: Windows cmd.exe test execution and PID-scoped taskkill cancellation; native acceptance remains unverified. Production startup is `npm run app`; no UI files are changed.
- Claude: read `conductor/docs/operator-app/interface.md` and `architecture.md`, and consume `conductor/test/fixtures/operator-app/contract-v1.json`. SSE event name is `run`; fallback choice IDs are `continue` / `pause`; other approvals are `approve` / `reject`; send reviewedCommit=null when the decision has no Git evidence. Fetch this branch for backend integration; propose interface changes explicitly.
- Broad Linux Conductor regression passed 1,535 tests with the cloud orphan-reaping wrapper. Subsequent focused launcher tests cover a real start/stop/restart without any model calls. Final command/count details are in `conductor/docs/operator-app/acceptance.md`.
- Git pushes work. `gh pr create` failed with GitHub API Forbidden; no PR was created. Branches remain directly reviewable. No automatic merge or client ship.
- External gates: Claude UI/peer review, native Windows host installation/cancellation, and supported sign-in + configured local-model access for live acceptance. These are not inferred from Linux or mock results.

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

### 29 October 2026 — Conductor suite with operator-web present; environment finding (Claude)

`node --test --test-concurrency=4` from `conductor/` on `df532c3` (cloud Linux, Node 22.22.0): 1,510 tests, 1,495 passed, 14 failed, 1 skipped. **None of the failures come from this branch.**
- **13 failures** in `factory-release.test.js` (12) and `factory-status.test.js` (1). They fail identically on an untouched archive of the baseline `a8ffb91`, and with `operator-web/` moved out of the tree.
  - **Cause:** this container injects git settings as `GIT_CONFIG_COUNT` plus `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n`. `strictChildEnv` in `src/secrets.js` deletes every name matching `/KEY|…/i`, so `GIT_CONFIG_KEY_0` goes but `GIT_CONFIG_COUNT` stays. Every git call in the stripped child then fails with `error: missing config key GIT_CONFIG_KEY_0`.
  - **Not fixed here:** `secrets.js` is a shared engine seam. It is a real latent bug on any host or CI that sets `GIT_CONFIG_COUNT`.
  - **Suggested fix (for the engine owner):** remove `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*` and `GIT_CONFIG_VALUE_*` together, or keep all three. Then add a regression test that sets the trio.
- **1 failure** in `localAgent.test.js` was caused by my `XDG_CACHE_HOME` under the temp directory, which that test deliberately refuses. It passes (14/14) with the default cache location.
- Vitest files are not picked up by `node --test`. They live in `operator-web/tests/*.spec.*`.


## 29 October — Codex resolution of PR #2 conflicts and review blocker

Merged main `675233d` into the operator-service branch; preserved both handoff histories and Claude's newer P02/P04/P06/P09 statuses. The only Git content conflict was in this ledger. No remote main merge or PR approval is performed.

P3-1/I-1: result approval now persists a landing boundary before delivery. Cancel returns 409/landing-in-progress after that boundary, rather than killing an irreversible source update. Finished outcomes remain accepted after a cancellation request. Worker/service loss without a known approved outcome requires repository inspection and disables automatic resume. Added delayed-landing and crash-after-landing source-branch regressions; both fail on `a8c97bc` and pass on the updated branch. Added startup-recovery regression and shared/UI fixtures, plus a narrow UI change explaining recovery and hiding the unsafe stop action. Claude's other UI source remains unchanged.

P3-2: absent/malformed asset paths return 404; regression added. P3-4: coverage wording states the actual participating vendor. P3-5: probe time budgets documented. I-2: lost-bootstrap-response restart limitation documented. P3-3 (pre-auth rate budget) remains a nonblocking note; the separately recorded baseline GIT_CONFIG_* scrubbing finding is outside this conflict update. P01/R1 notes remain attached to the separate safety branch.

Combined checks: 29 service tests passed; 45 UI tests passed; UI build passed. Browser journey attempted but blocked by missing Chromium; the supported browser download was then denied by proxy (403 Domain forbidden for cdn.playwright.dev). No new browser/native Windows/live-model acceptance claim. Independent re-review of P3-1 is invited at the new branch commit; do not infer a peer sign-off from these owner's checks.

Final combined validation for the PR #2 update: **1,541 Conductor tests passed, zero failed/skipped/cancelled** (70.40 seconds); **45 UI tests passed**, UI build passed. The launcher regression now verifies the built UI when present instead of assuming the pre-UI placeholder. No unresolved Git conflicts remain; main at 675233d is an ancestor of the review branch. Browser rerun remains blocked as described above.

### 29 October 2026 — Claude: P03 re-review at `93e65b3`, browser journey in-tree, one UI race fixed

- **P03:** approved by Claude at `93e65b3`. P3-1 and I-1 are resolved; notes N1 and N2 are non-blocking. Details: [`reviews/2026-10-29-claude-review-P01-P03.md`](reviews/2026-10-29-claude-review-P01-P03.md#re-review-of-p03-at-93e65b3-claude-29-october-2026).
- **Evidence (cloud Linux, Node 22.22.0, `main` @ `13a86f7`):**
  - service tests 29/29;
  - Codex's four new regressions fail 4/4 on `a8c97bc`;
  - `operator-web` `npm test` 46/46 and build passed;
  - `node e2e/journey.mjs` (in-tree `--service ..`, Chromium via Playwright 1.63.0) passed **15/15**. That covers the browser step that was blocked on Codex's host. Two new landing steps use `slow-land-worker.cjs`.
  - Still fixture workers: no real engine, models or native Windows.
- **P04:** fixed `RunView` so it offers no stale question or Stop between an accepted answer and the next snapshot. The new unit test fails without the fix.
- **Loop:** added `.claude/skills/claude-lane/SKILL.md` (one task per PR; merge = approval; read the repo between tasks).

### 29 October 2026 — Codex claim: P01 settings recovery

Packet/subpacket: P01 — R1-1 settings-only undo, R1-2 changelog and R1-3 recovery coverage.
Owner: Codex; reviewer: Claude.
Status: IN_PROGRESS.
Branch: `codex/updater-settings-recovery`; baseline: `42efa16` (current main).
Owned paths: `foundation/ops/src/update.ts`, `foundation/ops/test/update-settings-safety.test.ts`,
`foundation/CHANGELOG.md`, and this ledger.
Carries forward the unmerged `codex/update-settings-safety` @ `b25e2bf` as `2e994db` on current main;
the new branch supersedes that earlier submission candidate without rewriting it.
Scope: restore and confirm the previous settings before falling back to database/uploads restore,
retain truthful recovery evidence, and run the Foundation gate. P03 and other packets stay separate.

### 29 October 2026 — Codex P01 revised handoff

```
Packet/subpacket: P01 — update/settings safety, Claude R1-1/R1-2/R1-3.
Owner and reviewer: Codex; reviewer Claude.
Status: IN_REVIEW.
Baseline SHA: 42efa16; carried-forward safety fix: 2e994db (original b25e2bf).
Owned files: foundation/ops/src/update.ts; foundation/ops/test/update-settings-safety.test.ts;
  foundation/CHANGELOG.md; this ledger.
What now works: a post-rename settings failure first attempts a durable settings-only undo and
  checks the tag before starting the old app; no database or uploads restore on that success path.
  Failure to confirm that undo falls back to full restore. Failure of full recovery keeps the
  undo-failed journal and backup reference, with a truthful observed/unknown tag message.
  Cancellation after settings recovery records the backup and says the settings were restored.
Checks (cloud Linux, Node 24.19.0 / npm 11.9.0; local development PostgreSQL 17):
  Reproduction on 2e994db: three new recovery expectations failed, four passed, before source fix.
  From foundation/, sourcing the local development helper and umask 022:
  npx vitest run --project @hf/ops update-settings-safety.test.ts update.test.ts compose.test.ts
    set-env.test.ts journal.test.ts update-cli.test.ts --maxWorkers=1: 129/129 passed (9 in new file).
  npm run lint: passed. npm run typecheck: passed.
  npm run licences: passed; 449 installed packages and 553 lock entries permissive.
  npm test -- --maxWorkers=1: 1,107 passed, 6 skipped; 94 files passed, 1 skipped; 234.52 seconds.
  npm -w @hf/web run build: passed (dependency annotation/chunk-size warnings only).
Live / fake / skipped / unrun: new filesystem tests use real temporary .env files and injected
  failures with deterministic Compose stand-ins; full suite uses local development PostgreSQL.
  Six real Restic backup/restore integration tests skipped because restic is absent. Browser and
  OCR-corpus release checks, native Windows and client-box smoke tests not run. No live models,
  subscription probes, external machines or releases.
Open defects or unknowns: no new P01 defect found; revised peer review remains due. The Restic
  integration gap is explicit and the stand-ins do not prove a real client-box restore.
External blocker: none for review; native/client-box acceptance requires the appropriate host.
Next packet unblocked: none until Malcolm merges this task under the lane loop.
Reviewer disposition and reviewed SHA: Claude approved the original b25e2bf subject to R1-1;
  this revision addresses the notes but does not claim a new independent sign-off.
Integration SHA: —
```

### Codex task submitted — P01 updater settings recovery

- Date: 29 October 2026. Branch: `codex/updater-settings-recovery`.
- Last code commit: `06678be1d9e9f585d08126b2dc481adbdd3794bb`; baseline main: `42efa16`.
- **PR needed:** draft creation via `gh pr create --draft` failed with GitHub GraphQL Forbidden.
  Open from [the compare view](https://github.com/MMCLEOD-DL/Shingon/compare/main...codex/updater-settings-recovery).
  The branch is pushed; no PR was created and no merge or release was performed.
- Changes: carries forward P01, addresses R1-1 with settings-only undo before full restore,
  R1-2 with a changelog entry, and R1-3 with restore-only flush-failure coverage. Unconfirmed
  recovery never starts the target app without migrations; failed rollback retains its journal.
- Evidence: 129 focused tests passed; full Foundation suite 1,107 passed / 6 skipped / 0 failed;
  lint, typecheck, licence audit and production web build passed. New recovery expectations
  reproduced three failures on the carried-forward fix before the revision. Detailed commands,
  host, counts and stand-in limits appear in the revised handoff above.
- Skipped/unrun: six real backup/restore tests require missing Restic. No browser/corpus release
  checks, native Windows, client-box smokes or live models. Stand-ins do not prove real restores.
- Open questions: none on the implementation; revised Claude review and Malcolm's merge remain
  pending. Original branch `codex/update-settings-safety` is superseded by this submission.
- Next action: Malcolm or Claude opens the draft PR; Malcolm approves by merging. Following
  AGENTS.md, the next "carry on" after that merge starts the next Codex task.

### 29 October 2026 — Claude task 3 (claude-lane): P01 re-review at `06678be`

- **Verdict: approved.** R1-1, R1-2 and R1-3 are resolved; notes N3 and N4 are non-blocking. Details: [`reviews/2026-10-29-claude-review-P01-P03.md`](reviews/2026-10-29-claude-review-P01-P03.md#re-review-of-p01-at-06678be-on-codexupdater-settings-recovery-claude-29-october-2026).
- **PR:** MMCLEOD-DL/Shingon#6 (`codex/updater-settings-recovery`). It supersedes `codex/update-settings-safety`, which should not be merged.
- **Evidence** (cloud Linux, Node 22.22.0, a local PostgreSQL 16.15 test role with `pg_signal_backend`; branch files checked out over `main` @ `6330adc`):
  - Focused ops files: 129/129.
  - The new test file fails 8/9 against `main`'s `update.ts`; only the already-safe pre-rename case passes.
  - `npm run lint` and `npm run typecheck` passed.
  - `npm test -- --maxWorkers=1`: 94 files passed (1 skipped), **1,107 tests passed, 6 skipped**, 0 failed. This matches Codex's report.
- **Not run:** the six Restic-backed backup/restore tests (Restic is not installed), `verify:full`, client-box smoke tests.

### 29 October 2026 — Claude task 4 (claude-lane): CI tidy-up

- **Actions on Node 24.** `actions/checkout` and `actions/setup-node` move from v4 (which ran on Node 20, deprecated on GitHub runners) to v6. Both v6 tags declare `using: node24`; checked by cloning the tags.
- **No re-run on "ready for review".** `ci.yml` no longer triggers on `ready_for_review`. PR #7 showed that this event re-ran every job on an already-checked commit, which only delays auto-merge. `risk-gate.yml` keeps the event.
- **Change type:** high-risk path (`.github/`), so it needs Malcolm's merge. No checks were added or removed.

### 29 October 2026 — Codex claim: required Foundation CI redaction repair

Packet/subpacket: required-check prerequisite — database-address redaction.
Owner: Codex; reviewer: Claude. Status: IN_PROGRESS.
Branch: `codex/database-url-redaction`; baseline: `caee572` (main).
Owned files: `foundation/ops/src/alerts.ts`, `foundation/ops/test/{alerts,status}.test.ts`,
`foundation/CHANGELOG.md`, and this ledger. No CI or gate changes.
Main CI check 123700109780 fails status.test.ts:115 when the configured database password is
postgres: literal substitution breaks the URI scheme before whole-address redaction. Diagnose
and fix the production ordering, retaining existing assertions and full configured-URL hiding.
P03 N1/N2 work is preserved, unsubmitted, on `codex/operator-run-recovery` @ `3c3e32a`:
34 service tests, 1,548 full Conductor tests, 47 UI tests and UI build passed. No recovery PR
is open. That packet resumes after this required-check prerequisite is merged; keep one task/PR.

### 29 October 2026 — Codex required-check redaction repair handoff

```
Packet/subpacket: CI prerequisite — production alert/status URL redaction ordering.
Owner and reviewer: Codex; reviewer Claude.
Status: IN_REVIEW.
Baseline SHA: caee572; branch codex/database-url-redaction.
Owned files: foundation/ops/src/alerts.ts; foundation/ops/test/alerts.test.ts;
  foundation/ops/test/status.test.ts; foundation/CHANGELOG.md; this ledger.
What now works: configured secret URLs stay hidden whole; remaining database addresses and inline
  URL passwords are recognized before literal secret substitution can break their URI schemes.
  This repairs main's required Foundation status assertion for a database password of postgres.
Checks (Debian 13 cloud Linux, Node 24.19.0, npm 11.9.0, local development PostgreSQL 17):
  Initial run found the stopped development database; started only the existing dev db container
  and verified pg_isready before reproducing code failures. No production database used.
  Before fix: alerts/status tests 5 failed / 27 passed. Five new regressions fail, while the
    sixth new case already passes and preserves whole configured-URL hiding.
  From foundation/ after sourcing /workspace/shingon-dev/env.sh (umask 022):
  npx vitest run --project @hf/ops alerts.test.ts status.test.ts runner.test.ts --maxWorkers=1:
    36/36 passed.
  npm run lint: passed. npm run typecheck: passed.
  npm run licences: passed (449 installed packages; 553 lock entries permissive).
  npm test -- --maxWorkers=1: 1,113 passed / 6 skipped / 0 failed; 94 files passed / 1 skipped;
    223.91 seconds.
  npm -w @hf/web run build: passed (dependency annotation/chunk-size warnings only).
Live / fake / skipped / unrun: real local PostgreSQL, synthetic alert strings and test HTTP
  servers; no real notification sent. Six Restic-backed tests skipped because Restic is absent.
  Browser/corpus release checks, native Windows and client-box smokes not run for this ops fix;
  no live models, paid API calls, remote machines or releases.
Open defects or unknowns: reviewer disposition and this PR's required CI remain pending.
External blocker: high-risk ops path needs Malcolm's merge or malcolm-approved label;
  agents do not change that label or loosen the workflows.
Next packet unblocked: P03 recovery prepared on codex/operator-run-recovery @ 3c3e32a;
  only submit it after this prerequisite is merged. No recovery PR is open.
Reviewer disposition and reviewed SHA: requested from Claude at the eventual code SHA; no sign-off claimed.
Integration SHA: —
```

### Codex task submitted — required Foundation CI redaction repair

- Date: 29 October 2026. Branch: `codex/database-url-redaction`; baseline: `caee572`.
- Last code commit: `95cfa9858ab020d480c6662ab7fb691d5aa4bf95`.
- PR: [#10 — Fix alert URL redaction and the required Foundation CI failure](https://github.com/MMCLEOD-DL/Shingon/pull/10).
- Changes: production redaction ordering, six regressions, changelog and evidence. No CI/gate
  changes and no P03 service changes in this PR. Five regressions fail before the fix.
- Evidence: 36 focused tests passed; Foundation suite 1,113 passed / 6 skipped / 0 failed;
  lint, typecheck, licence audit and web build passed. Full commands/host/limits are above.
- Skipped/unrun: Restic integration (6 tests; tool absent), browser/corpus release checks,
  native Windows, client boxes, live models and releases. No sign-off inferred from own tests.
- Merge route: high-risk `foundation/ops/` paths; auto-merge stays off. This PR's required CI
  was pending at submission. Claude review is requested at the code SHA; Malcolm must merge
  or add `malcolm-approved` himself. The agent will not change that label or the gate.
- P03 N1/N2 remains preserved and unsubmitted on `codex/operator-run-recovery` @ `3c3e32a`
  (34 service / 1,548 Conductor / 47 UI tests passed; UI build passed). Resume that packet
  after this prerequisite is merged; merge current main into its existing branch first.
- Open questions: none on the proposed redaction fix; CI/peer review/Malcolm merge pending.

### 29 October 2026 — Claude task 5 (claude-lane): K2 knowledge service skeleton

```
Packet/subpacket: K2 (knowledge-base migration plan), the first implementation task
Owner and reviewer: Claude; reviewer Codex
Decision basis: Malcolm chose K2 (29 Oct), accepting D1, D2 and D5 of recommendation.md; D3 and D4 open.
Status: IN_REVIEW
Baseline SHA: caee572
Owned files: knowledge/** (new package), conductor/docs/knowledge-base/adr-0001-kb-service-stack.md,
  recommendation.md decision note. Shared: a `knowledge` job in .github/workflows/ci.yml; ownership and
  required-check lines in AGENTS.md and the claude-lane skill (high-risk paths, so Malcolm merges).
What now works: the spike as a package. Versioned SQL migrations; tenants, collections and principals;
  repeat-safe sync (versions, deletions, ACL and supersession changes); actionable import status;
  credential-bearing files refused; keyword search with the ACL predicate in the candidate query,
  superseded demotion (0.5) and evidence levels; version and locator citations; permission-checked
  originals; audit that stores query hashes only. Driver: pg8000 (BSD-3), because psycopg is LGPL and
  the licence policy is permissive-only.
Checks (cloud Linux, Python 3.13, PostgreSQL 16.15):
  - `python -m unittest discover -s tests`: 8 tests OK, including the 21-check scenario with three
    oracle sweeps at 0 unauthorised, and the 25 questions with the misses pinned (q16, q18, q24, q25).
  - The same in a clean venv from requirements.lock (`pip check` clean).
  - Mutation checks: with the ACL predicate disabled, the sweep finds 7 unauthorised results and 3 tests
    fail; with demotion disabled, the baseline and q13 tests fail.
  - All 11 dependencies (including transitive ones) are permissive.
Live / fake / skipped / unrun: synthetic corpus only. No HTTP API, vectors, OCR or Babel data. The CI job is
  defined, but its first run is on this PR.
Open: Malcolm should add `knowledge` to the required checks in branch protection.
Next: K3 (hybrid) needs a host with local models; K6 (HTTP API) can follow once P03 patterns are reused.
```

### 29 October 2026 — Codex claim: P03 explicit recovery and pre-landing refusal

Packet/subpacket: P03 — Claude notes N1/N2.
Owner: Codex; reviewer: Claude. Status: IN_PROGRESS.
Branch: `codex/operator-run-recovery`; baseline main: `c027fe6`.
Owned paths: `conductor/src/service/{runs,server,worker}.js`, `conductor/test/service/**`,
`conductor/docs/operator-app/{interface,setup,acceptance}.md`, and this ledger.
Named shared seam: additive authenticated `/runs/:id/recover` operation, bound to the run event
sequence and approved commit, recording explicit repository inspection without starting work.
Existing UI can offer its normal Resume after acknowledgment; Claude-owned UI/fixtures stay untouched.
The worker will distinguish a refused review before handing approval back to the engine from an
unknown outcome after landing may have started. No shared engine/adapters/config changes planned.
P01 is approved and merged through PR #6. Read the new merge rules: service changes are high risk,
so this task waits for Malcolm's merge/approval label; agents do not set that label or loosen CI.

### 29 October 2026 — P03 recovery prepared; CI prerequisite takes priority

The two initial recovery regressions fail on c027fe6 and pass after the service revision.
Service tests: 34/34. Full Conductor suite: 1,548/1,548 (65.93 seconds). UI tests: 47/47;
UI production build passed. Actual engine/Git tests use deterministic CLI stand-ins and real
worker exits before/after branch creation; source edits/index/untracked files are preserved.
No live models or native Windows. Browser download is blocked at cdn.playwright.dev (403);
current image's preinstalled Playwright cannot find its pinned browser.

P03 remains unsubmitted. Required Foundation CI on main c027fe6 fails status.test.ts:115:
a database password of postgres is substituted before URI recognition, leaving a broken
[hidden]:// URL rather than hiding the whole database address. Main check 123700109780
records the failure. This is a required-check prerequisite, so isolate its fix in its own PR
before submitting recovery. Do not weaken the assertion/workflow or mix the fix into P03.
The recovery source/tests/docs and this handoff are preserved on codex/operator-run-recovery;
resume that task after the prerequisite is merged. Dedicated recovery UI remains Claude's follow-up.

### 29 October 2026 — Codex resumes P03 recovery after the CI prerequisite

Status: IN_PROGRESS. Branch: `codex/operator-run-recovery`.
Prepared code: `3c3e32a`; integrating current main `3bc22a6` with a merge commit.
PR #10 merged as `42ced97`; its Foundation/Conductor/operator-web code checks passed.
The only merge conflict is this append-only ledger: retain Claude's K2/CI entries and all
Codex redaction and recovery handoffs. Knowledge code, CI/ownership rules and Claude's browser
journey fix are inherited unchanged from main. Owned paths remain the service, service tests,
crash fixture, setup/interface/acceptance docs and this ledger; no UI/knowledge edits planned.
Next: rerun affected service, full Conductor, UI and browser checks on the combined branch;
submit one high-risk P03 PR with auto-merge off and fresh peer-review evidence.

### 29 October 2026 — Codex P03 recovery handoff

```
Packet/subpacket: P03 — N1 explicit inspected recovery; N2 pre-landing evidence refusal.
Owner and reviewer: Codex; reviewer Claude.
Status: IN_REVIEW.
Baseline SHA: 3bc22a6; original prepared code: 3c3e32a; combined code candidate: a3fe39a.
Owned files: conductor/src/service/{runs,server,worker}.js; conductor/test/service/{server,engine}.test.js;
  conductor/test/fixtures/operator-app/crash-land-worker.js; docs/operator-app/{setup,interface,acceptance}.md;
  this ledger. No changes relative to main in UI, knowledge, CI, ownership rules, or shared engine/config.
Contract: additive v1 POST /runs/:id/recover and optional recoveryAcknowledged metadata. Input is
  bound to the current event sequence and approved commit; a separate Resume still starts work.
What now works: inspection has a durable, idempotent path out of an uncertain landing guard.
  A second crash reinstates that guard until the engine reconciles its old landing record or
  offers fresh result evidence. Existing branches are reconciled without duplicate landing;
  a crash before landing requires fresh approval. A worker-side pre-landing evidence refusal
  now preserves the workspace instead of treating it as a user rejection and deleting it.
Checks (Debian 13, Node 24.19.0 / npm 11.9.0):
  Two representative regressions fail on archived main 3bc22a6 (404 recovery; rejected drift),
    and pass here. No reset of the working checkout was used for baseline reproduction.
  node --test test/service/*.test.js with the cloud subreaper: 34 passed.
  source /workspace/shingon-dev/env.sh, then from conductor/:
    python3 /workspace/shingon-dev/reap.py node --test --test-concurrency=4:
    1,548 passed / 0 failed / 0 skipped / 0 cancelled; 72.37 seconds.
  From conductor/operator-web/: npm test: 47 passed; npm run build: passed.
  Unchanged node e2e/journey.mjs via an external browser-path preload: 17 passed / 0 failed;
    Playwright 1.63.0, system Chromium 154.0.8037.57. Exact command and wrapper purpose are
    in docs/operator-app/acceptance.md. No assertion or provider was changed.
Live / fake / skipped / unrun: real engine, real Git and process exits with deterministic model
  CLI stand-ins for recovery tests; browser journey uses fixture workers. This local browser
  result uses system Chromium, not CI's pinned browser. No live models/subscriptions, native
  Windows, power-loss simulation, client boxes or releases. No Foundation change/rerun locally;
  merged PR #10's full gate and this PR's required CI supply that integration check.
Open defects or unknowns: dedicated recovery UI control remains a Claude follow-up; the manual
  authenticated acknowledgment and CLI recovery procedures are documented. No new blocker found.
External blocker: high-risk service path needs Malcolm's merge or approval label; auto-merge off.
Next packet unblocked: further lane work after this task merges, subject to current main/reviews.
Reviewer disposition and reviewed SHA: Claude approved prior service 93e65b3; request independent
  review of this recovery revision at a3fe39a. Do not infer sign-off from the author's own tests.
Integration SHA: —
```

### Codex task submitted — P03 inspected recovery and refused review preservation

- Date: 29 October 2026. Branch: `codex/operator-run-recovery`; integrated main: `3bc22a6`.
- Last code candidate: `a3fe39a91ad4432ff71cd039d09c8e7453684ff7` (merge of prepared implementation `3c3e32a` and current main).
  Documentation handoff: `ada7f3b`. No production change after the recorded checks.
- PR: [#12 — P03: recover inspected runs and preserve refused reviews](https://github.com/MMCLEOD-DL/Shingon/pull/12).
- Changes: authenticated, durable and idempotent inspection acknowledgment; separate explicit
  Resume; preserved workspace on worker-side pre-landing refusal; unchanged uncertainty guard
  for unknown outcomes; recovery/setup/API documentation and five regression scenarios.
- Evidence: two representative regressions fail on main `3bc22a6`; 34 service tests passed;
  full Conductor 1,548 passed / 0 failed/skipped/cancelled; UI 47 passed and build passed;
  unchanged browser journey 17 passed on Playwright 1.63.0 + system Chromium 154.0.8037.57.
  Exact commands, browser override and distinctions are in the handoff/acceptance doc above.
- Limits: browser fixture workers and real engine with deterministic model CLI stand-ins,
  not live subscriptions. Native Windows, power-loss, client boxes and releases unrun.
  Dedicated UI recovery control remains Claude-owned; manual acknowledgment/CLI are documented.
- Merge route: high-risk service/approval path; auto-merge off. Required checks (including
  knowledge and CI's pinned-browser journey) are pending at submission. Independent Claude
  review requested at the combined code SHA; only Malcolm merges or sets his approval label.
- Next action: address own review/CI findings on this branch. The next "carry on" after merge
  selects the next Codex task from current main; no other task is started before that merge.

### 29 October 2026 — Claude task 6 (claude-lane): post-merge review of PR #10

- **Verdict:** approved, no findings. Review: [`reviews/2026-10-29-claude-review-database-url-redaction.md`](reviews/2026-10-29-claude-review-database-url-redaction.md).
- **Evidence:** 32/32 for `status.test.ts` and `alerts.test.ts` on `3bc22a6`, even with a database password of literally `postgres`. Five of the new tests fail against the pre-merge `alerts.ts`.
- **Correction recorded:** Claude had called the CI failure a CI-only artefact; Codex showed the production ordering defect.

### 29 October 2026 — Claude task 7 (claude-lane): post-merge review of PR #12 (P03 recovery)

- **Verdict:** approved. N1 and N2 are resolved. New notes: N5 (low, earlier code: `__proto__` as a request id loses decision-receipt idempotency) and N6 (the Claude-owned UI recovery control). Review: [`reviews/2026-10-29-claude-review-P03-recovery.md`](reviews/2026-10-29-claude-review-P03-recovery.md).
- **Evidence:** service tests 34/34 on `2948677`. The PR's five scenarios fail against the pre-#12 service code.
- **Next Claude task:** N6, the UI recovery acknowledgement.

### 29 October 2026 — Codex claim: P03 N5 decision-receipt object keys

Owner: Codex; reviewer: Claude. Status: IN_PROGRESS.
Branch: `codex/decision-receipt-keys`; baseline main: `d9e88e2`.
PR #12 merged as `c0795fb`; Claude approved recovery in review commit `7759a55`.
Next own review note: N5 in reviews/2026-10-29-claude-review-P03-recovery.md.
Owned paths: `conductor/src/service/runs.js`, `conductor/test/service/{server,engine}.test.js`,
`conductor/docs/operator-app/interface.md`, and this ledger. No UI/knowledge/CI changes.
Scope: treat allowed request IDs as own dictionary keys during both receipt reads and writes,
retain JSON/restart idempotency, and verify exactly-once approval with the real engine and
synthetic CLI workers. Preserve the opaque-ID contract rather than introducing reserved names.
N6 recovery UI remains Claude's task. Service/approval changes stay on the high-risk merge route.

### 29 October 2026 — Codex P03 N5 handoff

```
Packet/subpacket: P03 — N5 decision receipt keys and restart idempotency.
Owner and reviewer: Codex; reviewer Claude.
Status: IN_REVIEW.
Baseline SHA: d9e88e2; branch codex/decision-receipt-keys.
Owned files: conductor/src/service/runs.js; conductor/test/service/{server,engine}.test.js;
  conductor/docs/operator-app/interface.md; this ledger.
What now works: both decision-receipt reads inspect own keys, and writes use computed own
  data properties. Allowed IDs including __proto__, constructor, prototype, toString and
  hasOwnProperty are durable JSON keys; same-ID/body retries replay after restart, while
  conflicting reuse remains 409. ID syntax/state format are preserved without migration.
Reproduction refines N5: the existing inherited-property read causes false 409 on the first
  valid request, before the unsafe plain __proto__ assignment could run. Fix both reads and
  the write together. Before fix: 8 of 10 HTTP restart cases fail, 2 prototype-name controls
  pass; the real-engine concurrent __proto__ approval case also fails (409 instead of 200).
Checks (Debian 13, Node 24.19.0 / npm 11.9.0):
  From conductor/, source /workspace/shingon-dev/env.sh and use the cloud subreaper:
  node --test test/service/*.test.js: 45 passed.
  python3 /workspace/shingon-dev/reap.py node --test --test-concurrency=4:
    1,559 passed / 0 failed/skipped/cancelled; 70.76 seconds.
  From conductor/operator-web/: npm test: 47 passed; npm run build: passed.
  Unchanged browser journey: 17 passed / 0 failed; Playwright 1.63.0 selecting system Chromium
    154.0.8037.57 through the external supported executablePath preload described in acceptance.md.
Live / fake / skipped / unrun: HTTP table tests use fixture workers and prove no source ref
  writes; the concurrent/restart test uses the real engine/Git with deterministic model CLI
  stand-ins and proves only one actual result branch, preserved source HEAD/clean checkout,
  one decision-resolved event and no worker on restart replay. No live models/subscriptions,
  native Windows, power-loss, client boxes or releases. Foundation/knowledge unchanged; their
  required CI checks remain due. No UI source, CI or gate changes.
Open defects or unknowns: no new blocker found; N5 peer review pending. N6 UI remains Claude's task.
External blocker: high-risk service/approval code needs Malcolm's merge or approval label;
  auto-merge off. Agents do not set that label or loosen the gate.
Next packet unblocked: next lane item after this task merges.
Reviewer disposition and reviewed SHA: Claude's N5 note is the basis; new fix not independently approved yet.
Integration SHA: —
```

### Codex task submitted — P03 N5 decision-receipt keys

- Date: 29 October 2026. Branch: `codex/decision-receipt-keys`; baseline: `d9e88e2`.
- Last code commit: `88b8a0789949bee750411460890091bc616718ac`.
- PR: [#14 — P03: persist decision receipts for every valid request ID](https://github.com/MMCLEOD-DL/Shingon/pull/14).
- Changes: own-property reads before/after asynchronous evidence checks, computed own-property
  receipt writes, eleven regressions and API clarification. Accepted ID syntax/state schema stay compatible.
- Reproduction: before fix, 8/10 HTTP cases fail (2 controls pass) and the real-engine concurrent
  approval case fails. After fix: 45 service / 1,559 full Conductor / 47 UI tests passed,
  UI build passed, and unchanged browser journey 17 passed. Exact host, commands and browser
  override are in the handoff above; no production change after those checks.
- Limits: HTTP fixture workers and real-engine deterministic model CLI stand-ins, actual Git;
  local browser uses system Chromium. No live models/subscriptions, native Windows, power-loss,
  client boxes or releases. Hosted Foundation/knowledge/pinned-browser CI pending at submission.
- Merge route: high-risk service/approval code; auto-merge off. Independent Claude re-review
  requested at the code SHA. Only Malcolm merges or adds his approval label; agent leaves the
  label and gate untouched. N6 UI remains Claude-owned.
- Open questions: none on the implementation; CI/peer review/merge pending. Address any own
  failures on this branch. The next "carry on" after merge starts the next task from current main.

### 29 October 2026 — Claude task 8 (claude-lane): recovery control in the operator UI (N6)

```
Packet/subpacket: P04 follow-up N6 (from the P03 recovery review) — UI control for POST /runs/:id/recover.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: d9e88e2 (main after PR #13).
Owned files: conductor/operator-web/{src/api.js, src/views/RunView.jsx, src/styles.css, tests/*, e2e/journey.mjs,
  e2e/inspect-worker.cjs (new)}; conductor/docs/operator-app/ux.md; this ledger. No service, contract, fixture or CI change.
What now works: a run with recoveryRequired (interrupted or failed) shows the registered repository, the full approved
  commit and three read-only Git commands. "Record inspection" needs an explicit tick bound to the current snapshot and
  sends repositoryInspected:true with lastEventSeq, workspaceCommit and one request id per snapshot. It starts nothing;
  Resume then appears as a separate step. Refusals (stale-recovery, not-recoverable, not-resumable) are shown and the
  run reloads. The failed-run text no longer says "cannot be resumed" when inspection is what is needed.
Checks (cloud Linux, Node 22.22.0), from conductor/operator-web/:
  npm test: 54 passed (47 before). 7 of the 8 new or extended tests fail against the previous UI source; the 8th is
    the guard that ordinary interrupted runs get no control.
  npm run build: passed.
  NODE_PATH=$(npm root -g) node e2e/journey.mjs: 19 passed / 0 failed (Playwright 1.63.0) against the real service.
    New steps: (a) Codex's slow-land worker (no workspace): the real service refuses the inspection
    with not-resumable, and the UI shows it; (b) the UI's inspect worker: a real engine workspace via Workspace.create,
    the branch fetched into the source repository and the worker killed before reporting; inspection recorded only after
    the tick, no worker started, panel fits 360 px; Resume reconciles to "Branch created" with exactly one branch.
Live / fake / skipped / unrun: real service, real Git and engine Workspace; deterministic fixture workers, no models.
  Conductor service suite not re-run (no service change); CI runs it. Native Windows unrun.
Open defects or unknowns: none found. Handoff to Codex (docs owner): setup.md "Recover an uncertain approved result"
  step 2 can now point at the run page's "Record inspection" control instead of the developer-console snippet.
Reviewer disposition and reviewed SHA: —
```

_Restored 29 October 2026: this entry was dropped when `main` was merged into `codex/decision-receipt-keys` (`03b0468`); text unchanged from `cad2502`._

### 29 October 2026 — Claude task 9 (claude-lane): review of PR #14 (P03 N5 decision-receipt keys)

- **Verdict:** approved at `88b8a07`; Malcolm merges (high-risk path). Review: [`reviews/2026-10-29-claude-review-P03-N5-receipts.md`](reviews/2026-10-29-claude-review-P03-N5-receipts.md).
- **Evidence:** service tests 45/45 at `88b8a07`. With `main`'s `runs.js`, 9 fail (8 HTTP prototype-name cases and the real-engine concurrent case), and the 2 `prototype` controls pass, as Codex reported.
- **Correction:** my N5 note understated the defect. The inherited-member read refused the *first* valid request (409) for four IDs. It did not only lose idempotency for `__proto__`.
- **Outcome:** Codex merged `main` in (`03b0468`) and #14 was merged as `01350f7`. The service code on `main` is identical to the reviewed `88b8a07`. That merge dropped Claude task 8's entry, which is restored above. N7 (optional, for Codex): add a test for a prototype-named ID on `/recover`.

### 30 October 2026 — Claude task 10 (claude-lane): retrieval-contract fixture set (§10), toward K6

```
Packet/subpacket: P06 follow-up — draft fixtures for retrieval-contract v1 (Malcolm chose this over K9/K5 and the
  work-log change on 30 Oct, because K6 depends on an accepted contract).
Owner and reviewer: Claude; reviewer Codex (contract acceptance).
Status: IN_REVIEW.
Baseline SHA: f23057b.
Owned files: knowledge/{contract/kb-contract-v1.json (new), src/shingon_knowledge/contract.py (new),
  src/shingon_knowledge/service.py (search results gain ingestedAt), tests/test_contract_fixtures.py (new), README.md};
  conductor/docs/knowledge-base/retrieval-contract.md (§10 status and open points); this ledger.
What now works: 13 generated fixtures produced by the K2 service through the wire shapes in contract.py, re-produced
  in a fresh database by CI and compared exactly; 5 authored fixtures (stale, OCR, 503, 429, destination report),
  each naming the task that owns it, shape-checked only. Every §10 item is covered. Strict shape checks for K6
  to reuse; fixed error wording per code (exception text never reaches the caller).
Checks (cloud Linux, Python 3.13, PostgreSQL 16.x local):
  python -m unittest discover -s tests: 16 passed (8 existing + 8 new), twice in a row on fresh databases.
  Drift check: raising the strong-evidence threshold makes 3 generated fixtures fail; restored, all pass.
  The 12 near-miss bodies (extra field, control character, boolean as a number, oversized body...) are all refused.
Live / fake / skipped / unrun: real service and PostgreSQL on the synthetic corpus. No HTTP layer (K6), no models,
  no Babel data. Authored fixtures are not evidence of implementation.
Open points for Codex (retrieval-contract.md §10): identifiers (K2's serial chunk ids reveal cross-tenant volume),
  stale versus removal on a failed re-sync, older originals, and the proposed destination-withheld shape.
Next: K6 once Codex accepts the contract (or requests changes).
Reviewer disposition and reviewed SHA: —
```

### 30 October 2026 — Claude task 11 (claude-lane): P02 follow-up for Codex review P02-R1 and P02-R2

```
Packet/subpacket: P02 — Codex review reviews/2026-10-29-codex-review-P02.md, findings R1 (high) and R2 (medium).
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: f63b83b. Code: 2405aff.
Owned files: foundation/modules/ocr/{src/pdfWorker.ts, src/pdfText.ts, test/pdf-text.test.ts, test/helpers.ts};
  foundation/CHANGELOG.md; this ledger. No dependency, limit, CI or gate change.
What now works:
  R1: completeness is per page. A PDF where any page has no text (a scan, a picture, or a blank page) is refused
    with PARTLY_SCANNED_PDF; one with no text at all keeps SCANNED_PDF. No image is decoded.
  R2: the pre-scan counts pages from the page tree itself: every /Type /Page dictionary, plus every object a
    page-tree node lists in /Kids that is not itself a node (pdfjs's leaf rule), in plain objects and in object
    streams. More than 3 is refused before pdfjs loads. After reading, pdfjs must have visited exactly that many
    distinct page objects (page.ref), or the file is refused. This also catches nested counts that make pdfjs read
    a page twice. A /Kids entry that is not a reference, or names an object never found, is refused. An "obj"
    keyword outside a recognised header is refused: pdfjs accepts a comment between the object number and "obj",
    and that otherwise hides a page from the count (a test shows the bypass with the pre-scan off).
Checks (cloud Linux, Node 22.22.0), from foundation/:
  Codex's reproducer: before (main), both UNSAFE; after, both refused; the 1- and 3-page controls are still read in
    full, and 4 pages is refused.
  npx vitest run --project @hf/ocr pdf-text.test.ts: 47 passed. Against the previous reader source, the 9 new
    safety tests fail; the 2 controls (a correct nested tree; an overstated nested count, which pdfjs recovers
    from by reading every page) pass on both.
  Disabling only the "obj" keyword check: the comment-in-header test fails (the check is load-bearing).
  npm run lint, npm run typecheck: clean.
  umask 022, npm test -- --maxWorkers=1 (PostgreSQL 16 locally): 1,126 passed, 6 skipped; 94 files passed,
    1 skipped (the standing environment-gated ops/deploy tests).
Live / fake / skipped / unrun: real local engine and PDF child process; synthetic PDFs plus the existing fictional
  photographed receipt. No browser upload, native Windows or Azure.
Open defects or unknowns (for Codex):
  - Blank pages are refused (the conservative option the review allowed); staff type the details.
  - Residual: a page with a large scanned image and some text (a scanner app's footer, say) is still read as
    text. Detecting it needs the operator list, which decodes the image: measured about 100 ms and about 178 MB
    more resident memory for one 1500x1274 photo, against the 320 MiB ceiling. Lower harm, since the footer rarely
    carries an amount, and a missing amount is typed by staff. Proposed as a follow-up, not done here.
  - Untyped page dictionaries given directly inside /Kids (not by reference) are refused, as pdfjs also rejects them.
Reviewer disposition and reviewed SHA: re-review requested at 2405aff.
```

### 30 October 2026 — Claude task 12 (claude-lane): council protects the Foundation v0.2.0 layout

```
Packet/subpacket: FOLLOW-UPS (factory acceptance) "PROTECTED_PATHS for the v0.2.0 layout"; next.md housekeeping.
  Malcolm chose this on 30 Oct. Shared engine seam: named, minimal change, for Codex's review.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 932dc53. Code: ad2ca8b.
Owned files: conductor/src/council/foundationRules.js (PROTECTED_PATHS, new PROTECTED_DIRS, PACKAGE_FILES,
  protectedFindings); conductor/test/council-foundation.test.js; conductor/docs/operator-app/next.md;
  FOLLOW-UPS.md (item marked done); this ledger.
What now works: a factory feature build that changes any of these is blocked, locked:
  - modules/, apps/server/src/modules/, apps/web/src/modules/ (whole folders, added files included);
  - app-profile.json, with its own reason: BUILDING-ON says the factory writes it from the brief and it must not be
    edited by hand, and it holds the data policy;
  - packages/shared/src/{modules,appProfileFile,money,report,receipts}.ts and packages/shared/vitest.config.ts;
  - apps/server/src/jobs/registry.ts and ops/src/appJobs.ts.
  packages/shared/package.json joins the verify-script check. What BUILDING-ON tells apps to edit stays open: their
  own job file plus its jobs/index.ts line, and packages/shared/src/{schemas,access}.ts. Pathspecs are literal.
  The factory's own app-profile writes (nameApp; the change-mode profile commit) land before each feature's
  starting commit, so they are not caught.
Checks (cloud Linux, Node 22.22.0), from conductor/:
  node --test test/council-foundation.test.js: 18 passed. Against the previous list, the 4 new protection tests
    fail and the "apps may still edit these" test passes.
  Every new entry exists in foundation/ (30 files, 3 folders).
  Full suite: node --test --test-concurrency=4 under a child-subreaper wrapper: 1,564 tests, 1,563 passed,
    0 failed, 1 skipped; 114 s. Without the wrapper, the run hung after 1,401 passing tests (the container's PID 1
    does not reap orphans), as Codex's instructions warn.
Live / fake / skipped / unrun: fixture git repos, no factory end-to-end build with a real model.
Open defects or unknowns (for Codex):
  - Is any of the newly protected shared code meant to be extended by apps? I read BUILDING-ON as "use, not edit"
    for money/report/receipts and the module folders.
  - The upgrade path (merging a newer Foundation) is assumed not to run this member; v0.1.0 entries already
    imply that.
Also: Malcolm asked Claude to send Codex its open items. They are in issue #20
  (https://github.com/MMCLEOD-DL/Shingon/issues/20), because Codex's agent mail is not reachable from Claude's
  cloud session.
Reviewer disposition and reviewed SHA: review requested at ad2ca8b.
```

### 30 October 2026 — Codex claim: PR21 protection answers and upgrade review

Owner: Codex; reviewer/fix owner: Claude. Status: IN_PROGRESS.
Branch: `codex/review-foundation-protection`; baseline main: `2471ed7` (PR #21 merged).
Malcolm requested a PR containing the answers to Claude's PR #21 questions.
Owned paths: this ledger and `reviews/2026-10-30-codex-review-PR21.md` plus its standalone
synthetic reproduction. Scope: document extension points, trace the upgrade checker, reproduce
legitimate conflict-resolution refusal, and hand the narrow correction back to Claude.
No production code edits, ownership transfer, live model calls or release operations.
Next action: publish review evidence and the requested PR; P02 re-review and retrieval-contract
review are independent queued tasks after this submission merges.

### Codex task submitted — PR21 protection answers and upgrade review

- Date: 30 October 2026. Branch: `codex/review-foundation-protection`; baseline: `2471ed7`.
- Last review/reproducer commit: `016341fffdc8bdb3c855644fb4fdc75cadfdc85f`.
- PR: [#22 — Review PR21: answer extension questions and record upgrade conflict blocker](https://github.com/MMCLEOD-DL/Shingon/pull/22).
- Status: IN_REVIEW. Answers match BUILDING-ON's app extension points; PR21-R1 requests a
  narrow trusted upgrade-conflict context/exception and actual bridge regression coverage.
  Claude remains the implementation owner. No production implementation or existing test edits.
- Evidence: Windows / Node v24.12.0; council-foundation 18/18 at PR head and integrated
  baseline; standalone synthetic post-merge control passes, conflict-resolution refusal
  reproduced with expected exit 1. Syntax and diff checks pass. Full hosted checks pending.
- Full suites, real upgrade pipeline/model execution and live acceptance not run locally.
  The reproduction invokes real Git, upgradeUnit and FOUNDATION.collect on a synthetic repo.
- Merge route: review docs/reproducer only, no high-risk path. Mark ready and request existing
  auto-merge policy after local checks; repository/API refusal must be reported, not bypassed.
- Next action: Claude reviews and fixes the recorded upgrade handling. After this PR merges,
  Codex takes independent P02 re-review, then retrieval contract/K6 review and P04/P06/P09.
  No new task is started before this submission merges under the repository's one-task loop.

### 30 October 2026 — Codex claim: P02 independent follow-up review

Owner: Codex; implementation owner: Claude. Status: IN_PROGRESS.
Branch: `codex/review-pdf-followup`; baseline main: `18f8f5b` (PR #22 merged).
Malcolm delegated selection of the next review. Scope: re-review `2405aff` (merged PR #19),
rerun original P02-R1/R2 reproductions and focused reader controls, assess the disclosed
same-page image-plus-text residual, and record an evidence-based disposition.
Owned paths: this ledger and review documents/standalone synthetic reproducers under reviews/.
No edits to Claude-owned OCR implementation/tests, dependencies, CI, approval rules or live probes.
Next action: install the checked-in Foundation lockfile locally, run the original reproducer,
then challenge the residual and page-tree completeness before recording findings and a PR.

### 30 October 2026 — Codex P02 follow-up review handoff

Packet: P02 re-review at `2405aff`; baseline `18f8f5b`; branch `codex/review-pdf-followup`.
Status: CHANGES_REQUESTED. Implementation owner Claude; reviewer Codex.
Review: `reviews/2026-10-30-codex-review-P02-followup.md`.
P02-R2 demonstrated cases resolved; P02-R1 original trigger fixed but disclosed footer residual
still returns an unwarned confidence-1 GBP 10.00 while ignoring a GBP 12.40 receipt image.
The footer contains no amount: its mere presence bypasses textless-page refusal.
Original standalone reproducer current exit0 / archived f63b83b exit1; new footer reproducer
exit1 on both. Real local reader/child/readReceipt with synthetic PDFs and fictional receipt.
Windows Node24.12.0/npm11.6.2: focused completeness21PASS/26filtered; OCR323PASS/6filtered,
0fail; the six Linux /proc watchdog tests are intentionally unrun here, never claimed PASS.
Installed checked-in lockfile and built shared package for standalone imports; no dependency,
OCR source/test, CI/gate, live model, Azure, browser upload or release changes.
Claude owns bounded refusal/incomplete-evidence correction and regression; no PDF image OCR
or increased resource ceiling is required by this review. Next independent Codex work after
this submission merges: retrieval-contract/K6 review, then remaining UI/research reviews.

### Codex task submitted — P02 PDF follow-up re-review

- Date: 30 October 2026. Branch: `codex/review-pdf-followup`; baseline: `18f8f5b`.
- Last review/reproducer commit: `78566bd4888b134c82c6f9ae5c08995a7f9ec1d5`.
- PR: [#23 — P02 re-review: verify page fixes and record scanner-footer confidence gap](https://github.com/MMCLEOD-DL/Shingon/pull/23).
- Review complete; implementation status CHANGES_REQUESTED. Original P02-R1 trigger fixed;
  P02-R2 demonstrated omissions resolved. P02-R1 scanner-footer residual still unsafe.
- Evidence: Windows Node24.12.0; 323 OCR PASS/6 Linux watchdog tests intentionally filtered;
  original reproducer current0/baseline1; new harmless-footer reproducer current1/baseline1.
  Synthetic bytes and existing fictional receipt, real local engine/reader child/readReceipt.
- No production/OCR tests, dependencies, CI/gates or live operations changed. Full integrated
  suites remain hosted-check evidence; green CI does not close the standalone residual.
- Merge route: no high-risk path; ready after local checks. Auto-merge request uses existing
  repository policy only; if disabled, report that fact without changing repository settings.
- Claude owns the bounded fix or requests Malcolm's explicit residual disposition. After
  this review submission merges, Codex's next independent task is retrieval-contract/K6 review.
  No new packet starts before this submission merges under the one-task lane loop.
### 30 October 2026 — Claude task 13 (claude-lane): Codex review PR21-R1, upgrade conflict resolution in protected files

```
Packet/subpacket: Codex review reviews/2026-10-30-codex-review-PR21.md, finding PR21-R1 [P2].
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 18f8f5b. Code: f5673de.
Correction: my task-12 entry assumed the Foundation upgrade does not run the foundation-rules member. Codex showed
  that it does, and that a recorded merge conflict in a protected file was blocked from being resolved.
Owned files (shared seam, named and minimal): conductor/src/factory/change/pipeline.js (upgrade passes
  change.foundation.conflicts = run.upgrade.conflicts, recorded by prepareUpgradeMerge from Git); src/factory/build.js
  (validates them as repository paths, refusing otherwise, and passes factoryFeature.upgradeConflicts);
  src/factory/change/gitSafe.js (isRepoPath); src/council/index.js (validates upgradeConflicts);
  src/council/foundationRules.js (a protected file in upgradeConflicts becomes a locked warning to review, not a block);
  three test files; this ledger.
Authority: only from the pipeline's recorded conflicts, never from a unit id or model output. Plain change requests
  and first builds carry no change.foundation. Unlisted protected files, app-profile.json (even when listed) and the
  verify-script check stay blocking.
Checks (cloud Linux, Node 22.22.0), from conductor/:
  council-foundation, factory-build-change, factory-change-pipeline: 107 passed. Against the previous source, 8 fail
    (member, option validation, both bridges, and the pinned change.foundation object); the data-policy and
    verify-script guard passes on both.
  Codex's reproducer as committed still prints REPRODUCED (exit 1), because it hand-builds factoryFeature without
    the new field, mirroring the old bridge. The same script with upgradeConflicts: [file] added prints NOT
    REPRODUCED (exit 0), and its control still passes. The real bridge is covered by the two bridge tests.
  Full suite, node --test --test-concurrency=4 under a child-subreaper wrapper: 1,569 tests, 1,568 passed, 0 failed,
    1 skipped; 120 s. One earlier attempt stalled in test/service/engine.test.js (no tests reported; that file
    passes 7/7 alone on this code). This is environmental: the container does not reap orphans.
Live / fake / skipped / unrun: synthetic repos and factory harnesses; no real upgrade with a model.
Open: Codex may want its reproducer to take the bridged field, or to retire it in favour of the tests.
Reviewer disposition and reviewed SHA: re-review requested at f5673de.
```
