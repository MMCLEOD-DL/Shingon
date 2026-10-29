# Knowledge-base options comparison

**Packet:** P06, steps 2–3. **Sources retrieved:** 29–30 October 2026. Every claim carries a link.

**Evidence tags:**
- **[F]** official page, repository file or price list fetched directly.
- **[S]** official page seen only through search excerpts; re-check before relying on it.
- **[U]** unverified.

The environment's network policy blocked several official sites: Azure and AWS pricing pages, docs.aws.amazon.com, Hugging Face, postgresql.org and modelcontextprotocol.io. Equivalent official sources were used where they exist: Microsoft Learn, the AWS Price List API, GitHub repositories of the projects and specifications, and PyPI. The [S] and [U] items are the ones to re-check before a purchase or build decision.

**What this comparison is and is not.** It compares documented capability, licence, residency and cost against this consultancy's requirements. It is not a quality ranking: no option was benchmarked here except the composable keyword baseline in [`evaluation.md`](evaluation.md). Vendor feature lists and benchmark claims are labelled as claims.

**Assumed scale for cost arithmetic** (my assumptions, not vendor figures):
- **Company:** 20k documents ≈ 5 GB source ≈ 200k pages ≈ 400k chunks; 5 staff; 2,000 queries a month.
- **Personal:** Babel's ~7.5k documents.

## Requirements used for scoring

| # | Requirement | Source |
|---|---|---|
| R1 | Document-level permissions and per-client isolation, enforced **before** results are returned, including on originals, previews and caches | Brief: separation, security |
| R2 | Easy imports: drag-and-drop, bulk folder, SharePoint/OneDrive, Google Drive; PDF incl. scans, DOCX, XLSX, PPTX, MD, HTML, images | Brief: easy imports |
| R3 | Repeat-safe sync with versions, deletions, permission changes and visible import errors | Brief: ongoing ingestion |
| R4 | Hybrid retrieval + reranking; citations to version and page/section/sheet/cell; abstention | Brief: reliable retrieval |
| R5 | Read-only API and/or MCP usable by Conductor (local model, Claude Code, Codex) and server-side by Foundation apps as the signed-in user | Brief: access |
| R6 | UK (or UK/EU) residency; client-box or self-host option | Foundation `policy.residency` |
| R7 | Low setup and maintenance effort for one person; predictable cost | Brief: low-effort path |
| R8 | Clear, permissive licence for company use; exportable data | P00 dependency rules |

## A. Existing self-hosted KB / RAG products

*(To be filled in from the product research, which is still running.)*

## B. Managed retrieval services

| | Azure AI Search (UK South) | Bedrock Managed KB (London) | Bedrock classic + S3 Vectors | Google Agent Search | M365 Copilot Retrieval API |
|---|---|---|---|---|---|
| UK residency | Yes, UK South has AI enrichment, semantic ranker and agentic retrieval [F][az-region] | London price list exists [F][aws-pl]; GA region per launch notice [S][aws-mkb] | London [F][aws-pl] | **EU multi-region excludes UK** [S][g-res]; London placement for data stores unclear [U] | Interaction content in UK, but for tenants outside the EU Data Boundary semantic-index processing "can take place either in a tenant region or in the United States" [F][m365-res] |
| Running cost at stated scale | ~£55–60/mo for one Basic unit (Learn implies ≈$67/mo) [F][az-free]; SLA needs ≥2 replicas, so ~2× [F]; tier prices [U] (pricing page blocked) | Storage $5/GB-mo + $0.001/query → ≈ $27–33/mo [F][aws-pl]; "GB" basis [U] | ≈ $0.10/mo storage, queries cents [F][aws-pl]; **no hybrid** [S] | Queries and 10 GiB storage within free allowances → ≈ $0/mo running [F][g-price] | Copilot Business £16.10/user/mo → £80.50 for 5 [F][m365-biz]; or PAYG $0.10/call → $200/mo [F][m365-payg] |
| One-off parsing (200k pages) | Content Understanding / Layout: per-page price [U] | Data Automation $0.01/page → ~$2,000 (or ~$200 if 10% scans) [F][aws-pl] | same | Layout Parser $10/1k pages → $2,000; OCR $1.50/1k → ~$300 [F][g-price] | Included |
| Permissions model (R1) | GA: string security filters **enforced by your code**. Preview: Entra-token enforcement in the query pipeline; SharePoint ACL ingestion (preview) with documented gaps: inherited changes need manual resync, no guests, no nested groups, needs `Sites.FullControl.All`/`Sites.Selected` [F][az-acl][az-sp] | ACL lists ingested; live access checks for SharePoint/OneDrive/Drive; **the caller asserts the user by email: AWS calls it "filtering, not authentication"** [S][aws-acl] | Metadata filters your app enforces [U] | ACL mode fixed at data-store creation; Entra needs Workforce Identity Federation [S][g-acl] | Inherits M365 permissions in place [F][m365-ret] |
| Formats / tables (R2, R4) | PDF, Office, HTML, MD, email; Content Understanding gives page numbers, polygons and cross-page tables [F][az-mm] | [U] (docs blocked) | [U] | Layout parser [F][g-price] | Semantic retrieval only for doc/docx/pptx/pdf/aspx/one; **XLSX, MD and HTML keyword-only**; tables only from doc/docx/pptx; ≤25 unordered results [F][m365-ret] |
| Connectors | Blob, ADLS, SharePoint (preview); **no Google Drive indexer** [F][az-idx] | S3, SharePoint, OneDrive, Google Drive, Confluence, web [S][aws-acl] | Bedrock data sources | Drive native; others [U] | M365 native; Drive via Copilot connector (default visible to all users unless restricted) [F][m365-gd] |
| Retrieval | Hybrid + semantic reranker (top 50) [F] | Hybrid + managed reranker [S] | Vector only | Hybrid + ranking API [F][g-price] | Cosine relevance; no visible reranking [F][m365-ret] |
| MCP | Each knowledge base is an MCP endpoint with optional permission enforcement [F][az-mcp] | Via AgentCore Gateway [S] | — | Preview [S] | Work IQ `retrieve` (preview) [F] |

**Also checked:**
- **OpenAI** file search keeps UK residency for storage only, not processing [S][oai-res]; access control is app-side filters only [U].
- **Anthropic** offers no managed retrieval service and no embedding model. Its first-party API supports only `us`/`global` inference geography [F][anth-res]. That matters for which subscription destinations may receive passages (contract §5).

**What the managed column shows:**
1. Nothing cheap and managed meets R1 for a **client** app without trusting the app server to assert the user. Azure's native token enforcement and SharePoint ACLs are preview. AWS documents its user context as filtering, not authentication. The contract's per-app, per-tenant credential design (§2) is needed whichever is chosen.
2. **Residency is the deciding constraint.**
   - Azure UK South and Bedrock London fit `uk`.
   - Google's EU option excludes the UK.
   - M365 semantic-index processing may happen in the US for UK tenants.
3. **Cost at this scale is dominated by one-off parsing**, not storage or queries. That favours parsing on the box (Docling/OCRmyPDF) even with a managed index.
4. Managed services are attractive for a **client already on Azure or AWS**, where the client pays and owns the subscription. They are a poor fit for Malcolm's own personal and company KB, which would add per-client cloud accounts and lock-in for little gain at ~20k documents.

## C. Composable self-hosted stack

**Storage and search:**
- **PostgreSQL + pgvector.**
  - pgvector 0.8.7 (2026-10-01), PostgreSQL licence [F][pgv-cl].
  - HNSW or IVFFlat; `halfvec` up to 4,000 indexed dimensions; binary quantisation via expression indexes [F][pgv].
  - **Approximate indexes filter after the index scan**, so selective ACL filters can lose results. Since 0.8.0, iterative scans (`hnsw.iterative_scan`, capped by `hnsw.max_scan_tuples`) are the mitigation [F][pgv]. The spike's ACL predicate must be re-tested under HNSW (`evaluation.md`, next experiment).
- **Full-text.**
  - Native Postgres ranking "does not use any global information": no BM25/IDF [F][pg-fts].
  - BM25 options:
    - **pg_textsearch**: PostgreSQL licence, **PG 17/18 only**. Its BM25 statistics include rows hidden by row-level security, so term frequencies can leak across permission boundaries [F][pgts].
    - **ParadeDB pg_search**: AGPL-3.0 [F][pdb].
    - **VectorChord-bm25**: AGPLv3/ELv2 [F][vcb].
- **Row-level security** as defence in depth: owners and BYPASSRLS roles bypass it unless `FORCE ROW LEVEL SECURITY` is set, and policies that check only the row's own columns are the fastest [F][pg-rls]. The spike already keeps ACLs on the chunk row.
- **When a separate engine is justified.** No official source gives a document-count threshold [F/S]. The concrete triggers are:
  - BM25/IDF quality needed on PG16;
  - more than 2,000 or 4,000 indexed dimensions;
  - an HNSW graph that does not fit in RAM;
  - faceting or typo-tolerance at scale.
  
  At 400k × 768-d chunks the raw vectors are ~1.2 GB in float32, well inside a 32–64 GB box. **A separate search service is not justified at the stated scale.** The licences of the alternatives are Qdrant, OpenSearch and Vespa Apache-2.0; Elasticsearch AGPL/SSPL/ELv2 [F][engines].

**Parsing:**

| Tool | Licence / version | Citations it can support | Note |
|---|---|---|---|
| Docling | MIT, 2.145.0 (2026-10-29) [F][docling] | page, bbox, charspan; XLSX sheets as pages with cell-grid coordinates [F][docling-xlsx] | Model licences are separate; check each |
| OCRmyPDF + Tesseract | MPL-2.0, 17.13.0 [F][ocrmypdf] | Adds a text layer that keeps page geometry | Pre-step for scans |
| Unstructured (OSS) | Apache-2.0, 0.27.35 [F][unst] | page number (PDF/DOCX/HTML/PPTX), sheet name, coordinates | The vendor itself says its paid API is more accurate |
| Apache Tika | Apache-2.0, 4.2.0; Java 17 [F][tika] | text and metadata only | Long-tail fallback |
| Marker | Apache code, **weights under a modified Open Rail-M: commercial use free only below $5M revenue/funding** [F][marker] | page + polygon | Avoid for company use unless the licence fits |

**Models (local, CPU):**
- **nomic-embed-text v1/v1.5:** 768-d native, Apache-2.0, task prefixes required [F][fastembed]. This is Babel's current model, so re-embedding uses the same family.
- **bge-m3:** dense + sparse + multi-vector, 1024-d [F][bgem3]; model-card licence [U].
- **bge-reranker-v2-m3:** Apache-2.0, int8 ONNX ~0.57 GB [F][fastembed-rr].
- **No official CPU throughput figures** were found for any of these [U]; they have to be measured on the target box.

**Connectors (R2, R3):**
- Microsoft Graph delta (`/drive/root/delta`) gives deletions, and `deltashowsharingchanges` flags permission changes. **Processing permissions correctly needs `Sites.FullControl.All`**, and SharePoint does not return `inheritedFrom` [F][graph-delta][graph-perm].
- Google Drive `changes.list` page tokens do not expire, and `includeRemoved` covers deletion and loss of access [F][drive].
- Onyx's SharePoint/Drive connectors are MIT, but **their permission sync is in the enterprise-licensed `ee/` tree** [F][onyx-lic].
- Conclusion: content sync can reuse tools; **ACL sync has to be built and tested live** (K13).

**Backups:**
- `pg_dump` gives a consistent snapshot with no point-in-time recovery [F][pg-backup].
- pgBackRest (MIT) and WAL-G (Apache-2.0) give PITR [F][pgbr][walg].
- **MinIO's repository was archived in April 2026**, so use a plain filesystem for originals, or Garage (AGPL-3.0) if an S3 API is needed [F][minio][garage].

**MCP:**
- Spec 2026-07-28: an HTTP server is an OAuth 2.1 resource server with RFC 9728 metadata, audience validation and no token passthrough. STDIO servers use environment credentials [F][mcp-auth].
- The same revision removed sessions and the `initialize` handshake, so SDKs must be pinned [F][mcp-cl].

## Summary against requirements

*(Completed together with section A.)*

## References

[az-region]: https://learn.microsoft.com/azure/search/search-region-support
[az-free]: https://learn.microsoft.com/azure/search/search-try-for-free
[az-acl]: https://learn.microsoft.com/azure/search/search-query-access-control-rbac-enforcement
[az-sp]: https://learn.microsoft.com/azure/search/search-indexer-sharepoint-access-control-lists
[az-mm]: https://learn.microsoft.com/azure/search/multimodal-search-overview
[az-idx]: https://learn.microsoft.com/azure/search/search-indexer-overview
[az-mcp]: https://learn.microsoft.com/azure/search/agentic-retrieval-how-to-retrieve
[aws-pl]: https://pricing.us-east-1.amazonaws.com (AWS Price List API, eu-west-2 offer files published 15–28 Oct 2026)
[aws-mkb]: https://aws.amazon.com/about-aws/whats-new/2026/06/amazon-bedrock-managed-knowledge-base/
[aws-acl]: https://docs.aws.amazon.com/bedrock/latest/userguide/kb-managed-acl.html
[g-price]: https://cloud.google.com/generative-ai-app-builder/pricing
[g-res]: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency
[g-acl]: https://docs.cloud.google.com/generative-ai-app-builder/docs/data-source-access-control
[m365-biz]: https://www.microsoft.com/en-gb/microsoft-365-copilot/business
[m365-payg]: https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/retrieval/paygo-retrieval
[m365-ret]: https://learn.microsoft.com/en-us/microsoft-365-copilot/extensibility/api/ai-services/retrieval/overview
[m365-res]: https://learn.microsoft.com/microsoftsearch/semantic-index-for-copilot
[m365-gd]: https://learn.microsoft.com/microsoft-365/copilot/connectors/google-drive-overview
[oai-res]: https://help.openai.com/en/articles/10503543-data-residency-for-the-openai-api
[anth-res]: https://platform.claude.com/docs/en/manage-claude/data-residency
[pgv]: https://github.com/pgvector/pgvector
[pgv-cl]: https://github.com/pgvector/pgvector/blob/master/CHANGELOG.md
[pg-fts]: https://github.com/postgres/postgres/blob/master/doc/src/sgml/textsearch.sgml
[pg-rls]: https://github.com/postgres/postgres/blob/master/doc/src/sgml/ddl.sgml
[pg-backup]: https://github.com/postgres/postgres/blob/master/doc/src/sgml/backup.sgml
[pgts]: https://github.com/timescale/pg_textsearch
[pdb]: https://github.com/paradedb/paradedb
[vcb]: https://github.com/tensorchord/VectorChord-bm25
[engines]: https://github.com/qdrant/qdrant · https://github.com/opensearch-project/OpenSearch · https://github.com/vespa-engine/vespa · https://github.com/elastic/elasticsearch/blob/main/LICENSE.txt
[docling]: https://pypi.org/project/docling/
[docling-xlsx]: https://github.com/docling-project/docling/blob/main/docling/backend/msexcel_backend.py
[ocrmypdf]: https://pypi.org/project/ocrmypdf/
[unst]: https://github.com/Unstructured-IO/unstructured
[tika]: https://github.com/apache/tika
[marker]: https://github.com/datalab-to/marker
[fastembed]: https://github.com/qdrant/fastembed/blob/main/fastembed/text/pooled_normalized_embedding.py
[fastembed-rr]: https://github.com/qdrant/fastembed/blob/main/fastembed/rerank/cross_encoder/onnx_text_cross_encoder.py
[bgem3]: https://github.com/FlagOpen/FlagEmbedding/tree/master/research/BGE_M3
[graph-delta]: https://learn.microsoft.com/graph/api/driveitem-delta?view=graph-rest-1.0
[graph-perm]: https://learn.microsoft.com/graph/api/resources/permission?view=graph-rest-1.0
[drive]: https://www.googleapis.com/discovery/v1/apis/drive/v3/rest
[onyx-lic]: https://github.com/onyx-dot-app/onyx/blob/main/LICENSE
[pgbr]: https://github.com/pgbackrest/pgbackrest
[walg]: https://github.com/wal-g/wal-g
[minio]: https://github.com/minio/minio
[garage]: https://github.com/deuxfleurs-org/garage
[mcp-auth]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx
[mcp-cl]: https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx
