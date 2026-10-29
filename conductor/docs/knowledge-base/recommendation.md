# Knowledge-base recommendation

**Packet:** P06, required output 2. **Status:** recommendation for review by Codex and decision by Malcolm. Nothing here is implemented beyond the evaluation spike. Inputs: [inventory](inventory.md), [options](options.md), [evaluation](evaluation.md), [contract](retrieval-contract.md), [migration plan](migration-plan.md).

## Decisions requested

**Recorded 29 October 2026:** Malcolm chose task K2 as the next step, accepting **D1**, **D2** and **D5**. **D3** and **D4** remain open. Stack details: [ADR 0001](adr-0001-kb-service-stack.md).

| # | Decision | Recommendation | Main alternative |
|---|---|---|---|
| D1 | Personal vs company | **Two separate deployments with separate credentials.** Babel stays personal; the company KB is new. | Collections or tenants inside Babel: rejected, because Babel has one identity and only a private flag ([inventory §2](inventory.md#2-data-model-documented-unless-marked)) |
| D2 | Company KB architecture | **Composable: PostgreSQL + pgvector + filesystem originals + Docling/OCRmyPDF + local embeddings and reranker + our read-only API, with MCP as a thin adapter** | Onyx Business, if M365/Google permission sync is needed before we can build and test it (get a price first) |
| D3 | Client runtime knowledge | **The same service deployed per client** on the client's box/hosting, through a Foundation `knowledge` module, only when a brief needs it | Azure AI Search UK South, for a client already on Azure who pays for it |
| D4 | Hosting of the company KB | **One UK-located box Malcolm controls** (existing server or a UK VPS), private network only, with off-box backups | Managed cloud (see D2 alternative) |
| D5 | First integration | **Read-only reference knowledge for Conductor** (Foundation and Conductor docs, standards), behind a flag | Starting with client data: rejected, as it crosses the client-data boundary first |

## Why composable for the company KB (and where this could be wrong)

**For it:**
- **The work that matters cannot be bought off the shelf at this size.** No option meets R1 (permissions enforced before retrieval, per client, including on originals and caches) without either trusting a vendor's permission layer or building one. Onyx's version is proprietary and paid, and had a cross-group disclosure advisory in July 2026. Azure's is preview. AWS documents its user context as "filtering, not authentication" ([options §A–B](options.md)). The spike showed that a small, inspectable permission layer can pass an oracle-checked sweep with 0 unauthorised results ([evaluation](evaluation.md)). We also need that test whichever product we pick.
- **It reuses what Shingon already runs and tests.** Foundation is PostgreSQL. Babel is PostgreSQL + pgvector + nomic-embed-text. All candidate libraries are permissive: pgvector PostgreSQL licence, Docling MIT, OCRmyPDF MPL-2.0, reranker Apache-2.0.
- **It is the lightest runtime.** One PostgreSQL plus a worker, versus OpenSearch/Elasticsearch-based products that need 10–16 GB. A separate search engine is not justified at ~400k chunks ([options §C](options.md#c-composable-self-hosted-stack)).
- **Exports are plain SQL plus original files.** Nothing is locked into a proprietary index.

**Against it (the risks I'd want Codex to push on):**
- **We own more code.** Ingestion, sync, the API and the permission layer are ours to test and patch. Mitigation: keep it small (contract v0 has five endpoints, no writes), and port the spike's checks into CI from day one (K2).
- **Live connector permission sync is genuinely hard.** Graph needs `Sites.FullControl.All` to read permissions properly, SharePoint omits `inheritedFrom`, and library-level changes may not show in delta ([options §C](options.md#c-composable-self-hosted-stack)). **I recommend not building live connectors until a client needs one** (K13). Until then, imports are drag-and-drop, bulk folders and repository syncs, with ACLs set in the import manifest. If a client needs live SharePoint ACL sync soon, Onyx Business or Azure's preview may be the faster route. That is the main condition under which D2 should flip.
- **Retrieval quality is unproven here.** The spike measured keyword search only. Paraphrase questions failed and abstention was unreliable ([evaluation](evaluation.md#what-the-misses-mean)). The hybrid + reranker experiment (K3–K4) must show it closes those gaps before Stage 3 imports anything. If CPU reranking is too slow on the chosen box, revisit hardware before revisiting the architecture.

## Reference architecture: company KB

```
 sources ──► import worker (sandboxed, no network) ──► originals store (filesystem, per-tenant dirs, sha256)
  drag/drop      Docling (+ OCRmyPDF for scans)         │
  folders        chunk + locator (page/section/cell)    ▼
  git repos      embed (nomic-embed-text v1.5, 768-d)  PostgreSQL 16+: tenants, principals, groups,
  [later: Graph/  instruction-like flag                 collections, sources, versions, chunks (ACL cols,
   Drive sync]   import_events                          tsvector, halfvec HNSW), audit
                                                        │
                       read-only KB API (contract v0) ◄─┘  authorise → hybrid (FTS + vector, RRF)
                        │            │                     → rerank (bge-reranker-v2-m3) → evidence level
          Conductor (project token)  Foundation app server (app credential + user assertion)
          MCP adapter (STDIO) for       browser never sees KB credentials
          Claude Code / Codex
```

- **Isolation.** One tenant per client plus a `company` tenant for reference knowledge. Credentials are bound to a tenant; ACL columns live on every chunk. RLS with `FORCE ROW LEVEL SECURITY` sits under a non-owner API role as defence in depth.
- **BM25.** Stay on native full-text until the hybrid experiment says otherwise. pg_textsearch needs PG 17+ and its statistics cross permission boundaries. ParadeDB and VectorChord are AGPL.
- **Parser isolation.** The import worker runs as its own user/container with no network and resource limits, the same posture as Foundation's PDF reader process. Parsing untrusted files is the riskiest code path.
- **Backups.** Nightly `pg_dump` (v0), then pgBackRest PITR. Originals are copied off-box. A restore drill runs monthly (K9).
- **Size guide** (assumed; measure in K3): 8 vCPU / 32 GB RAM / 200 GB SSD comfortably holds 400k × 768-d `halfvec` (~0.6 GB) plus the models. Initial OCR and parsing of a large archive is the slow step and should run as a one-off batch.

## Reference architecture: personal KB

**Keep Babel.** Do not migrate it for the sake of it. Improvements in order of value ([migration plan Stage 4](migration-plan.md#stage-4-personal-kb-evolution-optional-separate)):
1. a tested backup;
2. a read-only connector for coding sessions;
3. a reranker-calibrated score and exact-title boost (the inventory's probes failed exactly there);
4. stop agent-written index churn.

Re-platforming Babel onto the company stack later is possible because the stack is the same family. It is a separate decision.

## Cost at the stated scale (assumptions marked)

| Item | Composable (recommended) | Managed alternative for comparison |
|---|---|---|
| Hosting | Existing UK server: marginal power only; or a UK VPS (8 vCPU/32 GB): price **not verified** in this research | Azure AI Search Basic ~£55–60/mo, ~2× with SLA [U]; Bedrock Managed KB ~£21–26/mo [F] |
| Parsing 200k pages | Local CPU time (Docling/OCRmyPDF); £0 cash; hours to days, **unmeasured** | ~$300–2,000 one-off (Google/AWS list prices) [F] |
| Licences | £0 (all permissive) | Onyx Business: price unseen |
| People time | Build K2–K9: largest cost; mitigated by the spike and a small contract | Integration + permission testing still needed |

## Security summary

- Imported documents are **evidence, not instructions** (contract §1, §6). The `instructionLike` flag is advisory only.
- **Authorise before retrieval**, on originals, previews, citations and caches too (contract §1, §8). Hidden documents return 404.
- **Read-only access paths.** Ingestion credentials are separate and operator-held. No write tool is exposed over MCP.
- **Destinations policy** per collection (contract §5): reference knowledge can go to subscription vendors, client data never, and Anthropic's first-party API offers only US/global inference geography ([options §B](options.md#b-managed-retrieval-services)).
- **Logs and embeddings.** Query text is hashed in audit by default. Embeddings of client data stay in that client's deployment. Secrets are never indexed: the import worker refuses files matching credential patterns. That rule is to be added in K2 and is **not in the spike**.

## What would change this recommendation

- A client requires live SharePoint/OneDrive ACL sync within weeks → price Onyx Business, or use Azure AI Search on the client's tenant, rather than rushing K13.
- The hybrid + reranker experiment fails to fix paraphrase and abstention on CPU → revisit hardware or a managed reranker for reference knowledge only.
- Malcolm decides personal and company knowledge should share one UI → still two deployments, with a federated read-only search across them in the operator's own tools only.
