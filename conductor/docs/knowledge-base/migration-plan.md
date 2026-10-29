# Library of Babel: staged migration plan and implementation backlog

**Packet:** P06, required output 6. **Status:** proposal. Nothing here has been started, and nothing in it authorises changes to Babel or the import of any personal or company data. Each stage needs the operator's go-ahead. Architecture: [`recommendation.md`](recommendation.md). Evidence about Babel: [`inventory.md`](inventory.md).

## The decision this plan rests on

**Babel stays the personal knowledge base. The company KB is a new, separate deployment.** Content moves from Babel into it only by **selective, reviewed copy**; Babel is never upgraded into the company KB.

The inventory shows why. About 6% of Babel's documents are plausible company material. The rest is personal material, third-party corpora, automated feeds from other organisations' domains and agent logs. Babel has one identity, and its only access boundary is a private flag. Separating these afterwards inside one database is harder and riskier than starting clean.

## Stage 0: make Babel safe to copy from (owner: Malcolm; outside the Shingon repo)

1. **Backups:** take a full `pg_dump` plus a copy of the media dataset, restore both into a scratch database, and compare document and chunk counts. Do this before any export runs. Record the date and counts.
2. **Inventory questions:** answer [`inventory.md` §6](inventory.md#6-questions-for-the-source-operator-needed-before-migration), especially private counts, embedding dimension, originals and ownership of each project family.
3. **Recommended:**
   - finish the database password rotation;
   - give coding sessions a **read-only** Babel connector, or remove `delete_document` from the default tool set;
   - confirm whether the read endpoints are still reachable without authentication.

**Exit:** a restore has been tested and the ownership answers are recorded. **Rollback:** not applicable, because nothing changes in Babel's data.

## Stage 1: stand up an empty company KB (owner: implementation lane; reviewer: other lane)

1. Build the service from the recommendation: PostgreSQL + pgvector, a filesystem originals store, a parser worker, and the read-only API from the [retrieval contract](retrieval-contract.md). The spike's schema is a starting point, not production code.
2. Port the spike's 21 checks and the 25 questions into the service's test suite. Add the hybrid and reranker variants and the calibration step from [`evaluation.md`](evaluation.md#next-experiment-when-an-embedding-host-is-available).
3. **Backups:** pgBackRest (or a nightly `pg_dump` for v0) plus an originals copy, both off the box. Run a **restore drill**: rebuild from backup on a scratch host and get identical search results for the labelled questions.

**Exit:** all checks pass on the target host; a restore drill is recorded; hybrid evaluation figures are recorded. **Rollback:** delete the deployment; nothing depends on it yet.

## Stage 2: reference knowledge first (development use only)

1. **Collections from repositories, not from Babel copies:**
   - "Foundation docs" from `foundation/docs` and BUILDING-ON at the released tag;
   - "Conductor docs";
   - "Company coding standards", written fresh.
   
   The source of truth is Git. Re-sync on each release tag.
2. Issue a Conductor project token over these `reference` collections only. Add the Conductor evidence step (§5–6 of the contract) behind a config flag that is **off by default**.

**Exit:**
- a synthetic Conductor run cites reference passages;
- the destination policy withholds a `local-model`-only collection from the subscription vendors;
- an injected-instruction passage has no effect on approvals.

**Rollback:** turn the flag off and revoke the token.

## Stage 3: selective copy from Babel

1. **Candidate list:** project families marked "company" in Stage 0. Leave out:
   - personal projects;
   - third-party corpora;
   - `video_dump`;
   - `cinema/*`, unless ownership is confirmed;
   - **every agent-written log, index, draft and proposal page** (titles beginning `Log:`, `Index:`, `Draft `, `proposal_event_id`), which are derived or duplicated material.
2. **Export:** read-only through the existing MCP `list_project_documents` and `read_document` calls. Write a staging folder of Markdown files with a sidecar JSON for each: Babel id, project, title, tags, `created_at`/`updated_at`, visibility. **Private documents are not exported.** Babel is not modified.
3. **Triage:** produce a review sheet (one row per document: keep / rewrite / drop, owner, collection, ACL group, supersedes) for the operator to fill in. Nothing is imported without a "keep" decision. Expect many notes to be out of date. The Obsidian import notes already say "aspirational" infrastructure documents were superseded.
4. **Import:** through the normal sync pipeline with provenance `migrated-from: babel:<id> on <date>`. Re-running is a no-op, and removing a row from the sheet deletes that document on the next sync.
5. **Verification:**
   - counts match the "keep" rows;
   - 20 random documents are spot-checked against Babel;
   - the labelled questions still pass;
   - an unauthorised-result sweep returns 0.

**Rollback:** remove the migrated collection(s) through sync deletion. Babel is untouched.

## Stage 4: personal KB evolution (optional, separate)

Babel keeps working as it is. The improvements below are worth doing only when Malcolm wants them, and none blocks the company KB:
- reranker-calibrated scores;
- title/exact-match boosting;
- a read-only coding connector;
- tested backups;
- optional retirement of agent-written index churn.

Re-platforming Babel onto the same stack as the company KB would be a separate deployment with separate credentials. Decide on it later from Stage 1–3 experience.

## Stage 5: client runtime knowledge (per client, only when a brief asks)

A Foundation optional module (`knowledge`), enabled from the brief's `modules`, with the KB destination listed in `policy.outbound` and the client's residency. The module uses the per-app credential and user assertion from the contract. It is tested by the crossing harness for every role. Client data stays on the client's chosen hosting and never flows back to Conductor.

## Implementation tasks (each one separately reviewable)

| # | Task | Depends on | Acceptance |
|---|---|---|---|
| K1 | Babel Stage 0 safeguards and inventory answers (Malcolm) | — | Restore test recorded; §6 answered |
| K2 | KB service skeleton: schema, sync, keyword search, import status, audit (port the spike) | P06 accepted | Spike's 21 checks + 25 questions pass in CI |
| K3 | Hybrid retrieval: pgvector HNSW + nomic-embed-text v1.5 + RRF; iterative scan for ACL filters | K2, a host with models | Paraphrase questions pass; 0 unauthorised in sweeps with HNSW |
| K4 | Reranker + calibrated `evidence` thresholds | K3 | Abstention measured on a held-out half; thresholds recorded |
| K5 | Parser upgrade: Docling + OCRmyPDF for scans, page/bbox/sheet-cell locators | K2 | Scanned and table fixtures cited with correct locators |
| K6 | HTTP API per contract v1 (+ fixtures), loopback or private network only | K2; contract accepted | Contract fixtures pass; negative auth tests |
| K7 | MCP adapter (three read tools) over K6 | K6 | Same results as API; no write tools; audience-bound tokens |
| K8 | Conductor evidence step + destination policy, behind a flag | K6 | Synthetic run cites passages; withheld-destination report; injection test |
| K9 | Backups + restore drill automation | K2 | Monthly drill passes |
| K10 | Babel export-to-staging tool + triage sheet (read-only) | K1 | Export reproducible; private docs excluded |
| K11 | Stage 3 import of approved documents | K10, K2–K5 | Verification list in Stage 3 |
| K12 | Foundation `knowledge` module (client runtime), first behind a demo brief | K6, a real client need | Crossing harness covers its routes; outbound/residency enforced |
| K13 | Live connector (SharePoint or Drive) with ACL sync | K6, a client that needs it | Live revoke/delete propagation measured, not mocked |
