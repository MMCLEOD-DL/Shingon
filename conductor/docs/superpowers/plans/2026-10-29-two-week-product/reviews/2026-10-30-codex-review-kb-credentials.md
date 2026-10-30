# Codex review: K6 credentials and signed user assertions (PR56)

Date: 30 October 2026 (UTC). Owner: Claude; reviewer: Codex.
Reviewed correction: `a68a295eca9732a8c3d13190ff0159db2190aad0` (task29, PR56).
Integrated baseline: `24f829875203ca3bf46b06c9cddb35f39844ab21` (PR56/57 merged).

**Disposition: changes requested for K6-A1 (P2), malformed signed principal validation.**
The ordinary scope/nonce/revocation controls below pass. No authentication bypass or
unauthorised result was observed. P06 research DONE and v1 specification acceptance remain
intact; K6 implementation admission is a separate gate. There is no HTTP layer in this PR.

## K6-A1 — [P2] Reject non-database-safe signed user ids before SQL

Location: `knowledge/src/shingon_knowledge/auth.py:125–128`, `_user()`.

Trigger: an app sends a correctly signed assertion with a valid tenant, expiry and nonce,
but `sub` contains NUL (`alice\u0000suffix`) or a lone surrogate (`alice\ud800`). The
existing check establishes only that `sub` is a Python string before passing it to the
principal query. `sign_assertion()` itself can construct both inputs (JSON escapes them).

Observed on native Windows / pinned pg8000 / PostgreSQL 16.15:

| User input | Refusal | Next `SELECT 1` on the same connection | Nonce left |
|---|---|---|---|
| Ordinary unknown user | `Unauthenticated` | Normal result | No |
| NUL-containing user | `DatabaseError` | Normal result | No |
| Lone-surrogate user | `UnicodeEncodeError` | Does not return the expected row | No |

The transaction rollback does not make the surrogate case's next query behave normally.
The retained control gives each case its own connection and uses a separate connection to
verify no nonce persisted, so one bad connection does not fabricate the other outcomes.

Consequence: these malformed identities escape the module's promised uniform
`Unauthenticated` refusal; the encoding case also disrupts the next operation if a K6
request handler reuses that connection. A handler catching the documented authentication
exception alone cannot map them to its fixed 401. No HTTP response was tested, so this is
not a measured wire leak or 500. The trigger requires an app token and its assertion key,
not an unauthenticated outsider. It is still a request-input boundary, not a reason to
trust arbitrary signed strings as valid database text.

[PostgreSQL 16 character-type documentation](https://www.postgresql.org/docs/16/datatype-character.html)
confirms that NUL is not representable in its text types (checked 30 October). The exact
exception/connection observations above come from the executed control, not that source.

Requested correction (Claude): validate signed principal text before issuing the query:
reject NUL and strings that cannot encode as strict UTF-8 as `Unauthenticated`. Preserve
valid Unicode principal ids and the existing unknown-user refusal; do not broadly convert
real database outages into authentication failures. Add regressions for both inputs that
assert uniform refusal, no consumed nonce, a healthy next query and a subsequent legitimate
request on the same connection. Rerun the retained control and full knowledge suite.

## Passing evidence and boundaries

- Knowledge suite: **50 passed, zero failures/skips**, 4.831 s on the final baseline run.
  Existing eight auth tests cover project collection scope, app/user visibility and audit,
  token/assertion refusal, expiry, replay, revocation and token hash storage.
- Independent control: ordinary unknown user is uniformly refused without consuming a nonce.
- Two simultaneous authentications using the same assertion on **separate connections**:
  exactly one accepted `alice`, one `Unauthenticated`. This is a real PostgreSQL unique-key
  race, not a mocked database return.
- Assertion signed for one credential is refused under another credential in the same tenant.
- Revoked app credential is refused through a fresh connection.
- Malformed signed-user control: **expected exit 1 / REPRODUCED**, for the two cases above.
  No raw token, assertion key, signed header or database exception message is printed.

Reproduction with the installed knowledge package and a disposable TEST_DATABASE_URL role
allowed to create databases, from repository root:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-auth-review.py
# Expected exit 1 until K6-A1 is corrected; normal/race/revocation controls pass first.
```

Windows, Python 3.14.2; existing isolated PostgreSQL 16.15 runtime, temporary loopback port.
Test databases cleaned up, server stopped with exit 0 and matching process absence checked.
GPU worker remains off. No model, WSL, private corpus, live connector, remote host/database,
HTTP/MCP listener or deployment. This branch changes only review controls and new ledger
entries. No auth/source/schema/owner README edits. `git diff --check` passes; broad product
suites unrun for this review.

The first draft of the probe reused the malformed connection and stopped when its next
query returned no row; the retained probe isolates cases and reports that connection
behaviour explicitly. No successful full probe is claimed from that interrupted attempt.

## Handoff

Claude owns K6-A1 correction; Codex independently re-verifies the new SHA. Keep this
finding open before K6 HTTP admission. Authenticated HTTP routing, header parsing, rate/
body/response limits, assertion transport, outage mapping and original-byte reauthorisation
remain task30 work, not proven by these core checks. Operator credentials are explicitly
unimplemented. Durable key management/rotation, production roles, wall-clock changes and
restart/load testing were not separately audited here. P09/Windows console follow-up remain
queued; no live runtime pause is lifted by this review.
