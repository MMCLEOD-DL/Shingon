# Next-phase backlog (after the two-week operator-app milestone)

**Packet:** P09. **Status:** proposal for review by Codex and prioritisation by Malcolm. Written 29 October 2026 at baseline `3e696db`. Nothing in this file is started, approved or in scope for the fortnight ([00-index §1](../superpowers/plans/2026-10-29-two-week-product/00-index.md#explicitly-outside-the-fortnight)). Each item states what the repo already has, with paths verified at that commit, what is missing, dependencies, and acceptance examples in the factory's given/when/then style.

**Sources:** the five items named in [P09](../superpowers/plans/2026-10-29-two-week-product/01-task-packets.md#p09--bring-earlier-notes-into-an-actionable-next-backlog), the repository, `2026-10-27-factory-acceptance/FOLLOW-UPS.md` and the [knowledge-base research](../knowledge-base/README.md). The older Windows project's records are in the Library of Babel `shingon` project. They describe a different code base and were treated as history only; no claim below relies on them.

## Recommended order, and where I disagree with the plan's suggestion

The master plan suggests: package the app → expenses → research sessions → skill store → KB integration ([00-index §7](../superpowers/plans/2026-10-29-two-week-product/00-index.md#7-end-of-fortnight-handover)). I propose:

1. **Expenses through the factory**, not as hand-written Foundation features. It is the first real client job named in the factory spec, and the Plan 12 acceptance build (tasks 13–15) has not run yet (`spikes/acceptance/` holds only a template). Running it is the best test of everything already built.
2. **Desktop packaging**, but only for the topology P08 actually proves. Packaging an unproven topology freezes guesses.
3. **KB reference knowledge for Conductor** (K2–K8), read-only. It is small, isolated and makes 1 and 4 better.
4. **Lessons ledger** (a narrow, reviewed version of "self-improving skills").
5. **Research sessions** last. This is the least specified item and the one most likely to bend the council's deliberate design.

The reasons are under each item. If Malcolm's priority is personal productivity rather than client delivery, swap 1 and 5.

## 1. Client expenses workflow

**Already in the repo (implemented and tested, Foundation v0.2.0):**
- **OCR confirm-or-correct:** `apps/server/src/modules/ocr/repo.ts` `confirmReading` stores confirmed values and audits the corrected field *names* only. Tests: `apps/server/test/readings.test.ts`.
- **Receipt file follows the expense:** `reattachFile` (`apps/server/src/files/repo.ts`), documented in BUILDING-ON "Optional modules".
- **Money reports:** `buildMoneyReport` (`packages/shared/src/report.ts`), with PDF/XLSX export through `sendReport` (`apps/server/src/modules/exports/reply.ts`). Pinned by hand-worked examples.
- **Scheduled app jobs:** `registerAppJob` (`apps/server/src/jobs/registry.ts`), run by ops. A job cannot send email itself; it queues work for the app (BUILDING-ON).
- **PDF receipts:** since P02, PDFs over 3 pages are refused for manual entry.

**Planned only:**
- The `expenses:approve` permission is an *example* in BUILDING-ON; it is not in `PERMISSIONS`.
- The Plan 12 acceptance build and the "Mileage claims" change (`2026-10-27-factory-acceptance/task-13…15`).

**Missing:**
- expense records, categories, claims;
- an approval state machine with approval history;
- an edit history after confirmation (today only OCR-time corrections are recorded, as names);
- a reminder template and job;
- exports bundling original receipts (no ZIP or attachment embedding exists);
- crossing cases for approvals.

**Where it belongs:** the expenses-specific parts are **client features built by the factory from a brief**. Foundation's rule is that client apps add features and leave the foundation alone (BUILDING-ON, opening). Only generic, reusable pieces should go into Foundation, each as its own reviewed change:
- (a) an "export bundle" helper (report + attached original files, ZIP, size-bounded, one at a time like `sendReport`);
- (b) a templated-email path that a job can queue;
- (c) optionally, a generic approval-history pattern in BUILDING-ON.

Hand-building an expenses module into Foundation would fork the factory's job.

**Dependencies and owner:**
- Plan 12 tasks 13–15 executed by the operator.
- FOLLOW-UPS export items:
  - no app name in the PDF;
  - a subtotal can be orphaned at a page top;
  - the export lock has no timeout;
  - the export path has not been run in the image.
- Owner: whichever lane runs the factory; Foundation helpers go through cross-review as usual.

**Acceptance examples:**
- Given Jamie confirms a £45.00 fuel receipt with £7.50 VAT after correcting the merchant, when Moira (a manager) opens the claim, then the history shows "merchant corrected by Jamie" with a time, and her approval is recorded with her name and time.
- Given a member, when they call the approve route for their own claim, then the crossing harness records 403.
- Given three people with unconfirmed readings on the 25th at 09:00 UK time, when the reminder job runs, then exactly three reminder emails are queued, and a second run the same day queues none.
- Given March's approved claims, when the finance manager downloads the March bundle, then the ZIP holds the report PDF and one original receipt file per claim, named by claim id, and its totals equal the report's hand-worked totals.

## 2. Desktop packaging of the operator app

**Already in the repo:**
- Only the CLI: `bin/conductor.js` and `bin/conductor-probe.js`, with XDG config/state paths (`src/cli/config.js`, `src/workspace.js`).
- README asks the user to copy the config and add the binary to PATH by hand.
- `SETUP.md` predates the factory.
- No installer, service unit, start script or Windows script.

**Planned within the fortnight:** P03 loopback service; P05 "one documented app command" with start/stop/second-start/restart and port-collision tests and `docs/operator-app/setup.md`. P00 is still to define data paths for Linux and Windows/WSL.

**Missing after P05:** a packaged distributable; auto-start; an upgrade path that preserves config and run state; uninstall.

**Recorded limits:**
- Electron/Tauri and signed installers are out of scope for the fortnight.
- Do not provision Windows services incidentally.
- Do not claim untested systems.
- Notify the operator before going live as a product (MVP spec).
- The acceptance topology is still OPEN in the work log.

**My position:** **do not choose Electron or Tauri yet.** The operator app is a loopback web service plus a browser. A wrapper adds an update channel, code signing and a second security boundary, and P08 has not even settled which OS the service runs on. First make P05's single command boring and reliable on the proven topology. Add a wrapper only if a browser tab proves to be a real usability problem.

**Dependencies:** P05 and P08 outcomes; the topology decision. **Owner:** Codex lane (P05 owner), Claude reviewing.

**Acceptance examples:**
- Given a fresh user account on the proven topology, when the operator runs the one documented command, then dependencies install from lockfiles, the UI builds, and the service listens on 127.0.0.1 only.
- A second run says "already running" and starts nothing.
- Given saved config and a finished run, when the package is upgraded, then both survive and the old run is still listed.
- Given a request with a foreign `Origin`, when it hits any mutating endpoint, then it is refused.

## 3. Company knowledge-base implementation

**Already in the repo:**
- Research and a synthetic spike only: [`docs/knowledge-base/`](../knowledge-base/README.md) and `spikes/knowledge-base-evaluation/` (keyword only; 21/21 permission, sync and deletion checks).
- No KB code in Conductor or Foundation.
- Hooks to reuse: `src/factory/outbound.js` (outbound allow-list) and Foundation's fixed `MODULES` list (`packages/shared/src/modules.ts`). A `knowledge` module would need adding there and to the brief validator.

**Missing:** tasks K2–K13 of the [migration plan](../knowledge-base/migration-plan.md#implementation-tasks-each-one-separately-reviewable), and Malcolm's decisions D1–D5 in the [recommendation](../knowledge-base/recommendation.md).

**Order:**
1. K2 (service skeleton);
2. K3–K4 (hybrid and reranker, on a host with local models);
3. K6–K8 (API, MCP adapter, Conductor evidence step behind a flag).

Client runtime (K12) and live connectors (K13) come only with a real client need.

**Recorded limits:**
- Read-only first.
- Documents are evidence, not instructions.
- No client data into Conductor or the vendors (contract §7).
- The KB must not become a hidden dependency of the coding app: the evidence step is off by default.

**Owner:** Claude lane for K2–K5 and K8; Codex reviews. K6/K7 to be decided with the P03 owner, because the HTTP and security patterns should match the operator service.

**Acceptance examples:**
- Given a `local-model`-only collection, when Conductor assembles evidence for a Claude or Codex participant, then those passages are withheld and the run log says so.
- Given a document revoked at the source, when the next sync completes, then it is absent from results and its original returns not-found.
- Given the evidence flag is off, when any run happens, then no KB request is made.

## 4. Validated, versioned lessons (the reviewed form of "self-improving skills")

**Already in the repo:**
- `src/workerMemory.js` remembers only which participants served earlier runs ("a convenience only", no content).
- Role prompts in `src/roles.js` are fixed and unversioned.
- `src/council/foundationRules.js` hand-encodes BUILDING-ON rules as locked findings. That is curated knowledge, which is the right model.
- The repo has no skills folder and no `AGENTS.md`/`CLAUDE.md`, although `03-parallel-working.md` tells sessions to read applicable ones.

**Recorded limits:**
- "Automatic self-modifying skills" are out of scope.
- Retrieved or learned text can never approve, waive a check, change a test command, or become a skill automatically (research brief; retrieval contract §6).

**My position:** build a **lessons ledger**, not self-modifying skills:
- A lesson is a short, versioned rule (`id@version`, text, scope, source run/finding, author, reviewer).
- It is proposed from a run artefact, such as a council finding, an escalation answer or a FOLLOW-UPS line.
- It is active only after the operator approves it **and** a cross-vendor check confirms it does not contradict BUILDING-ON or the council's locked rules.
- Active lessons enter prompts in a delimited block with their ids, so a bad one can be traced and rolled back.

"Self-improving" then means "proposes improvements for review". The risk of an agent quietly rewriting its own guidance outweighs the convenience.

**Missing:** everything: store, schema, proposal path, review gate, prompt injection point, rollback.

**Dependencies:** none hard. The operator UI (P04) is the natural place to review lessons later; the first version can use the CLI. **Owner:** to be assigned; suggest Claude, with Codex reviewing the prompt-injection point.

**Acceptance examples:**
- Given a lesson proposed from run X's council finding, when it has not been approved and cross-checked, then no prompt contains it.
- Given an approved lesson `L7@2`, when a run uses it, then the transcript names `L7@2`. When the operator rolls back to `L7@1`, the next run's prompt contains version 1 only.
- Given a proposed lesson that says "skip the licence check for small changes", when cross-checked, then it is rejected as conflicting with a locked rule.

## 5. Persistent collaborative and adversarial research sessions

**Already in the repo (all oriented to code review, none to research):**
- **Review loop:** produce → review → revise with a round limit, failing closed (`src/review.js`).
- **Rival-vendor reviewer role** (`src/roles.js`).
- **Deadlock and escalation:** settlement only when reversible, tested and reviewed, otherwise escalation (`src/deadlock.js`, `src/escalation.js`).
- **Persistence and resume:** redacted transcript and atomic state outside the workspace, with resume (`src/runlog.js`, `src/conductor.js`).
- **Multi-round Q&A:** the brief session is the closest analogue (`src/factory/briefSession.js`, `briefRun.js` limits).
- **Council:** members review independently, with **no debate by design** (factory spec §4.3).

**Missing:**
- a research-question object;
- a session that outlives a single run and is not tied to a repository branch;
- model-to-model challenge with rebuttals;
- a shared evidence store with citations (this is where the KB contract helps);
- scheduling of later rounds;
- a UI.

**My position:** treat this as a **new run type**, not a change to the council. The council's independence is a deliberate guard against anchoring, and debate would weaken it. A research session can reuse:
- the review loop's fail-closed verdicts;
- the escalation wording;
- run-log persistence and resume;
- the KB retrieval contract for citations.

It must keep the one-active-operation rule until process cleanup is run-scoped (`src/exec.js` `killAllChildren` is process-wide), and it must show subscription spend before every round. It needs a short spec before any code: what a "finding" is, what ends a session, and how disagreements are presented to Malcolm.

**Dependencies:** the operator service (P03) and UI (P04); KB K6 for cited evidence; run-scoped process cleanup if sessions are ever to run alongside coding runs. **Owner:** to be assigned after a spec.

**Acceptance examples:**
- Given a research question and two vendors, when vendor B challenges claim 3 in vendor A's note, then the session records the objection, A's rebuttal and the cited passages.
- After a service restart, the session resumes without repeating finished rounds.
- Given an objection still unresolved after the round limit, when the session ends, then Malcolm sees it as an escalation with both positions and their evidence, never as an agreed conclusion.
- Given each new round, when it would use subscription allowance, then the estimated cost is shown and the round waits for consent.

## Housekeeping found while writing this (small, separate changes)

- ~~**Missing instruction files:**~~ Done: the root `AGENTS.md` (Codex loop) and `.claude/skills/claude-lane/SKILL.md` (Claude loop) now hold the ownership and evidence rules.
- ~~**Factory protection list:**~~ Done on 30 October 2026 (Claude task 12). `PROTECTED_PATHS` now covers the v0.2.0 layout, and a new `PROTECTED_DIRS` covers whole folders:
  - the modules (`modules/`, `apps/server/src/modules/`, `apps/web/src/modules/`);
  - `app-profile.json` (the data policy) and the shared code that reads it;
  - the money, report and receipt code;
  - the job registry and the ops job runner;
  - the shared package's test config and verify scripts.
