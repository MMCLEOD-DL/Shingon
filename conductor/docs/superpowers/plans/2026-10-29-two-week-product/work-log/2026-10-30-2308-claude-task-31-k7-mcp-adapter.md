# Claude task 31: K7, the local MCP adapter

```
Packet/subpacket: K7 (MCP adapter over K6). Malcolm chose a hand-written STDIO adapter with no new dependencies over
  the official SDK (mcp 2.3.0, about 15 direct dependencies) on 30 October 2026.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: def467e (K6 merged; its CI green on all six checks).
Owned files: knowledge/src/shingon_knowledge/{mcp.py (new), __main__.py (mcp command)}; knowledge/tests/{test_mcp.py,
  conformance/mcp_schema_check.py} (new); knowledge/README.md; retrieval-contract.md §9 (built note); this entry.
What now works (retrieval-contract.md §9, migration-plan K7):
  `python -m shingon_knowledge mcp`: STDIO, newline-delimited JSON-RPC; KB_API_URL (loopback/private) and KB_TOKEN
    (project token) from the environment; logs to stderr only; exits on end of input.
  Dual-era: 2026-07-28 (version in every request's _meta, server/discover, resultType, ttlMs/cacheScope,
    UnsupportedProtocolVersion -32022 with the supported list) and the initialize handshake for 2025-11-25,
    2025-06-18 and 2025-03-26 (ping, no modern fields).
  Three read-only tools with static descriptions and read-only annotations. API refusals are tool errors (isError);
    unknown tools and malformed requests are JSON-RPC errors, as the tools spec says.
  §6: retrieved text only inside labelled evidence blocks whose markers carry a random value per response; no
    structuredContent; evidence none tells the model to abstain; instruction-like passages are flagged.
Checks (cloud Linux, Python 3.13, PostgreSQL 16 throwaway), from knowledge/:
  python3 -m unittest discover -s tests: 71 passed (10 new). The adapter process over a real K6 server gives the
    API's passages in the API's order, reads a passage in context, lists collections, refuses another tenant's
    collection (403 scope) and a bad token (401, token never echoed).
  Schema conformance (tests/conformance/mcp_schema_check.py, jsonschema 4.26.0): 14/14 message kinds valid against
    schema/2026-07-28/schema.json (sha256 ef70b61f99b6d2e5e3b46863822eab08dff6a45bedc7a08914e0e5b133f40203) and
    schema/2025-11-25/schema.json (sha256 268a5f82ba70fd7e4b6dc4aa1e64f116f74b4d0edcb69dc046829c79dd4e97e7),
    fetched from the spec repository's main branch on 30 October 2026.
Not here: the remote HTTP adapter with OAuth (needs D4 hosting); no run against a real Claude Code or Codex client
  (no live sessions from this lane); cancellation is not acted on, because each request completes before the next is read.
```
