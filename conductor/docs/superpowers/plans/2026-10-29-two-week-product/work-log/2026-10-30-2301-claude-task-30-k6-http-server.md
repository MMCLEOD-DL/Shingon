# Claude task 30: K6 part 2, the HTTP server

```
Packet/subpacket: K6 (HTTP API per contract v1), part 2 of 2. Part 1 (credentials) merged as PR56.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 24f8298.
Owned files: knowledge/src/shingon_knowledge/{http.py, __main__.py} (new), service.py (original(audit=)); knowledge/tests/
  {support.py (ApiClient, start_api, issue_http_callers), test_contract_fixtures.py (generated over HTTP), test_http.py (new)};
  knowledge/contract/kb-contract-v1.json (four transport fixtures now generated); knowledge/README.md;
  conductor/docs/knowledge-base/retrieval-contract.md (§10 origins only); this entry.
What now works (retrieval-contract.md §11 K6 obligations):
  /kb/v1 routes on a stdlib threading server, loopback or private addresses only; one DB connection per request with
    a 5 s statement timeout. Each identifier is one percent-encoded segment, decoded once.
  Credentials (part 1) on every route but /health; one 401 for every refusal; refusal reasons logged, headers never.
  413 over 16 KB before parsing; Content-Length required; 429 with retryAfter and Retry-After (60/min per credential and
    user, per process); every fault, timeout or unreachable database is 503 with fixed wording.
  Every JSON body is built and checked by contract.py; one that fails its check is never sent (503, reason logged).
  Originals: checked, opened, checked again (unaudited) before any byte; a revocation in between stops delivery.
  Request ids: X-Request-Id or clientRequestId when valid, else issued; echoed. Every HTTP method answers in JSON.
  CLI: serve, credentials issue-project / issue-app / revoke; KB_DATABASE_URL from the environment.
Checks (cloud Linux, Python 3.13, PostgreSQL 16 throwaway), from knowledge/:
  python3 -m unittest discover -s tests: 61 passed (11 new in test_http.py).
  The fixture generator now runs over real HTTP with real tokens and signed assertions: all 32 previously generated
    fixtures came out byte-identical. The authored unauthenticated, too-large and index-unavailable fixtures were
    reproduced exactly as generated ones; rate-limit too, with retryAfter 60 (the one-a-minute test limit) for the
    authored 30. Three authored fixtures remain (stale-source K13, scanned-pdf-ocr K5, destination-withheld K8).
  End to end: `python -m shingon_knowledge serve` against a fresh database; curl health 200, project-token search
    (strong, standards/logging.md), collections 200, tampered token 401; no token in the server log.
Not here: TLS (loopback/private only); operator credentials; a shared rate limit across processes.
Live / fake / skipped / unrun: real PostgreSQL and real HTTP on loopback; no Windows run here; no models.
```
