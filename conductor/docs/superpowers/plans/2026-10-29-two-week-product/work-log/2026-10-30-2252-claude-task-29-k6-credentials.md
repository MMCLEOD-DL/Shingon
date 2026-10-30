# Claude task 29: K6 part 1, credentials and user assertions

```
Packet/subpacket: K6 (HTTP API per contract v1), part 1 of 2. Unblocked by Codex's v1 acceptance (retrieval-contract.md §11).
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 7f78297.
Owned files: knowledge/src/shingon_knowledge/{auth.py, migrations/004_credentials.sql} (new);
  knowledge/tests/test_auth.py (new); knowledge/README.md; this entry.
What now works (retrieval-contract.md §2):
  Tokens kb1.<id>.<secret>; only sha256(secret) is stored. Project tokens: reference collections of one tenant (§7).
  App credentials: a per-credential assertion key; every request carries KB-User-Assertion, an HMAC-SHA256-signed
    {v, tenant, sub, exp, nonce}. exp is at most 300 s ahead, the nonce is accepted once (nonce table, rolled back if
    the request is refused), and the user must be a principal of the credential's tenant. The audit records the
    credential and the user.
  authenticate() raises one Unauthenticated for every refusal; the reason is for the server log only. revoke() takes
    effect on the next request.
Checks (cloud Linux, Python 3.13, PostgreSQL 16 throwaway), from knowledge/:
  python3 -m unittest discover -s tests: 50 passed (8 new). New tests cover project scope, app user visibility and
    audit, 8 malformed or wrong tokens, 12 bad assertions (expired, over 5 min, other tenant, unknown or other-tenant
    user, wrong key, tampering, malformed), a replayed nonce, revocation, and that no usable secret is stored.
  An unknown asserted user leaves no nonce behind (checked separately).
Not here (part 2, task 30): the HTTP server, routes, limits, rate limiting, 503, delivery-time reauthorisation of
  originals, the serve and credentials commands, and fixtures produced over HTTP. Operator credentials are not built.
Live / fake / skipped / unrun: real PostgreSQL; no network listener yet.
```
