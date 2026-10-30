# Codex review: K6 HTTP server (PR59)

Date: 30 October 2026 (UTC). Owner: Claude; reviewer: Codex.
Source: `0facb308dc7fb023246a089d2c83541881f1bc7d` (task30, PR59).
Baseline: `def467e847d0948533ddf0196b8c8f412093501e` (PR58/59 merged).

**Disposition: changes requested for K6-H1 and K6-H2 (P2).** Ordinary native Windows
tests and loopback HTTP controls pass. Existing K6-A1 remains separately open: PR59 did
not change auth.py. P06 research DONE, contract v1 and KB-R1–R7 closures remain intact.

## K6-H1 — [P2] Validate and bound Content-Length before conversion

Location: `knowledge/src/shingon_knowledge/http.py:155–165`, especially line 161.

Trigger: an unauthenticated POST /kb/v1/search sends a Latin-1 superscript-two character
(`\u00b2`) as Content-Length, or a 5,000-digit ASCII decimal length (all nines).
Both pass str.isdigit(). The first cannot be converted by int(); the second exceeds
Python's integer-string conversion limit. Conversion at line 161 is outside the
ValueError handler and before _with_db(). The exception escapes Api.handle().

Actual socket result for both: **RemoteDisconnected**, without an HTTP response,
JSON error or request id. The listener remains healthy afterwards. This violates
the bounded request/error contract; it is not a service-wide outage or auth bypass.
[RFC 9110 §8.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6) uses decimal
digit syntax and requires safe handling of large numerals (rechecked 30 October).

Requested correction (Claude): validate ASCII decimal syntax, normalise leading zeroes
and compare to the size cap before unbounded conversion. Return fixed JSON 400 for
malformed values and 413 for a valid value above the cap. Retain Python's integer
conversion guard and chunked-body refusal. Add actual socket regressions for both
inputs and a subsequent healthy request. The retained control supplies these cases.

## K6-H2 — [P2] Apply the five-second budget across the search request

Location: `knowledge/src/shingon_knowledge/http.py:168–177` and the authentication/search
sequence in _authorised(). Retrieval-contract.md §4 requires search to return or fail
within five seconds.

Reproduction uses real PostgreSQL locks, without product source patches: hold credentials
exclusively in one connection and chunks in another; start an authenticated loopback
search; release the credential lock after 1.25 seconds, keeping chunks blocked.

Authentication completes after its wait, then the candidate statement receives a fresh
five-second timeout. The client gets fixed **503 index-unavailable after 6.260 seconds**.
An earlier independent run measured 6.256 seconds. Releasing the chunk lock restores
ordinary 200 search responses.

Consequence: sequential waits accumulate. SET statement_timeout bounds each statement,
not the request, and does not itself bound connection establishment/non-SQL work. Only
the two-phase lock case was measured; no slow remote connection was attempted.

Requested correction (Claude): carry one monotonic deadline through connection,
authentication and retrieval, bound blocking work and give each statement only the
remaining budget. Map expiry to fixed 503, cancel expired work and close connections
safely. Add a two-phase wait regression with a small scheduling allowance and recovery
check. Changing the accepted five-second rule requires both lanes' review.

## Evidence and reproduction

- **61 knowledge tests passed, zero failures/skips**, 11.065 seconds. Native Windows,
  Python 3.14.2, pinned requirements, PostgreSQL 16.15. Includes real HTTP fixture
  replay, scoped/request refusals, original checks and CLI credential operations.
- Fixture counts: **36 generated, three authored** (K5 OCR, K8 withheld report, K13
  stale source). Authored cases remain shape evidence only.
- Independent normal authenticated search passes; invalid JSON gets 400; nested valid
  JSON without credentials gets 401. H1 disconnects reproduce; health remains 200.
- H2's real two-phase lock wait takes 6.260 seconds; search recovers after lock release.
- Retained `fixtures/kb-http-review.py`: **expected exit 1 / REPRODUCED**. It prints
  statuses, exception types and timings, never tokens/headers/raw server traces.

From repository root with installed knowledge package and disposable TEST_DATABASE_URL
whose role may create databases:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-http-review.py
# Expected exit 1 until H1/H2 are corrected; roughly 6.3 seconds intentionally spent on locks.
```

The local suite preload sets CREATE_NO_WINDOW for subprocesses. Its first function-based
Popen wrapper broke asyncio imports; preserving Popen subclassing fixed that harness,
then all 61 tests passed. No product code/tests changed. The first manual probe expected
object validation before auth for nested valid JSON; the correct 401 is retained as a
passing control. Neither harness issue is a product finding.

## Handoff and limits

Claude owns H1/H2 and supplies new SHAs for independent re-verification. K6-A1 remains
open separately. No HTTP admission or release approval. No TLS, IPv6 listener, sustained
load, exhaustive framing/method compliance, private data or live connector was tested.
Only synthetic loopback HTTP and disposable local PostgreSQL were used. All test sockets
and databases cleaned up; temporary server stopped normally and process absence checked.
GPU worker off; no model, WSL, remote host/database or deployment. Broad product suites
unrun. Whitespace passes; branch changes only review/control and new ledger files.
