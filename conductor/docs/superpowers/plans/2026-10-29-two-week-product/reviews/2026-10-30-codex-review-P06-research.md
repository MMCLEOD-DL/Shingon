# Codex review: P06 knowledge-base research

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Research/correction owner: Claude.
Reviewed integrated baseline: `77a9419857a3a64faac0588723d53a11fa76bf28`.
Scope: inventory, options, recommendation, evaluation and migration plan; the separately
reviewed retrieval contract supplies the security requirement, not a newly accepted contract.

**Disposition: changes requested (four findings).** The composable PostgreSQL direction
remains reasonable within the evidence limits below. This review does not reverse ADR 0001:
D1 (personal/company separation), D2 (composable stack) and D5 (reference first) are accepted
for K2; D3 (client runtime) and D4 (hosting) remain open. Merging this review records the
handoff; it neither fixes the findings nor authorises ingestion, deployment or client access.

## P06-R1 — [P2] Correct the permissive-licence claim before selecting the OCR package

Location: `conductor/docs/knowledge-base/recommendation.md:21,69`; `options.md` R8 scoring.

Trigger: K5 or a client package selects OCRmyPDF on the strength of the all-permissive claim.
OCRmyPDF is MPL-2.0, as the recommendation itself records, but MPL is file-level copyleft.
The current repository allowlist rejects MPL-2.0; ADR 0001 explicitly chose a permissive
PostgreSQL driver for this policy. The recommendation therefore misstates compliance and
could send packaging work down a route that requires an unrecorded operator exception.

Evidence: the standalone `control-P06-licence-policy.mts` imports the existing gate and
passes with MIT allowed and MPL-2.0 rejected. This is a policy control, not a scan of Python,
native executables or model weights. Primary sources checked on 30 October:
[OCRmyPDF repository](https://github.com/ocrmypdf/OCRmyPDF#license) and
[Mozilla MPL FAQ, Q1/Q5–Q8](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).
Private company use is permitted; external distribution has different obligations. This is
not a claim that MPL software cannot be used commercially.

Requested correction: remove the all-permissive assertion and unconditional R8 pass; record
an OCR alternative or the explicit operator-exception gate, with internal versus shipped
use stated. Pin the actual OCR/parser/model/rasterizer dependency set before its licence
review. Do not assume Ghostscript is mandatory: the current
[OCRmyPDF introduction](https://ocrmypdf.readthedocs.io/en/stable/introduction.html)
describes pypdfium2 as an alternative since version 17.0. No policy exception is granted here.

## P06-R2 — [P2] FORCE RLS does not constrain BYPASSRLS or superuser roles

Location: `conductor/docs/knowledge-base/options.md:98`; related isolation wording in
`recommendation.md:47`.

Trigger: deployment follows the statement that owners and BYPASSRLS roles bypass RLS
unless FORCE is set, and assigns an API role with BYPASSRLS while relying on FORCE.
The stated protection does not exist: FORCE subjects an ordinary table owner to RLS;
superusers and BYPASSRLS roles still bypass it. This can defeat a future defence-in-depth
boundary. No production role configuration or current data exposure was tested here.

Evidence: [PostgreSQL 16 row-security documentation](https://www.postgresql.org/docs/16/ddl-rowsecurity.html).
Requested correction: distinguish owner behaviour from unconditional bypass attributes;
require the runtime role to be non-owner, NOSUPERUSER and NOBYPASSRLS, with separate
migration/operator authority. Include effective-role and denied-row checks in the future
RLS acceptance evidence, rather than treating FORCE alone as proof of isolation.

## P06-R3 — [P2] Shared HNSW is not evidence of authorisation before scoring

Location: `conductor/docs/knowledge-base/options.md:90–98`, `recommendation.md` architecture
and isolation sections; requirement in `retrieval-contract.md` §1 item 3.

Trigger: K3 adds an approximate index spanning mutually inaccessible documents, uses a
WHERE ACL predicate plus iterative scans, and treats that as satisfying the contract's
promise that unauthorised chunks are never scored. The options document correctly notes
post-index filtering, but only carries its recall consequence into the experiment plan.
The stronger security requirement is unresolved: a shared graph can traverse vectors
outside the authorised set before SQL filtering, and other tenants can affect search work.

Evidence: [pgvector v0.8.7 Filtering, Multitenancy and Iterative Index Scans](https://github.com/pgvector/pgvector/blob/v0.8.7/README.md#filtering).
Iterative scans recover more candidates; they do not establish a separate authorisation
boundary. This is an inference from the documented execution model and the proposed
contract, not an executed vector attack or a demonstrated returned-data leak.

Requested correction: make shared HNSW conditional on resolving this requirement in K3.
Specify candidate/index isolation or an authorised exact-search fallback; test the actual
query plan and both recall and security boundaries. Tenant partitioning alone does not
resolve finer per-user document ACLs. Keep company reference and possible client-runtime
deployment boundaries explicit while D3/D4 remain open. The keyword spike's zero returned
unauthorised results must not be presented as proof of the vector scoring guarantee.

## P06-R4 — [P3] Reconcile the latency paragraph with its linked result artifact

Location: `conductor/docs/knowledge-base/evaluation.md:75` and
`conductor/spikes/knowledge-base-evaluation/results/results.json` summary.latencyMs.

Trigger: a reader follows the evaluation's raw-results link to reproduce the reported run.
The prose says 325 searches, p50 0.37 ms and p95 0.83 ms; the saved artifact says 350,
0.33 ms and 0.69 ms (maximum 2.41 ms). The two reports cannot describe the same summary.
The evaluation loop also accounts for 50 question searches plus 300 permission-sweep
searches. Although correctly labelled tiny-corpus evidence, its provenance needs fixing.

Evidence: `audit-P06-stored-evidence.py` independently counts saved correct answers and
categories, confirms the 21 saved check outcomes, and exits 1 on this prose mismatch.
Only the 50 per-question timings are stored; all 350 samples needed to independently
recompute the aggregate quantiles are absent. Requested correction: align prose to the
pinned saved run or supply the distinct older run artifact. Do not imply new measurements.

## Evidence retained and limits

- Saved retrieval totals agree: keyword 17/25; supersession demotion 21/25. All category
  counts agree. The 21/21 stored check outcomes agree with their summary. These are audits
  of recorded observations, not a fresh PostgreSQL evaluation or an independent oracle run.
- The study already identifies its invented 25-question set and 11-source/19-passage scale.
  Vector retrieval, reranking, OCR quality, answers, live connectors, revocation propagation
  under those connectors, concurrency and 20k-document performance remain unmeasured.
- The 400k × 768 half-precision vector assumption gives 614,400,000 raw vector bytes.
  HNSW, text, metadata, models, working space and backups remain additional capacity needs.
  Hardware and provider costs are planning assumptions, not validated performance or quotes;
  this review does not reprice every vendor or establish a procurement recommendation.
- Inventory and migration describe a historical Babel observation. No private corpus was
  queried or exported for this review. Ownership, retention, backup/restore, selection and
  dry-run approval remain migration gates. The accepted personal/company separation stands.
- The recommendation's historical pre-implementation status should be dated or linked to
  ADR 0001 and K2 so the accepted decisions and current skeleton are easy to distinguish.

## Reproduction and handoff

From repository root (Python standard library; existing Foundation tooling for the control):

```powershell
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/audit-P06-stored-evidence.py
# Expected exit 1 until P06-R4 is corrected; counts pass before the mismatch is printed.
& foundation/node_modules/.bin/tsx.cmd conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/control-P06-licence-policy.mts
# Exit 0: existing policy rejects MPL-2.0 and accepts MIT.
```

Local execution: Windows, Python 3.14.2, Node 24.12.0. No DB, model, connector, account,
remote machine, deployment or private input was used. No product code changed; broad
product suites were not rerun for this documentation review. `git diff --check` is required
before submission. These controls are manual review artifacts, not new CI requirements.

Claude owns research corrections R1–R4; Codex re-reviews their evidence. The retrieval-contract
findings from PR24 remain separate. PR25's upgrade correction is the next supplied source
re-review; P09 remains in the independent-review backlog. No new implementation is claimed.
