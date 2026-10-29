# Library of Babel: inventory

**Packet:** P06, step 1. **Collected:** 29 October 2026 by Claude, through the Library of Babel MCP connector already attached to the session. It is read-only use of an existing connector: no export, no writes, no change to the system.

**Evidence levels used below:**
- **Observed:** returned by a tool call in this session.
- **Documented:** stated in Babel's own engineering notes, which are stored in Babel. These notes are written by people and agents at a point in time. They have not been checked against the running code or the database.
- **Unknown:** neither observed nor documented here.

The [research brief](../RESEARCH-BACKLOG.md) asks for interfaces, export formats, data categories and operational limits from evidence, not from the system's name. The **Unknown** rows below are that boundary. They must be closed by the source operator (Malcolm) before a migration starts.

No document content from personal projects is reproduced here. Personal data categories are given as counts only.

## 1. Interfaces

### 1.1 MCP tools exposed to this session (observed)

| Tool | Kind | Notes from use |
|---|---|---|
| `list_projects` | read | Returns 115 projects, 16 of them empty (id, display name, parent, `doc_count`). |
| `list_project_documents` | read | Returns id, title, `visibility`, `created_at`. It does not return `updated_at`, source, size or tags. |
| `search` | read | Hybrid "semantic + fulltext". Optional `project` scope and `limit`. Returns id, title, project, excerpt and score. |
| `read_document` | read | Returns full Markdown `content`, tags, `visibility`, `created_at` and `updated_at`. It returns no source URL, original-file reference, version id or chunk/page provenance. |
| `ask_librarian` | read (RAG) | **Timed out twice at the 60 s MCP limit** (29 Oct 2026). |
| `list_databases` / `query_view` | read | One structured database (`tasks`, displayed as "Reading", 35 rows). The tool says private rows are excluded from counts and results. |
| `create_document`, `update_document`, `delete_document`, `move_document(s)`, `create_project`, `create_row`, `update_row_properties` | **write** | Present on the same connector. **Not called.** |

**Finding:** the connector that Claude Code uses for reading also grants delete and update on the whole non-private library. There is no read-only scope. For a company KB, that combination of permissions is the main thing not to copy (see `retrieval-contract.md` §2).

### 1.2 Other interfaces (documented, not verified)

- **REST API:** an Express server in a single `server.js` file. Documented routes include document CRUD (`PUT` expects `raw_content`), `/api/intake`, `/api/queue`, `/api/librarian`, vault unlock/lock and vault search, reprocess, and `/api/relation-targets` [doc `f6676e62`].
- **Mutation auth:** an `x-api-key` header, but "the API key is served to every browser, so it isn't a real barrier. The vault token is the only real gate" [doc `b12ea649`]. Read endpoints (search, stats, graph) are documented as open on the LAN [doc `f6676e62`].
- **MCP auth:** `babel-mcp` runs its own OAuth 2.1 server for the claude.ai connector. It has a single-user password, dynamic client registration, HS256 JWT access tokens and refresh tokens persisted to a JSON file [doc `747e939e`]. This is one identity: there are no per-user or per-role scopes.
- **Ingestion paths:** an intake queue polled by a Python processor; n8n workflows; Matrix/Element mobile sharing; URL fetch (trafilatura); yt-dlp for social video; faster-whisper transcription; llava for image/key-frame description and OCR; LLM tagging and LLM project routing with llama3.1:8b. The processor can create new projects on its own (`NEW:<parent>/<slug>`) [docs `f6676e62`, `04cb20c2`].
- **Autonomous writers:** a "Wiki Agent" with lint, threshold-ingest and synthesis triggers writes and approves pages, partly automatically ("auto_rule") [doc `0433a912`].

### 1.3 Export and backup

- **Unknown:** no export endpoint or format appears in the MCP tools or in the notes read. A whole-library export would mean either paging `list_project_documents` + `read_document` (Markdown body plus a few fields; no original files, chunks, embeddings or link table) or a database-level dump.
- **Documented:** PostgreSQL 16 with pgvector, `library_of_babel` database, `knowledge_base` schema [doc `f6676e62`]. Media sits on a dedicated ZFS dataset with a 500 GB quota [doc `747e939e`]. Automated backups appear only as a recommendation (Borgmatic or Duplicati), not as a deployed job [doc `d2910678`]. **Whether a tested backup and restore exists is unknown.**

## 2. Data model (documented unless marked)

- **Documents:** Markdown body, title, tags, project, visibility, `cover_image`, `database_id`, and `properties` jsonb for database rows. A generated `content_tsv` column holds full-text. Chunks with embeddings are in a separate table. Links/backlinks and `document_opens` are kept as well [docs `f6676e62`, `b12ea649`].
- **Visibility tiers:** observed values are `internal`, and `private` is documented. Private documents are filtered out of public endpoints and need the vault password token, which has a 4 h TTL. Rows from creating a private document through MCP cannot be read back over MCP afterwards [doc `b12ea649`].
- **Identity and ACL:** single owner. There are no users, groups, roles, tenants or per-document grants beyond the private/not-private flag.
- **Versions:** "version history" is mentioned for rows [doc `b12ea649`]. The MCP tools expose no version id, so citations cannot name a version.
- **Embeddings:** documented as `nomic-embed-text` with a 0.6 cosine threshold, tuned on 30 March 2026 [doc `91c4e05f`, `0be55f04`]. The same note says "384-dimensional". The upstream nomic-embed-text v1/v1.5 models output 768 dimensions natively ([fastembed model registry](https://github.com/qdrant/fastembed/blob/main/fastembed/text/pooled_normalized_embedding.py), retrieved 29 Oct 2026; v1.5 can be truncated by Matryoshka, so 384 is possible but only if deliberate). The stored dimension is therefore **unknown until the column type is checked**. It matters for migration: re-embedding versus reuse.
- **Provenance:** URL-sourced documents put `Source: <url>` in the body text. Uploaded files and the original/derived relationship are not visible through MCP. Page, sheet and cell provenance does not exist in what was observed.

## 3. Scale and data categories (observed via `list_projects`, 29 Oct 2026)

`doc_count` across all projects is **7,495**. It is unclear whether this includes private documents: `list_databases` says its own counts exclude private rows, and `list_projects` does not say. One document is not one source file: imported reference manuals are split one page per document.

| Category (grouped by project prefix) | Docs | Share | Observations relevant to separation |
|---|---:|---:|---|
| Third-party reference corpora (`blender/docs`, `tabletop_gaming/*`) | 3,136 | 42% | Copied manuals and rule texts. Each has its own licence terms (not assessed). They are not company knowledge and dominate search scoring. |
| Cinema industry intelligence (`cinema/*`) | 1,992 | 27% | Automated n8n feeds, including daily workflow health reports stored as documents. Looks like work for a former or other employer: **ownership must be established before any company import.** |
| Saved social/video clips (`video_dump/*`, `ai/tiktok`, `social_media/*`) | 639 | 9% | Third-party media transcripts plus stored video files. |
| Personal (`personal/*`, plus small topical roots such as `japan/*`, `home/*`, `finance`, `cfa`) | 428 | 6% | Recipes, fiction, fitness, career, finance and so on. Must never enter a company KB. |
| Knowledge-management and agent operations (`knowledge-management`) | 229 | 3% | Mostly agent-written logs, indexes and proposals. |
| Engineering and business (`shingon`, `code`, `side_hustle`, `highlandquant*`, `infrastructure`, `work`, `keledones*`, `portfolio*`, `gamedev*`, `ai/*` except TikTok) | 514 | 7% | **The only plausible candidates for a company or development KB.** Even this group mixes personal infrastructure, job-search and side projects. |
| Other (`blender` add-on notes, `caribbean_rhythms`, `design`, `literature`, `philosophy`) | 557 | 7% | Mixed; needs a per-project decision. |

**Conclusion:** Babel is a personal library that contains some business notes. It is not a company library with personal notes added. This supports the brief's warning: the company KB should be **a new, separate deployment** filled by selective, reviewed import, not a fork or upgrade of Babel. See `recommendation.md`.

## 4. Retrieval behaviour observed (informal probes, not a benchmark)

These are four probes, not the labelled evaluation required in step 6. They show behaviour that the formal evaluation must measure.

| Probe | Observed |
|---|---|
| "Master Backlog" scoped to `infrastructure` (title of a canonical doc referenced by others) | The target doc was not returned. Results were unrelated drafts scoring 0.80–0.90. **Exact-title lookup failed.** |
| "private documents access control visibility permissions Babel" | 4 of 10 results were camera motion-control rig articles ("control"), all scoring exactly 1.0. |
| "Master Backlog Open Work Infrastructure Security" (unscoped) | Returned "Email Infrastructure", not the backlog. |
| "Library of Babel architecture database schema ingestion" | Good: relevant system notes ranked first. |

- Many unrelated results share a score of exactly **1.0**. That suggests a clamped or fused score that cannot be used for an abstain threshold. A downstream consumer cannot tell a strong hit from keyword noise.
- `ask_librarian` gave **no answer within 60 s** on two questions: one answerable and one deliberately unanswerable. Abstention and citation behaviour therefore could not be observed. The notes say the local LLM runs on CPU only [doc `747e939e`].

## 5. Operational limits and risks (documented)

- **Single host, single owner:** PostgreSQL, app, processor, Ollama and Whisper share a Docker host. A runaway media cache once filled the root filesystem and crashed PostgreSQL (May 2026) [doc `747e939e`].
- **Credential hygiene:** a database password "leaked to exporter logs" and its rotation was listed as open (July 2026) [doc `747e939e`]. Current status is unknown.
- **Library quality:** placeholder stubs from Obsidian wikilinks; duplicates (53 removed in June); 62 corrupted pages repaired; titles such as "## Architecture" and "proposal_event_id: $…"; agent-written index pages that repeat the same section many times [docs `9a910a27`, `0433a912`, `04220f12`].
- **No automated test framework** for the app, by its own account [doc `b12ea649`].
- **Known open privacy items:** visibility may be lost on reprocess, and private documents may be created without a token. These are listed as "decisions pending" [doc `b12ea649`].
- **Very large documents** (1.4M characters) freeze the reader UI [doc `9a910a27`].

## 6. Questions for the source operator (needed before migration)

1. Does `doc_count` include private documents? How many private documents are there, and in which projects?
2. Embedding column type and dimension. Is there one embedding per chunk, and what is the chunking rule?
3. Is there a tested backup? Where is it, how often does it run, and when was the last restore test?
4. Are original uploaded files kept? Where are they, and do they link to their documents?
5. Ownership of `cinema/*`, `highlandquant*`, `side_hustle`, `keledones*` and `work`: is each personal, the company's, or a former client's or employer's?
6. Licence status of the third-party corpora if any are to be reused in company tools.
7. Is the database password rotation done? Is the read endpoint still open on the LAN, and is the MCP endpoint reachable from the internet through the tunnel?
8. Should the claude.ai connector keep its write and delete tools? A read-only connector for coding sessions would remove an accidental-deletion path. This is a recommended change to Babel itself, outside Shingon's scope.
