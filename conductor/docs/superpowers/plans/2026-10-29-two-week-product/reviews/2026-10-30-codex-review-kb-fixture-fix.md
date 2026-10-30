# Codex re-review: KB-R6 passage-fixture identity (PR46)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Correction: `a99a7cf0d2e21c4663311591bc819914e6ee0d3e` (PR46).
Reviewed baseline: `9ee17463b068c19b2b5e7e9f232b17d0d965d6ce` (PR48 merged, includes PR47).

**Disposition: KB-R6 resolved.** The successful passage fixture now requests the same opaque
stand-in ID that its response marks as focused. Generation and an explicit relational test
preserve that identity. No new blocking finding in this correction. PR47's supplied cleanup
correction needs a separate KB-R7 re-review; this does not freeze v1 or admit K6/K8 wholesale.

The generator uses one real-ID-to-stand-in mapping shared by request and response. It seeds
the request's ID through that mapping and checks the service focused that real chunk before
rewriting the response IDs. The normal fixture test separately compares the decoded path ID
with the single focused response ID for every successful passage fixture. Thus fixture replay
no longer relies only on response shape/equality checks, which missed the original mismatch.
Document order, neighbour limits and opaque-ID format remain intact. These are per-fixture
normalisations, not changes to persisted service IDs or a cross-fixture HTTP transcript.

Reviewed: `knowledge/tests/test_contract_fixtures.py:125–140,288–297` and the regenerated
passage entries in `knowledge/contract/kb-contract-v1.json`.

## Independent verification

The retained [endpoint control](fixtures/kb-endpoint-contract-review.py) independently parses
the request path and compares it with the focus ID after calling the real shape checker.
Current fixture: `MATCH`, **exit 0**. The same checker/control using archived fixture JSON
from pre-PR46 `dfaaf6c`: `MISMATCH`, **exit 1 expected**. Only the JSON input changes in this
comparison; no source checkout or product fixture is overwritten.

The control now accepts `--fixture-file` to make that comparison reproducible. Its default
input is unchanged. With `--database`, it additionally verifies real core lookup identity,
collection/document/version agreement, bounded neighbour expansion and refusal of the
finance-only passage to Andy, Bella and the project-scoped Conductor credential. Those
controls pass; the runtime lookup was already correct in the original finding.

## Validation and limits

Native Windows, Python 3.14.2 UTF-8 mode, pinned knowledge dependencies; PostgreSQL 16.15 in
the existing isolated loopback runtime. Synthetic test databases/connections cleaned up,
server stopped and process absence checked. GPU worker remains off. No private input,
model, connector, WSL, remote database, HTTP service or deployment.

From repository root with installed knowledge package and a disposable TEST_DATABASE_URL
whose role can create databases:

```powershell
$env:PYTHONUTF8='1'
python -m unittest discover -s knowledge/tests -v
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/kb-endpoint-contract-review.py --database
```

- Knowledge suite: **42 passed, zero failures/skips**, 4.218 s. This includes current
  generated-fixture replay and the relational check. PR47's included passing tests are
  compatibility evidence, not its independent correction sign-off.
- Independent current fixture/parser/core controls: **exit 0**.
- Same pure control with `--fixture-file` set to archived `dfaaf6c` JSON: **expected exit 1**,
  the original identity mismatch; ordinary request/parser controls still pass.
- `git diff --check` passes before submission. Review artifacts/ledger only; no owner source,
  fixture JSON, tests or dependencies edited. Broad Foundation/Conductor/UI suites unrun.

## Handoff

Close KB-R6 at this baseline; retain KB-R5's separate closure from PR48. KB-R7's PR47 cleanup
correction is supplied and awaiting independent review. K6 transport/delivery/cache connection
ownership and K8 runtime policy enforcement remain separate gates; no v1 freeze or release
approval here. P09 and Windows console follow-up remain queued. Merge records this bounded
fixture correction closure.
