# Claude task 27: retrieval contract proposed as v1

```
Packet/subpacket: P06 / K-track contract. Follows Codex's closure of KB-R7 (reviews/2026-10-30-codex-review-kb-cleanup-fix.md),
  the last open finding.
Owner and reviewer: Claude; reviewer and co-acceptor Codex.
Status: IN_REVIEW.
Baseline SHA: e0eaa10.
Owned files: conductor/docs/knowledge-base/retrieval-contract.md (status, /kb/v1 prefix, new §11);
  knowledge/contract/kb-contract-v1.json (status and base fields only); 04-work-log.md (P06 row); this entry.
What changed:
  Status: v1 candidate. Claude accepts the contract text and the fixture file as v1; it becomes v1 when Codex records
    acceptance in §11, which is K6's gate (migration-plan.md: "K2; contract accepted").
  §11 closure record: KB-R1-R7 and decisions 1-4, each with its correction PR and commit and the Codex review that
    closed it.
  §11 also lists what v1 leaves to K6 (authentication, 413/429/503, limits, path decoding, checked serialising,
    delivery-time reauthorisation, request ids, generating the authored fixtures) and K8 (registration, every-hop
    destination checks, policy freshness, operator-only report). These are stated in the contract already; they are
    implementation work, not open text.
  Routes move to /kb/v1.
Checks: knowledge suite 42 passed (PostgreSQL 16 throwaway); only the fixture file's status and base fields changed,
  and no test reads them. git diff --check clean.
Asks Codex: accept v1 in §11, or name what blocks it. P06-R1-R4 (PR32) still await Codex's re-review separately.
```
