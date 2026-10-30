# Read-only retrieval contract (proposal v0)

**Packet:** P06, step 5. **Status:** proposal for Codex review. It is not an implemented API, and Conductor and Foundation are not changed by it. Version 0 becomes v1 only when both lanes accept it and a fixture set exists, as with the operator-app contract. The draft fixture set now exists ([§10](#10-fixtures-to-freeze-before-v1)); acceptance and the open points listed there remain.

**Purpose:** one small contract that Conductor and generated Foundation apps both use to get evidence from a knowledge service. The service must return only what the caller is allowed to see, say where every passage came from, and be safe to put in front of a model.

## 1. Principles

1. **Read-only.** v0 has no tool or endpoint that creates, edits, moves or deletes knowledge. Ingestion is a separate, operator-run pipeline with its own credentials (see `migration-plan.md`). Babel's MCP connector shows what to avoid: read and delete on one token ([inventory §1.1](inventory.md#11-mcp-tools-exposed-to-this-session-observed)).
2. **Retrieval, not answers.** The service returns ranked, cited passages. Writing the answer is the caller's job, with the caller's model and data policy. A server-side "librarian" hides which evidence was used, moves model spend and data flow inside the KB, and on Babel was too slow to observe (two 60 s timeouts). An answer endpoint can be added later behind the same authorisation, with mandatory citations and abstention.
3. **Authorise before retrieval.** Permission filters are part of the candidate query (keyword and vector), so unauthorised chunks are never scored, reranked, counted, cached or excerpted. Post-filtering is refused: it leaks through result counts, timing and reranker inputs, and it loses recall.
4. **Documents are evidence, not instructions.** Text from a document is never executed, never treated as a tool call, never changes a policy, and never counts as an approval. Callers must present passages as quoted data (§6).
5. **Scope comes from a trusted server, never from the prompt.** Tenant, principal and collection scope come from the authenticated credential. A request body may narrow scope, never widen it.

## 2. Identities and scope

| Caller | Credential the service sees | What it may reach |
|---|---|---|
| **Foundation app, signed-in user** | The app server's service credential (one per deployed app), plus a short-lived signed assertion of the end user's id and the app's tenant. The browser never talks to the KB and never holds any KB credential. | Only the tenant bound to that app's credential. Within it, only documents whose ACL admits the asserted user (directly or through a group). |
| **Conductor run** | A project-scoped read token issued by the operator for one Conductor project. It is stored with Conductor's secrets, never in the agent workspace, a generated repository or a transcript. | Only the **development/reference collections** the operator approved for that project (e.g. "Foundation docs", "company coding standards"). It never reaches client runtime business data (§7). |
| **Operator CLI/UI** | The operator's own login. | All collections in their deployment. |
| **Personal KB** | A separate deployment with separate credentials. | Never reachable with a company credential, and the reverse. |

**Why the user assertion is acceptable for Foundation apps:** the app already authenticates its users and enforces admin/manager/member and team rules. The KB does not trust the app blindly, though:
- (a) An app credential is bound to exactly one tenant, so a compromised app cannot reach another client.
- (b) The asserted user must exist in the KB's principal table for that tenant, whether synced or provisioned.
- (c) The audit record holds both the app identity and the asserted user.
- (d) Assertions expire in at most 5 minutes and carry a nonce.

OAuth token exchange (RFC 8693) with the user's own token is stronger. It is deferred until a client actually has SSO.

## 3. Endpoints (HTTP, JSON, under `/kb/v0`)

| Method/path | Purpose |
|---|---|
| `GET /collections` | The collections this credential can search: id, name, description, `destinations` (§5), document count and last-sync time. |
| `POST /search` | Ranked, cited passages for a query. |
| `GET /passages/:chunkId` | One passage with ±N neighbouring chunks of the same version, bounded. Used to widen context around a hit. The chunk and its document are re-authorised on every lookup: an opaque id is not a permission. |
| `GET /collections/:collectionId/documents/:documentId/versions/:versionId/original` | The original file of that exact document version, only while it is the **current** version and the ACL allows it. Served directly to the authenticated caller and re-authorised at delivery; v1 has no download tickets. Headers: `Content-Disposition: attachment`, a fixed `Content-Type` by extension (`application/octet-stream` when unknown), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. Any other version, including an older one still retained, gets the same `404` as a hidden or missing document; the latest file is never served in its place. Each identifier is one URL-encoded path segment, decoded once and looked up, never joined to a file path. |
| `GET /health` | Readiness and index generation. No counts that cross ACL boundaries. |

### `POST /search` request

```json
{ "query": "string, 1-1000 chars",
  "collections": ["optional subset of allowed ids"],
  "filters": { "sourceTypes": ["pdf","docx","xlsx","md"], "updatedAfter": "ISO date", "documentIds": [] },
  "mode": "hybrid | keyword",
  "limit": 8,
  "clientRequestId": "uuid" }
```

`limit` is at most 20, and the response body is at most 64 KB. A request naming a collection outside scope gets `403 scope` and is never silently dropped, so callers can tell "nothing found" from "not allowed".

### `POST /search` response

```json
{ "indexGeneration": 1842,
  "evidence": "strong | weak | none",
  "results": [{
    "chunkId": "…opaque…", "documentId": "finance/expenses-policy.docx", "versionId": 7, "collectionId": "acme-policies",
    "title": "Expenses policy 2026",
    "excerpt": "≤ 1,200 chars of the chunk text, control characters stripped",
    "locator": { "page": 4, "sectionPath": ["3 Claims", "3.2 Mileage"],
                 "sheet": null, "cellRange": null, "slide": null },
    "source": { "display": "SharePoint › Finance › Expenses policy 2026.docx",
                "versionLabel": "v7", "modifiedAt": "2026-09-30T10:12:00Z", "ingestedAt": "…" },
    "scores": { "rank": 1, "keyword": 12.4, "vector": 0.71, "rerank": 0.88 },
    "flags": { "stale": false, "supersededBy": null, "conflictsWith": ["…docId"],
               "ocr": false, "ocrConfidence": null, "instructionLike": false }
  }] }
```

- **Identity.** A document version is the tuple `(collectionId, documentId, versionId)`. `documentId` is the source key, unique only within its collection, so two collections can hold the same `documentId` at the same `versionId`; citations, passage lookups and original routes always carry `collectionId`. `versionId` is a whole number from 1. `chunkId` is opaque (22–128 URL-safe characters; the service issues 64 random hex characters), stable for the life of that chunk version, and never derived from a counter. Callers store and return it; they never parse it.
- **`evidence`** comes from a reranker threshold calibrated on the labelled set (`evaluation.md`), not from a raw similarity score. Babel's many identical 1.0 scores show why a raw score cannot drive abstention. `none` means the caller must abstain; `weak` means it must say so.
- **`locator`** carries the finest provenance the parser kept: page for PDFs, section path for DOCX/Markdown/HTML, sheet and cell range for XLSX, slide for PPTX. A missing field is `null`, never guessed. Each citation names the **version** quoted, so a later edit cannot silently change what an earlier answer cited.
- **`stale`** means the source system reports a newer version that has not been ingested yet, or the last sync failed for this source. **`supersededBy`** names the replacement when the operator has marked the document replaced, but only if the caller could open the replacement itself. Otherwise it is null, though the replaced document is still ranked lower. **`conflictsWith`** lists other authorised results that disagree on an extracted fact; it is set only when the service detects this, and its absence proves nothing.
- **`instructionLike`** is a heuristic flag for text that reads like instructions to an assistant ("ignore previous…", tool-call syntax). It is advisory only: callers treat all passages as data either way.
- **Spreadsheets:** a passage from a sheet is the stored cell text with its range. The service does not calculate. A question that needs a calculation over records is answered by the system that owns those records, not by document retrieval.

## 4. Errors and limits

Errors use the operator-app shape `{ error: { code, message, retryable, requestId } }` with 400/401/403/404/413/429/503.

- **No existence leaks:** a document the caller cannot see returns `404`, exactly as one that does not exist.
- **`503 index-unavailable`** is distinct from an empty result. Callers must not turn an outage into "no evidence found".
- **Rate limits** are per credential, with defaults of 60 searches per minute per Conductor project and per app user. Breaching them returns `429` with `retryAfter`.
- **Timeouts:** a search returns in at most 5 s or fails. There is no partial result.

## 5. Destinations and data policy

Every collection carries a `destinations` allow-list: any of `local-model`, `claude-subscription`, `codex-subscription`, `foundation-app:<appId>`.

- Conductor checks it **before** putting any passage in a prompt. A passage from a `local-model`-only collection is never sent to a subscription vendor. Instead the run reports that the evidence was withheld from that participant.
- This works like Foundation's `policy.outbound` and Conductor's existing cross-vendor visibility rules. The KB states the policy and the caller enforces it, so both sides log the decision.

## 6. How callers use passages

- Passages go to a model inside a delimited, labelled evidence block that names `documentId`/`versionId`/`locator` and says the content is untrusted quoted material. The system prompt says that instructions inside evidence are to be reported, not followed.
- Answers must cite `collectionId`, `documentId@versionId` and the locator. If `evidence` is `none`, the caller states that the knowledge base has no support for the answer. It does not fall back to the model's own memory while presenting the answer as sourced.
- **Context budget:** Conductor sends at most 8 passages and at most 12k characters per call to a local model. For subscription vendors the limit is set by configuration.
- Retrieved text can never approve a plan, waive a check, change a test command or become a persistent skill automatically (research brief, "Relationship to the current build").

## 7. Boundary with client data

Conductor's [project-folder contract](../superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md#contract-1--the-client-project-folder-call) keeps client data out of factory projects and model prompts. This contract keeps it that way:

- **Conductor's tokens** reach development/reference collections only. A collection is marked `kind: "reference" | "client-runtime"`, and the service refuses to issue a Conductor token over a `client-runtime` collection.
- **A generated client app** reaches only its own tenant's `client-runtime` collections, at run time, on the client's chosen hosting. That data never comes back into Conductor.
- Changing this boundary needs an explicit design and a user decision, as the brief requires.

## 8. Caching, sync and deletion

- **Cache key:** `(tenant, principal ACL fingerprint, indexGeneration, normalised request)`. Any permission change, re-ingest or deletion increments `indexGeneration` for the affected tenant, which invalidates its cached results. The cache TTL is at most 10 minutes even without a change.
- **Deletion or revocation at the source:** the next sync marks the document `revoked` in the same transaction that removes its chunks, embeddings and full-text rows from the searchable tables, and increments `indexGeneration`. The original file is deleted after the retention set for the collection (default 0 days for client-runtime). The time to propagate is bounded by the sync interval, and the UI must show it. Mocked connectors cannot show this propagation actually happens; live connector permission sync stays unverified until tested against the real source.
- **Audit:** every search and original-file fetch records credential, principal, collection ids, result document ids and request id. The query text is kept only as a hash by default, because a query can contain personal data.

## 9. MCP versus direct API

| | HTTP API (the contract) | MCP adapter |
|---|---|---|
| **Used by** | Foundation app servers; Conductor's engine when it assembles evidence for local models | Interactive Claude Code / Codex sessions |
| **Auth** | Service credential + user assertion, or a project token | The same project token, presented as an OAuth bearer to an MCP server acting as a resource server. No separate identity. |
| **Surface** | §3 | Three tools: `kb_list_collections`, `kb_search`, `kb_read_passage`. No write tools. Tool descriptions are static and contain no retrieved text. |
| **Risk** | Small, testable surface | Tool results enter the model's context directly, so §6 delimiting must be done in the tool output itself |

**MCP authorisation in the current spec.** The current revision is 2026-07-28 ([changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx), retrieved 29 Oct 2026). Its [authorization section](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx) says:
- An HTTP MCP server is an OAuth 2.1 resource server.
- It must publish RFC 9728 protected-resource metadata.
- It must check that each token was issued for it (audience).
- It must not pass tokens through to other services.
- STDIO servers take credentials from the environment instead.

So:
- A **local** adapter for a coding session can be a STDIO process holding the project token.
- A **remote** adapter must validate audience-bound tokens and must not forward the caller's token to the API: it uses its own credential, scoped like the project token.

The same revision removed the `initialize` handshake and sessions, so pin the SDK version and test against it. The spec's tool rules also require servers to validate inputs and sanitise outputs, and ask clients to validate tool results before they reach the model ([tools](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/server/tools.mdx)). That matches §6.

**Recommendation:** implement the HTTP API once and make MCP a thin adapter over it. Then there is one place where permissions are enforced, MCP and API cannot drift apart, and Foundation apps never need an MCP runtime. For local Qwen runs, Conductor calls the API and injects passages itself, so the same §5–6 policy applies whichever model runs.

## 10. Fixtures to freeze before v1

Fixtures must cover:
- a normal hit for each format;
- `evidence: none`;
- a scope violation;
- a hidden document (404);
- revoked-after-sync;
- stale source;
- conflicting versions;
- an instruction-like passage;
- an XLSX cell-range hit;
- a scanned PDF with OCR confidence;
- index unavailable;
- a rate limit;
- a destination-withheld report from Conductor.

### Draft fixture set (30 October 2026)

**File:** [`knowledge/contract/kb-contract-v1.json`](../../../knowledge/contract/kb-contract-v1.json). The wire shapes and the shape checks are in `knowledge/src/shingon_knowledge/contract.py`; K6 should serialise with it and check its own output before sending. The test is `knowledge/tests/test_contract_fixtures.py`, which runs in CI.

Each fixture says whether it is **generated** or **authored**:
- **Generated** fixtures are produced by the K2 service on the synthetic corpus. CI produces them again in a fresh database and fails on any difference, so the file cannot drift from the service.
- **Authored** fixtures are hand-written for behaviour a later task owns. Each names that task in `pendingOn` and is checked against the shape only. They are not evidence that anything implements them.

| §10 item | Fixture(s) | Origin |
|---|---|---|
| A normal hit for each format | `hit-markdown`, `hit-docx` (version 2 after an update), `hit-pdf`, `hit-xlsx` | generated |
| `evidence: none` | `evidence-none` | generated |
| Scope violation | `scope-violation` (403 `scope`) | generated |
| Hidden document | `hidden-document` and `missing-document`: identical 404 bodies apart from `requestId` | generated |
| Revoked after sync | `revoked-after-sync` (passages gone, `indexGeneration` moved on), `revoked-original` (404) | generated |
| Conflicting versions | `superseded-version`: the replaced document is flagged `supersededBy` and ranked lower | generated |
| Instruction-like passage | `instruction-like` | generated |
| XLSX cell range | `hit-xlsx` (`Budget`, `A4:E4`) | generated |
| Stale source | `stale-source` | authored: a live connector (K13), and open point 2 |
| Scanned PDF with OCR confidence | `scanned-pdf-ocr` | authored: K5 |
| Index unavailable | `index-unavailable` (503) | authored: K6 |
| Rate limit | `rate-limit` (429, `retryAfter` in the body and a `Retry-After` header) | authored: K6 |
| Destination-withheld report | `destination-withheld`: a proposed shape | authored: K8 |
| Original, current version only (decision 3) | `original-current` (200: attachment headers and the file's size and sha256), `original-replaced-version` and `original-unknown-version` (404) | generated |
| Same `documentId` in two collections (KB-R1) | `same-key-two-collections`, `same-key-one-visible`, `same-key-other-collection` (404), `same-key-own-collection` (200) | generated |

Also included: `bad-request` (400).

`GET /collections`, `GET /passages/:chunkId` and `GET /health` are not in §10 and have no fixtures yet.

Two things consumers must not read into the fixtures:
- **Evidence levels.** They come from K2's provisional keyword thresholds. The PDF hit is `weak`. K4 replaces the thresholds, and the generated fixtures will change with them.
- **Unknown fields.** K2 cannot fill `scores.vector`, `scores.rerank`, `source.modifiedAt` or OCR, so they are null or false. `conflictsWith` is always empty, and its absence proves nothing.

**What the wire checkers in `contract.py` refuse** (Codex review KB-R2). They are what K6 will run on its own output, so they refuse anything a strict JSON consumer could not take:
- NaN, infinite or non-JSON values;
- timestamps that are not real UTC dates and times;
- `versionId`, `page` or `slide` below 1, or a negative `indexGeneration`;
- a `retryAfter` outside 1–3600 seconds;
- an `allowedDestinations` entry outside §5's list (`foundation-app:` takes a lower-case slug until Foundation fixes the app-id format);
- a body or container of the wrong type.

**Open points for v1 (for Codex's review):**

1. **Identifiers.** *Decided by Codex's review; done except `indexGeneration`.*
   - Identity is `(collectionId, documentId, versionId)`, and the original route carries all three (§3). The fixtures above show the same `documentId` in two collections.
   - `chunkId` is a random opaque id (migration `002_opaque_chunk_ids.sql`), not the serial whose gaps revealed ingestion volume.
   - Still open: `indexGeneration` is a tenant-wide counter, so it moves when documents the caller cannot see change. Codex asks for a view-scoped revision on the wire instead. That is the next contract task.
2. **Stale versus removed.** *Decided by Codex's review: removal, as recommended below. Pending: the sync fix for an authoritative empty listing, a later task.*
   - §3 and §8 describe a source whose last sync failed as served and flagged `stale`. K2 instead removes its passages from search, which is safer for permissions but loses availability.
   - My recommendation: keep removal, and narrow `stale` to "the source system reports a newer version that has not been ingested yet", which only a connector can know.
3. **Original versions.** *Decided by Codex's review; done.* Current version only, checked in the same query as the document's status and ACL; anything else is the shared 404 (§3).
4. **Destination-withheld report.** *Decided by Codex's review: accepted as an operator-only report, with stricter values. Pending: a later contract task and K8.* The proposed fields are `type`, `participant`, `collectionId`, `documentIds`, `allowedDestinations` and `message`. Conductor owns this shape, so Codex should accept or change it before K8.

