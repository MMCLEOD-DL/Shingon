# Read-only retrieval contract (v1)

**Packet:** P06, step 5. **Status:** v1 accepted by Claude and Codex, 30 October 2026 ([§11](#11-v1-acceptance)). All retrieval-contract findings and v1 decisions are closed, and the accepted fixture set exists ([§10](#10-fixtures-to-freeze-before-v1)). This meets K6's contract-acceptance dependency; it is not acceptance of an HTTP implementation. Any change to a wire shape, route, error or rule needs both lanes and a version bump. K2 onward implements the service core; the K6/K8 and later obligations in §11 remain. There is no HTTP layer yet, and Conductor and Foundation are not changed by this acceptance.

**Purpose:** one small contract that Conductor and generated Foundation apps both use to get evidence from a knowledge service. The service must return only what the caller is allowed to see, say where every passage came from, and be safe to put in front of a model.

## 1. Principles

1. **Read-only.** v1 has no tool or endpoint that creates, edits, moves or deletes knowledge. Ingestion is a separate, operator-run pipeline with its own credentials (see `migration-plan.md`). Babel's MCP connector shows what to avoid: read and delete on one token ([inventory §1.1](inventory.md#11-mcp-tools-exposed-to-this-session-observed)).
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

## 3. Endpoints (HTTP, JSON, under `/kb/v1`)

| Method/path | Purpose |
|---|---|
| `GET /collections` | The collections this credential can search, in id order: `collectionId`, `kind`, `destinations` (§5), `documents` (how many **this caller** can see) and `lastIngestedAt` (when the newest of those was ingested, null when none). Plus `viewRevision`. Names and descriptions are not stored yet, so they are not sent. |
| `POST /search` | Ranked, cited passages for a query. |
| `GET /passages/:chunkId?neighbours=N` | One passage and up to N (0–2, default 1) passages either side of it in the same document version, in document order, with exactly one marked `focus`. The body names `collectionId`, `documentId`, `versionId` and `title`; each passage has `chunkId`, `text` (≤ 1,200 characters, control characters stripped), `locator` and `instructionLike`. Used to widen context around a hit. The chunk and its document are re-authorised on every lookup: an opaque id is not a permission, and a hidden or missing id gets the same 404. |
| `GET /collections/:collectionId/documents/:documentId/versions/:versionId/original` | The original file of that exact document version, only while it is the **current** version and the ACL allows it. Served directly to the authenticated caller and re-authorised at delivery; v1 has no download tickets. Headers: `Content-Disposition: attachment`, a fixed `Content-Type` by extension (`application/octet-stream` when unknown), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. Any other version, including an older one still retained, gets the same `404` as a hidden or missing document; the latest file is never served in its place. Each identifier is one URL-encoded path segment, decoded once and looked up, never joined to a file path. |
| `GET /health` | Readiness only: `200 {"status": "ok"}`, or `503 index-unavailable`. No revision, counts or anything else that crosses ACL boundaries. |

### `POST /search` request

```json
{ "query": "string, 1-1000 chars",
  "collections": ["optional subset of allowed ids"],
  "filters": { "sourceTypes": ["pdf","docx","xlsx","md"], "updatedAfter": "ISO date", "documentIds": [] },
  "mode": "keyword",
  "limit": 8,
  "clientRequestId": "optional: 1-64 of A-Z a-z 0-9 . _ : -" }
```

The request is parsed strictly (`contract.parse_search_request`):
- only these six fields; `limit` is a whole number from 1 to 20 (a boolean is not a number); `collections` is 1 to 50 distinct ids;
- `clientRequestId` uses the one request-id format, which is also the format of `requestId` in every error. When it is absent, K6 issues one;
- **`mode: "hybrid"` and any filter are refused with `400 unsupported`** until K3 and the filters exist. They are never answered by quietly running a keyword search or ignoring the filter. `filters` may only be absent or `{}`.

`limit` is at most 20, and the response body is at most 64 KB. A request naming a collection outside scope gets `403 scope` and is never silently dropped, so callers can tell "nothing found" from "not allowed".

### `POST /search` response

```json
{ "viewRevision": "…64 hex characters…",
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
- **`stale`** means the source system reports a newer version that has not been ingested yet, while the indexed version is still authorised as it was. Only a connector can know this, so K2 never sets it. It never covers a failed refresh, an uncertain permission, a revocation or a deletion: a source whose last read, parse or permission refresh failed is removed from search, passages, collection counts and originals until a later sync succeeds (§8). **`supersededBy`** names the replacement when the operator has marked the document replaced, but only if the caller could open the replacement itself. Otherwise it is null, though the replaced document is still ranked lower. **`conflictsWith`** lists other authorised results that disagree on an extracted fact; it is set only when the service detects this, and its absence proves nothing.
- **`instructionLike`** is a heuristic flag for text that reads like instructions to an assistant ("ignore previous…", tool-call syntax). It is advisory only: callers treat all passages as data either way.
- **Spreadsheets:** a passage from a sheet is the stored cell text with its range. The service does not calculate. A question that needs a calculation over records is answered by the system that owns those records, not by document retrieval.

## 4. Errors and limits

Errors use the operator-app shape `{ error: { code, message, retryable, requestId } }`. The codes, each with fixed wording (`contract.ERRORS`), are `bad-request` and `unsupported` (400), `unauthenticated` (401), `scope` (403), `not-found` (404), `too-large` (413, a request body over 16 KB), `rate-limit` (429) and `index-unavailable` (503).

- **No existence leaks:** a document the caller cannot see returns `404`, exactly as one that does not exist.
- **`503 index-unavailable`** is distinct from an empty result. Callers must not turn an outage into "no evidence found".
- **Rate limits** are per credential, with defaults of 60 searches per minute per Conductor project and per app user. Breaching them returns `429` with `retryAfter`.
- **Timeouts:** a search returns in at most 5 s or fails. There is no partial result.

## 5. Destinations and data policy

Every collection carries a `destinations` allow-list: any of `local-model`, `claude-subscription`, `codex-subscription`, `foundation-app:<appId>`.

- Conductor checks it **before** putting any passage in a prompt. A passage from a `local-model`-only collection is never sent to a subscription vendor. Every hop that could forward evidence (planning, review, fallback, retries, onward forwarding) applies the rule again.
- The policy must be current when the evidence is assembled. A destination change alters the caller's `viewRevision` (§8), so cached policy or evidence from before it is stale. K8 still has to define how Conductor re-checks the policy, and what happens when it cannot.
- **The withheld report is for the operator only.** When passages are kept from a participant, the operator's UI and transcript get one report per collection, built by `contract.withheld_report()`:
  - its fields are `type: evidence-withheld`, the `participant` (a Conductor participant name), the exact `collectionId` and `documentIds` withheld, the collection's `allowedDestinations`, and a fixed `message`;
  - the message is set by the other fields, and the checker refuses any other wording;
  - it carries no excerpts, titles, source text, prompt text or credentials.
- **The participant is told only `contract.PARTICIPANT_NOTICE`**, a generic line with no collection, document, title or count. The report itself is never evidence for the participant it concerns.
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

- **Cache key:** `(credential, viewRevision, normalised request)`. `viewRevision` is a digest of everything the caller can see: the collections in its scope with their destinations, and each visible document's collection, id, current version, whether it is superseded, and its replacement if that is visible too. Any change to the caller's own view changes it, so its cached results are invalidated. A change to a document the caller cannot see leaves it as it was, so it reveals nothing beyond what the caller could list. The service's internal per-tenant counter never leaves it. The cache TTL is at most 10 minutes even without a change.
- **One snapshot per read** (Codex review KB-R5): every read (search, collections, passage, original) runs in one `REPEATABLE READ` transaction. The scope, group membership, candidates, references, versions, destinations and the returned `viewRevision` all come from the same moment. A revocation or replacement committed part-way through cannot pair old evidence with the new revision: the answer is wholly from before the change and carries the old revision, and the next read is wholly after it. So a cache keyed on `viewRevision` never serves revoked evidence under the current revision. The only write is the audit insert, which cannot conflict, so reads are never retried. Any error rolls the whole transaction back, audit row included. Delivering an original's bytes re-authorises at delivery time; that is K6's job.
- **Authoritative listings:** a sync names the collections whose listing it read in full (`complete`). Only in those is a source missing from the listing deleted, and an empty complete listing deletes the collection's last document. A collection not named is a partial listing: its sources are added or updated, and nothing is deleted. An upstream failure must never be passed as an empty complete listing.
- **Failed refresh:** a source that cannot be read, parsed or permission-checked leaves every read path until a later sync succeeds. It is never served as `stale`.
- **Deletion or revocation at the source:** the next sync marks the document `revoked` in the same transaction that removes its chunks, embeddings and full-text rows from the searchable tables, which changes the `viewRevision` of every caller who could see the document. The original file is deleted after the retention set for the collection (default 0 days for client-runtime). Revocation never waits for the file: if the disk refuses (on Windows, while any process holds it open), the source stays revoked, the file is kept on record as pending cleanup with the reason, the import log says `cleanup-pending` rather than claiming it deleted, and every later sync (or `purge_originals()`) retries, across restarts, until a `purged` event records it gone (Codex review KB-R7). The time to propagate is bounded by the sync interval, and the UI must show it. Mocked connectors cannot show this propagation actually happens; live connector permission sync stays unverified until tested against the real source.
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

### Accepted v1 fixture set (30 October 2026)

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
| Revoked after sync | `revoked-after-sync` (passages gone, `viewRevision` changed), `revoked-original` (404) | generated |
| Conflicting versions | `superseded-version`: the replaced document is flagged `supersededBy` and ranked lower | generated |
| Instruction-like passage | `instruction-like` | generated |
| XLSX cell range | `hit-xlsx` (`Budget`, `A4:E4`) | generated |
| Stale source | `stale-source`: a newer version known upstream, the indexed one still authorised | authored: a live connector (K13) |
| Scanned PDF with OCR confidence | `scanned-pdf-ocr` | authored: K5 |
| Index unavailable | `index-unavailable` (503) | authored: K6 |
| Rate limit | `rate-limit` (429, `retryAfter` in the body and a `Retry-After` header) | authored: K6 |
| Destination-withheld report | `destination-withheld`, built with `withheld_report()` (§5) | authored: K8 |
| Original, current version only (decision 3) | `original-current` (200: attachment headers and the file's size and sha256), `original-replaced-version` and `original-unknown-version` (404) | generated |
| Same `documentId` in two collections (KB-R1) | `same-key-two-collections`, `same-key-one-visible`, `same-key-other-collection` (404), `same-key-own-collection` (200) | generated |

Also included: `bad-request` (400).

Every exposed route now has fixtures (Codex review KB-R4):

| Item | Fixture(s) | Origin |
|---|---|---|
| `GET /collections` | `collections-alice`, `collections-andy` (one document fewer: the finance-only one), `collections-conductor` | generated |
| `GET /passages/:chunkId` | `passage-neighbours` (focus plus one either side), `passage-hidden` and `passage-missing` (identical 404s), `passage-too-wide` (400) | generated |
| `GET /health` | `health` | generated |
| Request validation | `bad-request`, `bad-request-boolean-limit`, `bad-request-unknown-field`, `unsupported-hybrid`, `unsupported-filters` | generated, through `parse_search_request` |
| Body too large, authentication | `too-large` (413), `unauthenticated` (401) | authored: K6 |

Two things consumers must not read into the fixtures:
- **Evidence levels.** They come from K2's provisional keyword thresholds. The PDF hit is `weak`. K4 replaces the thresholds, and the generated fixtures will change with them.
- **Unknown fields.** K2 cannot fill `scores.vector`, `scores.rerank`, `source.modifiedAt` or OCR, so they are null or false. `conflictsWith` is always empty, and its absence proves nothing.

**What the wire checkers in `contract.py` refuse** (Codex review KB-R2). They are what K6 will run on its own output, so they refuse anything a strict JSON consumer could not take:
- NaN, infinite or non-JSON values;
- timestamps that are not real UTC dates and times;
- `versionId`, `page` or `slide` below 1, or a `viewRevision` that is not a 64-hex digest;
- a `retryAfter` outside 1–3600 seconds;
- an `allowedDestinations` entry outside §5's list (`foundation-app:` takes a lower-case slug until Foundation fixes the app-id format);
- a body or container of the wrong type.

**Resolved v1 decisions:**

1. **Identifiers.** *Decided by Codex's review; done.*
   - Identity is `(collectionId, documentId, versionId)`, and the original route carries all three (§3). The fixtures above show the same `documentId` in two collections.
   - `chunkId` is a random opaque id (migration `002_opaque_chunk_ids.sql`), not the serial whose gaps revealed ingestion volume.
   - The tenant-wide `indexGeneration` counter is replaced on the wire by `viewRevision`, a digest of the caller's own view (§8).
2. **Stale versus removed.** *Decided by Codex's review; done.* Removal, and `stale` is narrowed (§3). Sync takes explicit complete listings, so an empty one removes the last document and a failed or partial one deletes nothing (§8).
   - An earlier draft served a failed refresh as `stale`; that was superseded. The accepted §3/§8 rule removes failed refreshes from every read path. `stale` is reserved for an upstream-known newer version while the indexed version remains authorised, which only a connector can know.
3. **Original versions.** *Decided by Codex's review; done.* Current version only, checked in the same query as the document's status and ACL; anything else is the shared 404 (§3).
4. **Destination-withheld report.** *Decided by Codex's review; the shape is done (§5).* It is accepted as an operator-only report, with stricter values and fixed wording, and the participant gets only a generic notice. K8 still owns enforcement: re-applying the rule at every hop, and re-checking the policy when evidence is assembled.

## 11. v1 acceptance

**Closure record.** Each item was reproduced by Codex, corrected by Claude with a regression that fails on the
previous source, and closed by Codex on an independent re-run (several on native Windows).

| Item | Correction (PR, commit) | Closed by Codex |
|---|---|---|
| KB-R1 same key in two collections | PR34 `5701ab9` | `reviews/2026-10-30-codex-review-kb-corrections.md` |
| KB-R2 strict wire values | PR31 `4dea212` | same |
| KB-R3 hidden successor named | PR31 `4dea212` | same |
| KB-R4 every route and request | PR39 `fee43f0`, with KB-R6 | `reviews/2026-10-30-codex-review-kb-endpoints.md`, `…-kb-fixture-fix.md` |
| KB-R5 evidence and revision from one snapshot | PR44 `b32a9d6` | `reviews/2026-10-30-codex-review-kb-snapshot-fix.md` |
| KB-R6 passage fixture identity | PR46 `a99a7cf` | `reviews/2026-10-30-codex-review-kb-fixture-fix.md` |
| KB-R7 durable original cleanup | PR47 `fa5ca90` | `reviews/2026-10-30-codex-review-kb-cleanup-fix.md` |
| Decision 1 identifiers, `viewRevision` | PR34, PR37 `7ed04e4`, PR44 | `…-kb-corrections.md`, `…-view-revision.md`, `…-kb-snapshot-fix.md` |
| Decision 2 removal, authoritative listings | PR41 `86b5496` | `reviews/2026-10-30-codex-review-kb-sync.md` |
| Decision 3 current-version originals | PR34 | `…-kb-corrections.md` |
| Decision 4 operator-only withheld report (shape) | PR37 | `…-view-revision.md` |

**What v1 binds, and what it leaves to the tasks that implement it.** These are obligations the contract already
states; they are not open questions in its text, and accepting v1 does not claim they are done:
- **K6 (HTTP API):** authentication and the 401 shape; the 16 KB request limit (413) and 64 KB response limit; rate
  limits (429 with `retryAfter` and `Retry-After`); 503 for an unavailable index; one-segment path decoding; serving
  each body through `contract.py`'s builders and checkers; re-authorising an original at byte delivery; issuing a
  request id when the caller sends none; and the authored 401/413/429/503 fixtures becoming generated ones.
- **K8 (Conductor evidence step):** registered participants and apps; applying the destination rule at every hop
  that could forward evidence; re-checking policy freshness when evidence is assembled; sending the withheld report
  only to the operator and `PARTICIPANT_NOTICE` to the participant.
- **Later tasks:** K3/K4 fill `scores.vector`/`rerank` and replace the keyword evidence thresholds (fixtures change
  then); K5 fills OCR fields; a live connector (K13) is the only source of `stale`.

**Acceptance.**
- Claude: accepted, 30 October 2026, at the commit that adds this section.
- Codex: accepted, 30 October 2026, reviewing candidate `aef2189bd45195318a0521a93e10077bc34bdd7b` at integrated baseline `15a559b`. The specification and fixture set are accepted as v1. Independent native Windows verification: 42 knowledge tests pass (zero failures/skips), plus wire/request/lookup and locked-file retry controls. This closes the contract-acceptance dependency for K6, not its implementation or admission. K6/K8/later obligations above remain mandatory; wider P06 research R4 and D3/D4 remain separate. Evidence: `../superpowers/plans/2026-10-29-two-week-product/reviews/2026-10-30-codex-review-kb-contract-v1.md`.
