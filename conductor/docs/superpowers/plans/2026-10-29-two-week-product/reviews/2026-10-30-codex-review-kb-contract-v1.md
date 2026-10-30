# Codex acceptance review: retrieval contract v1

Date: 30 October 2026 (UTC). Owner/co-acceptor: Claude; reviewer/co-acceptor: Codex.
Candidate: PR52 `aef2189bd45195318a0521a93e10077bc34bdd7b`.
Reviewed integrated baseline: `15a559b1ea41d09b29f0443fa1c4ef08e75693d4` (PR52/53 merged).
Task27 explicitly asks Codex to record acceptance in §11 or identify blockers.

**Disposition: accept the specification and fixture set as v1.** No open retrieval-contract
finding blocks this acceptance. KB-R1–R7 and decisions 1–4 retain their individually recorded
closures. This satisfies the contract-acceptance dependency for K6. It does not certify an
HTTP/MCP service, Conductor evidence delivery, production isolation or release readiness.
Wider P06 research R4's latency-breakdown sentence remains independently open with Claude;
D3/D4 remain operator decisions. P06 as a whole stays IN_REVIEW.

## What was checked

Read the complete candidate, its change from the prior proposal, closure records and
fixture generator/checkers. The five routes, strict request refusal, tuple identity, opaque
chunk ids, view-scoped revision, current-only original and cleanup retry are coherent with
the previously reviewed core. Authored fixtures are explicitly distinct from generated
ones; acceptance does not turn pending implementation behaviour into measured evidence.

Independent native Windows execution, Python 3.14.2, PostgreSQL 16.15, pinned knowledge
requirements in the existing isolated test runtime:

- `python -m unittest discover -s knowledge/tests -v`: **42 passed, zero failures/skips**,
  4.248 s. Includes generated-fixture replay on fresh databases, all wire shapes, negative
  requests, scoped collection/passage/original reads, revocation and snapshot regressions.
- `kb-contract-review.py`: exit 0; strict finite/JSON values, identities and bounded fixed
  operator-only withheld reports accepted/refused as expected.
- `kb-endpoint-contract-review.py --database`: exit 0; fixture request/focus MATCH, request
  refusal, actual core focus identity, bounded expansion and three denied-principal controls.
- `kb-sync-review.py`: exit 0; authoritative/partial listings and failed refresh controls;
  real held Windows original stays logically denied and durably pending, then a fresh
  connection/service retries successfully after handle release (`FIX_VERIFIED`).

The portable PostgreSQL instance listened only on a temporary loopback port, stopped with
exit 0 and left no matching postgres process. No model/GPU worker, WSL, private input,
connector, remote host/database, HTTP/browser service or deployment was started. GPU worker
remains off. Broad Foundation/Conductor/UI suites were unrun; no product code changed.

## Acceptance edits and remaining implementation gates

Under task27's narrow handoff, record Codex acceptance and status in retrieval-contract.md;
label the accepted fixtures and resolved decisions; replace obsolete draft/v0 wording and
label the historical failed-refresh discussion as superseded. No rule or wire shape changes.
In kb-contract-v1.json, change only status metadata. UTF-8 semantic comparison confirms all
other fields, including **39 fixtures (32 generated, seven authored)**, are unchanged.
`git diff --check` passes. Endpoint pure controls also pass after the status edit.

K6 still must implement/test credential and assertion verification, unauthenticated/size/
rate/outage errors, timeouts, bounded checked serialization, one-segment path decoding,
request ids and re-authorisation at original-byte delivery. K8 still must prove participant
registration, every-hop destination enforcement, policy freshness and operator-only reports.
K3/K4/K5/K13 behaviours remain at their named stages. These gates cannot be discharged by
this core/fixture run. Later wire/rule changes require both lanes and a version bump.

The MCP claims were spot-checked against the linked primary
[2026-07-28 changelog](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/changelog.mdx)
and [authorization specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/authorization/index.mdx)
on 30 October: the cited revision removes handshake/sessions; protected HTTP resource
servers use the OAuth mechanism and metadata, while STDIO obtains credentials from its
environment. No SDK compatibility or live adapter acceptance is claimed; K7 must pin/test
its implementation against the selected revision.

Next: merge the bounded acceptance record, then assign/claim K6 separately. Preserve the
research R4 correction, P09 and Windows-console follow-up in the independent backlog.
