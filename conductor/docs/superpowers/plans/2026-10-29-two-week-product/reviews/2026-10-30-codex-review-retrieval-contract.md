# Codex review: retrieval contract and v1 fixtures

Date: 30 October 2026. Reviewer: Codex. Implementation/contract owner: Claude.
Baseline: `8c63636` (PR #23 merged); the fixture proposal arrived in PR #17.
Scope: retrieval-contract.md, all 18 wire fixtures, contract.py, and K2 source semantics
needed to answer section10. The wider P06 options/pricing research is not signed off here.

**Disposition: four design questions answered; changes requested before v1 freeze/K6
admission.** The read-only, scoped, cited-passage design is sound. The current draft still
has ambiguous identities, incomplete endpoint fixtures and unsafe validator/metadata gaps.
Claude has concrete decisions below for the contract-correction task. This review does not
claim that K6's contract-accepted dependency is satisfied until corrected contract, fixtures
and validator pins are reviewed. No live infrastructure or user decision is required for
these corrections.

> Follow-up: [PR31/34 re-review](2026-10-30-codex-review-kb-corrections.md) closes KB-R1/R2 and the demonstrated KB-R3 disclosure. KB-R4 and remaining design gates still hold v1/K6; the retained pure control now uses corrected helpers and exits 0.

## Decisions on section10's four questions

### 1. Identifiers: opaque chunks and collection-qualified document identity

Accept replacing deployment-wide serial chunk IDs before exposing them over HTTP. Use
persisted unguessable opaque IDs (at least 128 bits of randomness), stable for the lifetime
of that chunk version, bound to the authenticated tenant. A tenant-local counter is still a
counter: principals within one tenant can have different ACLs. Lookup must re-authorise the
chunk/document; opacity never replaces ACL checks.

Keep source-key document IDs for minimal K2 migration, but the identity is the structured
`(collectionId, documentId, versionId)` tuple. `documentId@versionId` alone is insufficient.
K6's canonical original route should be:

```text
GET /collections/:collectionId/documents/:documentId/versions/:versionId/original
```

Encode the document ID as one URL component, decode once, and map it through authorised
metadata rather than joining it onto a filesystem path. Citations, passage expansion and
original lookup all retain collection identity. Return the same 404 for a missing,
unauthorised, revoked or unavailable version. Opaque document IDs are also a valid future
choice; do not ship the current ambiguous route while retaining collection-local source keys.

Also reconcile `indexGeneration` and collection counts with the stated no-cross-ACL-counts
rule. K2's tenant-wide numeric generation changes for hidden documents too. Keep internal
invalidation counters private; define an authorisation-view revision on the wire (or another
reviewed view-scoped representation), with matching fixtures. Do not expose a deployment-wide
or tenant-wide ingestion count as if all users can see its underlying events. A random alias
of a tenant counter does not by itself prove hidden changes are unobservable.

### 2. Failed sync: remove from every read path, do not serve as stale

Accept Claude's conservative proposal. A failed source read/parse/permission refresh must
remove that source from search and passage expansion and make original access unavailable.
K2's failed status already removes chunks and its original query requires active status.

Narrow `stale` to a newer source version known to exist while authorisation of the older
indexed version is still valid. It must not excuse uncertain permissions, failed refresh,
revocation or deletion. Keep this authored until a connector can establish those conditions.
A permission failure must never become a stale successful result.

Explicitly distinguish an authoritative empty collection listing from a failed or partial
listing. Current `sync()` only checks for removed sources in collections present in the
new source list (`service.py:101-116`); an empty list supplies no collection to inspect.
Require collection-scoped authoritative sync input, including zero documents, and an
integration regression deleting the last document. Never interpret an upstream failure as
an authoritative empty listing. This is a source-read dependency, not a locally executed
PostgreSQL deletion test.

### 3. Originals: current version only in v1

Choose the minimal current-version-only contract. Retaining older bytes for operational
recovery does not make them retrievable. An old, nonexistent or no-longer-authorised version
returns the same 404; never silently substitute the latest bytes. Citations retain the
version even when its original is no longer available.

The current `KnowledgeService.original(cred, collection, key)` has no version argument.
The fixture helper `_original(..., version)` uses `version` only in the URL; it calls the
core without it. Existing original fixtures are negative cases, so they do not prove that
an old requested version is refused. K6 must check the requested version atomically with
current source status/ACL before serving the current original. Add a positive current-file
fixture (attachment/status/type) and old-version/wrong-version/refreshed-version negatives.
If download tickets are used, define their successful response shape and expiry/reuse rules,
and re-authorise at byte delivery; a retained ticket cannot outlive a revocation.

### 4. Destination-withheld report: accept the shape for the operator only

Accept the proposed six keys as an **internal operator report**:
`type`, `participant`, `collectionId`, `documentIds`, `allowedDestinations`, `message`.
Require `type: evidence-withheld`; a registered participant ID; the exact collection/document
IDs actually withheld; an allow-list containing only the defined destination names (or a
validated `foundation-app:<registered-appId>`); and fixed actionable message templates.
Do not include excerpts, source contents, credentials or prompt text.

This detailed report is for the authorised operator's UI/transcript. It is not evidence to
send to the denied participant. A participant may get a generic explanation with no restricted
document IDs, titles or excerpts. Every vendor planning/review/fallback hop must reapply the
destination rule, including onward forwarding and retries. K8 owns those implementation tests.

Destination policy must be current when prompt evidence is assembled. Define an atomic
policy snapshot or explicit revalidation protocol, including failure handling, rather than
relying on a possibly stale `/collections` cache. Treat destination changes as invalidating
cached policy/evidence. K2's `setup()` updates destinations without `_bump()`; its raw generation
therefore cannot be used as the sole policy-freshness proof. K6/K8 must close that source-read
integration gap before any restricted evidence can be sent.

## Findings to correct before freezing

### KB-R1 — [P2] Distinct documents map to the same original URL

Location: retrieval-contract.md sections3/10; `001_initial.sql:41`;
`service.py:255`; `test_contract_fixtures.py`, `_original`.

Trigger: one tenant has `policies/current.md` in collections `team-a` and `team-b`, both at
version1. The schema permits this because uniqueness is `(collection_id, key)`. Each result
has the same documentId and versionId. The documented original URL omits collectionId.

Consequence: a consumer cannot uniquely identify which document/version it is fetching; the
contract cannot implement exact citations and lookup unambiguously. This review does not
claim an existing HTTP cross-ACL leak: there is no HTTP implementation yet.

Reproduced by mapping two checker-accepted results into the documented URL; both produce
`/documents/policies%2Fcurrent.md/versions/1/original`. Apply decision1 and add a two-collection
fixture plus cross-collection refusal checks.

### KB-R2 — [P2] The wire checker accepts invalid JSON numbers and invalid semantic values

Location: `contract.py:113-169,172-200`.

The checker accepts `NaN` and `Infinity` scores because Python's default `json.dumps` permits
non-standard numeric literals and numeric type checks do not require finiteness. A strict
JSON serializer may fail after validation; a permissive serializer emits a body a browser
cannot parse as JSON. It also accepts `2026-99-99T99:99:99Z`, version0, negative retryAfter,
and unknown destination names. All six cases reproduce against the real checker.

Require strict JSON serialisability (`allow_nan=False` or equivalent), finite numeric scores,
real UTC date/time validation, positive version/page/slide numbers and nonnegative bounded
retry delays, plus the destination vocabulary. Normalize malformed type/container/encoding
errors to ContractError at the wire boundary. Keep semantic consistency rules distinct from
merely checking key presence. Add regression negatives rather than weakening the good fixtures.

### KB-R3 — [P1] A visible hit can disclose an unauthorised superseding-document identifier

Location: `service.py:243-258`; `contract.py:49-54`; retrieval-contract.md section3.

The candidate SQL filters the hit's ACL but selects `s.superseded_by` as arbitrary stored
source metadata. The result and wire projections return that string without checking the
target document's ACL. A public old policy can therefore name a hidden successor. The same
rule must apply to future conflictsWith references, collection metadata/counts and neighbours.

An injected authorised candidate carrying synthetic `private/acquisition-plan.docx` reaches
actual KnowledgeService.search and search_body and passes check_search_body unchanged. This
is a source/interface reproduction; no PostgreSQL query or actual private corpus was used.
The missing target-authorisation step is visible in the SQL/projection source. Require a
real two-principal database regression before claiming this privacy guarantee implemented.

Suppress the hidden identifier while preserving conservative supersession demotion internally.
Do not fetch/rerank/excerpt the hidden target to decide what a caller sees. Apply target ACL
checks to references before constructing response metadata; key-only links also need the
collection identity from decision1.

### KB-R4 — [P2] The fixture set does not yet define the complete v1 dispatch surface

Location: retrieval-contract.md sections3/4/10; contract.py ERRORS; fixture generation.

Search response and negative original fixtures are useful, but collections, passage expansion,
health and positive original delivery have no wire fixtures. Authentication/413 errors and
search request validation are not in the current checker. The prose says clientRequestId is
a UUID, while generated examples use `req-hit-docx` and other non-UUID IDs. Mode and filters
are described but K2 only implements keyword search and collection narrowing.

Before freeze, specify and fixture every exposed K6 route, bounded neighbour expansion,
positive delivery, 401/413/429/503, bad request types (including boolean limits), scope and
unsupported mode/filter behaviour. Pick one request-ID format and use it in prose, fixtures
and validators. An opaque bounded request ID is acceptable; it need not be a UUID. Refuse
unsupported hybrid/filter requests explicitly until implemented; never silently run a broader
keyword query or ignore a requested document filter. Unsupported endpoints should remain
unexposed rather than shipping an invented successful response.

## Verification

Baseline source/fixture checks used an isolated Windows Python3.14.2 venv with the exact
`knowledge/requirements.lock` pins and editable `knowledge` install (no dependency edits).
There is no local PostgreSQL tool on PATH and TEST_DATABASE_URL is unset. No database or
worker service was started to manufacture an integration result.

From knowledge/, with that venv:

```text
python -m unittest discover -s tests -v
Ran 4 tests: OK; 3 database-backed classes skipped (TEST_DATABASE_URL unset).
```

The four pure tests include the committed near-miss/error checks and credential-content
refusal controls. The skipped classes are ContractFixtures, PermissionsSyncDeletion and
Retrieval. Their live SQL/generated-fixture/permission sweeps are **not locally rerun**.

[Standalone review controls](fixtures/kb-contract-review.py), from repository root with the
installed knowledge package:

```text
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-contract-review.py
```

- All **18 committed fixture bodies** pass their declared shape check: 13 labelled generated,
  five authored. This validates committed bodies, not regeneration from a database.
- Six malformed semantic/JSON cases are accepted unexpectedly.
- Two collection-local source identities collide at the documented original URL.
- The injected authorised-candidate projection retains the unchecked supersededBy identifier.
- Expected exit **1** records these eight counterexamples, outside CI discovery.

No code in knowledge/, no Claude-owned contract document, no dependency/CI/gate was edited.
No HTTP/MCP runtime, connector, hybrid/reranker/model, Babel/private data, deployment or live
revocation propagation was exercised. Protocol-version claims in section9 belong to K7's
separate pinned-spec/SDK verification; this focused review does not certify them.

## Handoff and exit condition

Claude owns the minimal contract/fixture/validator corrections. Split core privacy/sync fixes
into separately reviewable changes if needed, with their database regressions. Reconcile the
four decisions, add the missing route/request fixtures, and submit exact pins for Codex
re-review. Freeze v1 only after those corrections and both-lane acceptance are recorded.
The K6 HTTP implementation remains gated on that freeze; the correction work itself is
unblocked. K3/K4/K5/K7/K8, company ingestion and Babel migration are not prerequisites for
correcting and freezing a truthful keyword-only read contract.

Codex's next independent task after this review submission merges is P04 operator-UI review,
including the merged N6 recovery control, followed by the remaining P06/P09 research reviews.
