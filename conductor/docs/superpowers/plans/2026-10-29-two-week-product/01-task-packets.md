# Implementation and research packets

Use alongside [the master plan](00-index.md). A packet is complete only after its acceptance evidence and reviewer disposition are recorded. Owners below are provisional roles, not a claim that an agent has started. Each coding packet should be a small independently reviewable change; split it further if its diff mixes unrelated concerns.

## P00 — Baseline and contract freeze

**Owner Codex; reviewer Claude.** Start immediately; target day 1. Own this plan folder and proposed contract fixtures, not application logic yet.

1. Record exact checkout/ref and pre-existing changes, read applicable AGENTS.md, relevant specs, follow-ups and previous smoke results. Never silently discard existing work.
2. Inspect `src/conductor.js`, `src/cli/prepareRun.js`, `src/runlog.js`, `src/ui/ask.js`, `src/askUser.js`, `src/exec.js`, configuration and adapters. List which CLI responsibilities need shared service helpers and which can stay CLI-specific.
3. Confirm real cancellation behaviour. `killAllChildren` is process-wide today: v1 must allow only one active run per service process and avoid running probes concurrently with an active run. Do not promise safe multi-run concurrency by adding a queue alone.
4. Establish supported host topology and versions. Write a short architecture ADR selecting dependencies and folders; use existing pins where compatible, preserve TLS/integrity checks, and choose permissive licences.
5. Refine and freeze [contract v1](02-interface-contract.md). Commit minimal request/response/event/decision fixtures and a fake engine scenario that P04 can consume without P03.

**Done:** both owners agree on schema and status semantics; file ownership is recorded; blocked live prerequisites are explicit; no new service depends on terminal scraping. The contract is a proposed design until reviewed, not an existing API.

## P01 — Safe updater after a partially committed settings write

**Owner Codex; reviewer Claude.** Own `foundation/ops/src/update.ts`, `compose.ts`, `durable.ts` only as needed, and their regression tests. Depends on baseline only; can proceed while contract review is underway.

**Reproduction:** `durableWrite` writes/fsyncs a temp file, renames over `.env`, then opens/fsyncs the parent directory. Inject EIO at directory open or sync after a successful rename. `dockerCompose.writeTag` throws but `.env` already contains the target version. `runUpdate` catches it around lines 330–334, calls `cancelAndRestart`, starts the new image without migrations and says the old version is running. A cancellation may clear the recovery journal.

**Work:** make pre-rename failure and post-rename uncertainty distinguishable. Choose read-back plus restoration, or a typed committed/uncertain write outcome. Never restart under a tag whose state is unverified. Preserve recovery evidence if safe restoration fails. Reuse the uncertainty principle already implemented by `setEnv.ts`; do not weaken durable writes or remove directory fsync.

**Required regressions:** failure before rename, failure opening/flushing directory after rename, old-tag restoration success, second failure restoring old tag, and truthful journal/exit/message behaviour. Assert the effective `.env`, migration/start sequence, recovery state and absence of an unannounced new-version launch. Use real temporary files plus injected filesystem calls; no client box.

**Checks:** focused update/Compose/settings/journal tests; Foundation lint/types; full Foundation verify-equivalent before integration. Report any intentional API change to callers. **Done:** reviewer can reproduce old failure and see it fail safely after the fix.

## P02 — Refuse or flag incomplete PDF extraction

**Owner Claude; reviewer Codex.** Own `foundation/modules/ocr/src/pdfWorker.ts`, `pdfText.ts`, `types.ts` if needed, receipt propagation only as required, and focused OCR tests. Do not edit P01's ops files.

**Reproduction:** generate a small four-page text PDF. Page one: `Total GBP 10.00`; page four: `Corrected final total GBP 100.00`. The reader scans only three pages and returns normal success; `readReceipt` returns 1000 pence at confidence 1 with no warning.

**Preferred minimal fix:** refuse a document whose actual page count exceeds the supported maximum, with an actionable manual-entry message. If incomplete-document metadata is chosen instead, carry it through every consumer and cap amount/date/VAT below CONFIDENT. The page cap must remain a resource limit, not silent evidence loss.

**Required regressions:** valid one/three-page PDFs remain readable; four-page PDF cannot yield a confident result; conflicting omitted total/date cannot disappear silently; scanned/unopenable messages remain appropriate. Existing compression-bomb, process deadline, memory ceiling and queue defences must stay effective. Do not report the already deferred predictor/repeated-reference pre-scan issues as new work.

**Checks:** focused PDF/extract/read-receipt tests; OCR module types/lint and full Foundation verification after P01 is integrated. **Done:** no partial read represented as complete; tests prove it without reducing limits/assertions.

## P03 — Local service around the existing engine

**Owner Codex; reviewer Claude.** Proposed owned paths: `conductor/src/service/**`, `conductor/bin/conductor-app.js`, `conductor/test/service/**`, contract fixtures under `conductor/test/fixtures/operator-app/`. Shared engine/config changes require a named, minimal seam change. Own Conductor root manifest/lock changes; P04 sends dependency requests instead of editing them concurrently.

1. Implement repository registration, saved non-secret configuration references, run create/list/read, event replay, diff/test artifacts and the decision endpoints in contract v1.
2. Adapt `runTask`/`resume` hooks. Keep CLI return values and existing approval behaviour. Use existing engine state as authority for completed coding steps; do not fork its orchestration logic into the web service.
3. Persist the service run-to-workspace mapping and normalized events outside the agent-writable project workspace. Validate stored schema on restart; corrupt data fails closed with a repair message.
4. Persist a decision before publishing it. Bind it to the run, exact reviewed commit and supporting evidence. Reject stale or duplicate resolutions and recheck Git state before result approval.
5. On a browser disconnect, do not answer for the user. On service restart, invalidate orphaned in-memory decisions and expose an explicit resume path; a dead JavaScript promise cannot be restored by reloading JSON. Reconstruct hooks using the engine's saved state.
6. One active coding run per service process. Use existing process isolation deliberately and scope cleanup to service-owned children. Never let cancellation of the UI service kill unrelated model servers or other development sessions.
7. Implement the local-browser security boundary before exposing mutation endpoints: loopback binding, validated Host/Origin, session capability, request limits, schema validation and path confinement. No arbitrary shell endpoint.

**Tests:** fake engine/providers for happy/reject/pause/escalation/fallback; event reconnect; service restart with pending decision; duplicate/stale approvals; concurrent starts; foreign origin; path traversal; metadata corruption; escaped artifacts and missing evidence. Assert source HEAD/index/pre-existing edits preserved on rejection/cancel.

**Done:** P04 can run a complete fake journey against the service, CLI compatibility passes, and the reviewer has challenged the approval and restart boundary.

## P04 — Browser operator experience

**Owner Claude; reviewer Codex.** Own a separate `conductor/operator-web/**` package with its own manifest/lock, UI tests and `conductor/docs/operator-app/ux.md`. Never add harness controls to `foundation/apps/web`.

Implement against frozen fixtures first, then switch the same API client to P03. Five views are enough: connections/setup; repository/task; current run; review/decisions; history/resume. The run view should say what is happening, who is doing it, whether local or subscription was used, and what needs Malcolm's attention. Raw transcripts are secondary details.

- Explain subscription CLI sign-in in plain language; never ask the browser to receive CLI session tokens or API credentials.
- Repository selection can initially accept a validated absolute path; do not claim browser-native folder selection grants backend access. Show a friendly project name and canonical path at confirmation.
- Show actual diff, reviewed commit, test outcomes and missing/weak checks before approval. An absent or failed required check must not look green. Approval wording must say it creates a branch, with no automatic merge/deployment.
- Make disagreements actionable: recommendation, evidence, consequences and explicit choices. Show connection loss as unknown/reconnecting, not success or failure inferred from a spinner.
- Treat model output, Markdown, file names and diffs as untrusted text. Avoid raw HTML, unsafe link schemes and terminal escape interpretation. Keyboard use, readable contrast, focus on newly pending questions and normal desktop/phone layouts are acceptance requirements.

**Tests:** rendering/state tests for all contract fixture states; browser journey create→progress→decision→review→approve; reject; error; reconnect; history/resume; stale-button response; malicious diff text. Fake transport is clearly labelled in development only. Production UI must never silently fall back to a simulation.

**Done:** a user can finish the fake journey without terminal knowledge; tests prove the buttons invoke real contract operations, not just visual state changes.

## P05 — Three-model setup and repeatable start

**Owner Codex; reviewer Claude.** Own service setup/probes, installer/start command, configuration helpers and `conductor/docs/operator-app/setup.md`. P04 owns the UI forms and displays.

- Reuse the repository's supported config location/override mechanism and adapters. Keep local-first execution, cross-vendor review and `allowApi: false` explicit. Preserve existing user configuration and credentials; offer backup/atomic replacement for configuration edits.
- Distinguish executable installed, CLI authenticated, model reachable, agentic execution verified and actual routing coverage. Existing CLI probes may only check `--version`; add opt-in bounded authenticated synthetic probes rather than mislabelling that as ready.
- Validate each requested probe against installed CLI behaviour. Do not invent an OAuth API, scrape websites, read session files or expose login cookies. Unsupported headless login remains a documented user action, not a fake success screen.
- Test LocalAI/Qwen through the actual Codex Responses API agentic path. Preserve private CODEX_HOME isolation for local calls and normal supported subscription auth for frontier calls.
- Record versions, show timeouts/rate limits clearly, and explain local-down consent. Never automatically use separately billed APIs, change model servers, wake arbitrary machines or retry indefinitely.
- Provide one documented app command after prerequisites, with deterministic dependency installation and UI build. Verify start, stop, second start and restart. Persist files/configuration; restart processes explicitly. Document the local-browser access method on the acceptance host without making unsupported cloud-preview claims.

**Tests:** missing binaries, unauthenticated result, quota/timeout, local wrong model/key, invalid endpoint, configuration preservation/redaction, repeated install/start and port collision. Live probes are a separate evidence row, require actual supported sign-in/connectivity, and visibly use subscription allowance.

**Done:** documented setup succeeds on the designated host; all three model statuses mean what they say; exact remaining manual steps on other hosts are recorded.

## P06 — Knowledge-base research and recommendation

**Owner Claude; reviewer Codex.** Own `conductor/docs/knowledge-base/**` and optional `conductor/spikes/knowledge-base-evaluation/**`; no live migration or production integration. Read [the research brief](../../../RESEARCH-BACKLOG.md).

**Time box:** roughly two agent-days spread across the fortnight. First finish the recommendation, then use remaining capacity for a small experiment; stop the experiment if it threatens UI integration. If this time box prevents thorough treatment, label uncovered questions and schedule the next research phase rather than claiming exhaustive results.

1. Inventory known Library of Babel interfaces, formats, scale, metadata/ACL model and exports using read-only evidence. If unavailable, write an inventory questionnaire and mark assumptions; do not guess from old conversations.
2. Compare at least three approaches: existing self-hosted KB product, managed service, and a composable source-storage/relational metadata/search stack. Include a simple PostgreSQL full-text/vector candidate; justify a separate search engine only against concrete needs. Compare ingestion/parser tooling separately from storage and model orchestration.
3. Cite official documentation/release/licence/security/pricing pages with retrieval date and version. Separate actual compatibility evidence from vendor claims. Avoid a ranking based only on features or benchmark marketing.
4. Recommend personal and company reference architectures, permission boundaries, UK/EU residency options, backup/restore, deletion, cost at stated document/user/query volumes, and the easiest operational import path. Include tables/spreadsheets, scans and connector sync failures.
5. Define a read-only retrieval contract with identity/tenant scope supplied by a trusted server, bounded query/results, provenance/version/page/cell citations, authorization before retrieval/reranking, stale-source behaviour, and cache invalidation. Compare MCP wrapping the service versus direct API access. Documents remain data, not instructions or automatic skills.
6. If capacity permits, import a fixed synthetic corpus covering Markdown, text PDF, scanned PDF, DOCX and XLSX. Use at least 20 labelled questions including exact facts, tables, absent answers, conflicting versions, restricted documents and injected instructions. Compare keyword and hybrid retrieval; measure answerability/retrieval/citation correctness separately. Define measured latency and host resource use; do not use a model's self-rating as the benchmark.
7. Test unauthorized results and source downloads, permission revocation, updated/deleted documents and repeat imports. Any unauthorized disclosure fails the prototype regardless of average retrieval score. If connectors are mocked, state that live connector permissions/deletion propagation remain unverified.

**Outputs:** `inventory.md`, `options.md`, `recommendation.md`, `retrieval-contract.md`, `migration-plan.md`, optional `evaluation.md` plus reproducible fixtures/results. No secret or mixed personal corpus committed. **Done:** another assistant can implement a staged prototype from the recommendation and distinguish every unknown from demonstrated behaviour.

## P07 — Integration and adversarial checks

**Owner Codex coordinates; Claude reviews and fixes UI-owned files.** Depends on P03–P05.

Connect the real service to the UI and run the acceptance matrix in the master plan using deterministic fake providers first. Test approval races by changing the workspace after review, two browser clients answering the same question, stale event replay and interruption during a decision. Test abrupt service termination and restart, not just tab navigation. Inspect that local secrets/CLI auth stay out of API responses, frontend assets, Git and transcripts. Verify no foreign web page can launch a coding task through the loopback service.

Run the affected existing suites and the complete Conductor suite after integration. Integrate P01/P02 and run Foundation's required checks. Diagnose setup failures separately from defects; do not suppress assertions, mark unexecuted tests green or treat zero-test runs as success.

**Done:** fake-provider acceptance passes, safety fixes integrated, no open blocking defect, and live prerequisites are the only remaining blockers if any.

## P08 — Live acceptance and handover

**Owner Codex; independent reviewer Claude.** Use a disposable synthetic repository and task; never a client box or real personal/company dataset. This packet is execution work for a future authorised task, not a command to spend subscriptions now.

Run a small coding change using local execution and both subscription vendors; capture who actually served each phase. Verify final tests/diff and approval branch. Repeat with rejection and one controlled interruption/resume. Safely simulate unavailable vendors/local endpoints rather than manipulating billing/accounts or stopping shared servers. Rehearse a clean install/start on the designated topology and have the other assistant follow only the written instructions.

Write `conductor/docs/operator-app/acceptance.md`: exact commits/tool versions/host; matrix results; sanitized artifacts; known problems; setup and recovery; what remains mocked or blocked. If live authentication is unavailable, the exit is **candidate with live acceptance blocked**, not completed live validation. No automatic merge, release tag, client ship or public publication.

## P09 — Bring earlier notes into an actionable next backlog

**Owner Claude; reviewer Codex.** Own `conductor/docs/operator-app/next.md` and link it to the research backlog.

Record separately: persistent collaborative/adversarial research sessions; validated versioned self-improving lessons/skills; client expenses with correction history/approvals/reminders and exports containing original receipts; company-KB implementation; desktop packaging. For each, state current implemented overlap, missing behaviour, dependencies, evidence, owner and acceptance examples. Treat older Windows implementation claims as historical until inspected. Reuse Node Conductor's Qwen adapter rather than replacing the engine with the older Python harness.

**Done:** next work is selectable without rediscovering the conversations or silently expanding this fortnight's scope.
