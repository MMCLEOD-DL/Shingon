# Research backlog

## Knowledge-base infrastructure, imports and application access

Recorded: 29 October 2026. Status: research requested; architecture not selected and implementation not started.

**Update, 29 October 2026:** the P06 research outputs are in [`knowledge-base/`](knowledge-base/README.md) and are awaiting review. The recommendation is not yet accepted, and no implementation or migration has started. Still open: the hybrid-retrieval experiment (it needs a host with local models) and the source-operator questions in the inventory.

### User need

The current Library of Babel is an ad hoc knowledge base combining work and personal material. Research the best way to evolve or migrate it, and how to provide a company knowledge base for future projects. Document import and everyday maintenance should be straightforward. Both Conductor and the apps it produces must be able to retrieve and use the right information reliably.

### Questions the research must answer

- **Infrastructure:** compare an existing knowledge-management product, a managed retrieval service and a self-hosted stack. Assess source-document/object storage, metadata and permissions, full-text and vector search, hybrid retrieval and reranking. Establish when a relational database with search/vector support is sufficient and when a separate search service is justified. Compare local, client-box and cloud hosting for cost, hardware, licensing, residency, backups, recovery and operational effort.
- **Personal and company separation:** determine whether separate deployments, tenants or collections provide the appropriate boundaries. Cover company ownership, staff roles, document-level access, client isolation, exportability and offboarding. Do not assume that the mixed personal Library of Babel should become the company database.
- **Easy imports:** assess drag-and-drop files, bulk folder imports and connectors for shared drives, Microsoft 365/SharePoint, Google Workspace, email and existing knowledge stores. Cover PDF (including scans), Word, spreadsheets, slides, plain text, Markdown, HTML and images. Evaluate tables, page/layout preservation, OCR, attachments, large files and unsupported/encrypted documents. Assess Library of Babel's actual export/API capabilities before proposing migration.
- **Ongoing ingestion:** preserve originals and provenance; track stable source IDs, versions, duplicates, source permissions and import errors. Define repeat-safe imports, incremental synchronisation, changed permissions, deletions and removal of derived text, chunks and embeddings. Provide visible import status and actionable failures.
- **Reliable retrieval:** compare chunking, metadata, embeddings, keyword/vector combinations and reranking using representative questions. Answers should cite the source version and page, section, sheet or cell where possible, expose uncertainty and stale/conflicting sources, and abstain when evidence is insufficient. Distinguish document retrieval from querying structured business records or calculating spreadsheet results.
- **Conductor access:** compare an MCP interface and a conventional authenticated search/document API. Define a small, read-only retrieval contract, bounded context and source citations, scoped to the current project. Investigate how approved knowledge is selected and supplied to local models, Claude Code and Codex consistently, including each destination's data policy.
- **Generated-app access:** define a supported Foundation integration that retrieves as the signed-in user and enforces company/client/document permissions before returning content. Consider server-side access, service identities, audit logging, credential rotation, rate limits and safe caching. Keep infrastructure credentials out of browsers and generated repositories.
- **Security and trust:** treat imported documents as untrusted evidence, not instructions. Evaluate prompt injection, malicious files, parser isolation, connector privileges, secrets/personal data in logs and embeddings, and cross-tenant leakage. Apply access controls to original files, previews, search results, citations and caches as well as the main retrieval endpoint.

### Required outputs

1. Inventory the current Library of Babel and document its actual interfaces, export formats, data categories and operational limitations; do not infer them from its name.
2. Produce a source-backed options comparison and recommended reference architectures for a personal knowledge base and a company knowledge base, with costs and a low-effort setup/maintenance path.
3. Define the import/synchronisation pipeline and the retrieval contract shared by Conductor and Foundation apps, including identity, permissions, provenance, limits and failure behaviour.
4. Build a small prototype using synthetic or explicitly approved documents. Benchmark retrieval quality, citation correctness, ingestion effort, latency and local-model context needs across varied formats.
5. Test permission changes and deletion propagation, cross-company isolation, misleading document instructions, conflicting versions and questions without an answer.
6. Write a staged Library of Babel migration plan with verification, backup and rollback, and turn the recommendation into separately reviewable implementation tasks.

### Relationship to the current build

Conductor's existing [project-folder contract](superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md#contract-1--the-client-project-folder-call) keeps client data out of factory projects and model prompts. This research must distinguish approved development/reference knowledge from a client app's runtime business knowledge. It does not authorise importing a company's records into Conductor or sending them to either subscription provider. Any proposed change to that boundary needs an explicit design and user decision.

Start with a read-only integration. Write-back, automatic document editing and autonomous promotion of retrieved material into persistent skills are separate capabilities. The knowledge-base project should support future collaboration and validated reusable skills without making retrieved text authoritative over Conductor's approval or release rules.

Next-phase backlog, covering KB implementation order alongside the other post-fortnight items: [`operator-app/next.md`](operator-app/next.md).

Delivery planning: [two-week product plan, 30 October–12 November 2026](superpowers/plans/2026-10-29-two-week-product/00-index.md), especially P06 and P09.
