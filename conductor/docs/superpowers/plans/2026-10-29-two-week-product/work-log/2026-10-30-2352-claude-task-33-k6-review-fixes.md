# Claude task 33: K6-A1, K6-H1 and K6-H2 (Codex's K6 review findings)

```
Packet/subpacket: K6 corrections. Findings: K6-A1 (reviews/2026-10-30-codex-review-kb-credentials.md) and K6-H1,
  K6-H2 (reviews/2026-10-30-codex-review-kb-http.md), all P2, all Claude's.
Owner and reviewer: Claude; reviewer Codex (please re-verify at the SHA in the PR).
Status: IN_REVIEW.
Baseline SHA: 9a3588e (K9 merged).
Owned files: knowledge/src/shingon_knowledge/{auth.py, http.py, db.py, __main__.py}; knowledge/tests/{test_auth.py,
  test_http.py, support.py, test_contract_fixtures.py}; knowledge/README.md; this entry.
Changes:
  A1: a signed user id containing NUL or not encodable as strict UTF-8 is refused as Unauthenticated before any query.
    Valid Unicode ids (tested with 'zoë') and the unknown-user refusal are unchanged; real outages still raise as
    outages.
  H1: Content-Length must be exactly one header of ASCII digits; leading zeros are stripped and the length compared
    as text before int(). Malformed is 400 bad-request, over 16 KB is 413 too-large. Chunked bodies are still refused.
  H2: one monotonic deadline per request, 5 s from arrival. The connection is opened with the time left as its
    timeout, and before each statement statement_timeout is set to what remains (a Db subclass in http.py). Past the
    deadline no statement is sent. Expiry is 503 index-unavailable and the connection is closed. The five-second rule
    itself is unchanged.
Reproduce first: Codex's retained controls, unchanged, on cloud Linux / Python 3.13 / PostgreSQL 16.15:
  before: reviews/fixtures/kb-http-review.py exit 1 REPRODUCED (both Content-Length cases RemoteDisconnected;
    two-phase wait 503 after 6.263 s); reviews/fixtures/kb-auth-review.py exit 1 REPRODUCED (nul-user DatabaseError,
    surrogate-user UnicodeEncodeError and the next query on that connection wrong).
  after: kb-http-review.py exit 0 PASS (400, 413; 503 after 5.003 s; recovery 200); kb-auth-review.py exit 0 PASS
    (both refused as Unauthenticated, no nonce kept, the same connection still answers).
Checks, from knowledge/: python3 -m unittest discover -s tests: 84 passed (3 new), none skipped.
  The new tests each fail when their fix is undone: the budget test measured 6.27 s with the old per-statement
  timeout, and the NUL case errors without the text check. git diff --check is clean.
Not here: no Windows run (Codex's native Windows controls are the independent check); no slow-network connection
  test beyond the socket timeout; Postgres 17's transaction_timeout is not used (the target is 16).
```
