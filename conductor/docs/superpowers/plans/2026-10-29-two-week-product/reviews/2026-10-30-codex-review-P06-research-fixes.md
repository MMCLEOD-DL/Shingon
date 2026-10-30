# Codex re-review: P06 research corrections (PR32)

Date: 30 October 2026 (UTC). Reviewer: Codex; correction owner: Claude.
Correction: `ae2094796a988162f61c6ecbdf0b68b5e3144bf9` (merged PR32).
Integrated baseline: `e0eaa10cc8180c38e752e4b777f8966447e571fb` (PR51 merged).

**Disposition: P06-R1–R3 resolved as research corrections; P06-R4 partially resolved,
with one P3 documentation correction remaining.** No new blocking architecture finding.
The accepted D1/D2/D5 decisions stand; D3/D4 remain open. This review neither grants a
licence exception nor approves vector isolation, ingestion, runtime admission or release.

## Closed research findings

| Finding | Verified correction and bounded disposition |
|---|---|
| P06-R1 (P2) | Recommendation no longer calls OCRmyPDF permissive or R8 unconditionally satisfied. Options identify MPL-2.0, require a recorded exception distinguishing internal use from client distribution, and propose alternative OCR engines. K5 must pin/check OCR, weights and native dependencies. ADR/parser roadmap wording agrees. Resolved as a selection/policy correction; no complete OCR dependency set has been admitted. |
| P06-R2 (P2) | Options and recommendation distinguish FORCE binding the table owner from superuser/BYPASSRLS exemption. Runtime role must be non-owner, NOSUPERUSER/NOBYPASSRLS, migrations separate; acceptance must check effective role and denied rows. Resolved documentation; no deployed role configuration or RLS implementation was tested. |
| P06-R3 (P2) | Options, recommendation, evaluation and K3 now make candidate isolation explicit. Shared HNSW is conditional, per-tenant partitioning alone does not settle document ACLs, and exact search must score only authorised rows. K3 requires plan/boundary/recall evidence. Resolved research assumption; no vector implementation or scoring-isolation proof is claimed. |

Primary sources rechecked on 30 October 2026:

- [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/), especially Q1 and Q5–Q8:
  file-level copyleft and the distinction between private use and external distribution.
  [OCRmyPDF licence](https://github.com/ocrmypdf/OCRmyPDF/blob/main/LICENSE) agrees;
  the repository's separate permissive policy still rejects MPL without an exception.
- Upstream [EasyOCR](https://github.com/JaidedAI/EasyOCR/blob/master/LICENSE) and
  [RapidOCR](https://github.com/RapidAI/RapidOCR/blob/main/LICENSE) code licences are
  Apache-2.0; [tesserocr](https://github.com/sirfz/tesserocr/blob/master/LICENSE) is MIT.
  These are code-licence spot checks, not a scan of pinned wheels, model weights or native
  dependencies. [OCRmyPDF introduction](https://ocrmypdf.readthedocs.io/en/stable/introduction.html)
  confirms the alternative rasterizer since 17.0; Ghostscript is not assumed mandatory.
- [PostgreSQL 16 row security](https://www.postgresql.org/docs/16/ddl-rowsecurity.html)
  confirms the corrected FORCE/role distinction.
- [pgvector v0.8.7 filtering/multitenancy](https://github.com/pgvector/pgvector/blob/v0.8.7/README.md#filtering)
  documents post-index filtering and cross-tenant recall/speed effects. The need to isolate
  candidates to satisfy this contract's stronger never-score rule is an inference from that
  execution model; no vector attack or returned-data leak was executed in this review.

## P06-R4 — [P3] Fix the explanation of the 350 measured searches

Location: `conductor/docs/knowledge-base/evaluation.md:75`.

Trigger: a reader reproduces the stated latency run using the linked evaluator and results.
The new aggregate figures correctly match the saved summary: **350, p50 0.33 ms,
p95 0.69 ms, maximum 2.41 ms**. However, the added decomposition says **two permission
sweeps × 25 questions × six credentials**. The evaluator defines four credentials
(alice, andy, bella, conductor) and calls three sweeps (initial, permission changes,
deletion). The saved checks independently name those three sweeps, each with 100 searches.
The earlier results table also correctly says three sweeps of 100.

Consequence: the numeric total happens to agree while describing a different experiment,
misleading anyone checking which permission/deletion states were covered.
Requested correction (Claude): change only the decomposition to **25 questions × two
ranking variants + three permission sweeps × 25 questions × four credentials = 350**.
Keep all saved measurements unchanged and retain the missing-sample limitation.

Reproduction: the original stored-evidence audit passes at this baseline because it checks
only aggregate figures. The strengthened retained audit now also checks maximum and the
prose breakdown against the evaluator's syntax and saved sweep records. It reports
`prose=(2, 25, 6); source/stored checks=(3, 25, 4)` and exits **1, expected**. It parses
Python without importing the evaluator or opening a database. In an external copy with
only that sentence corrected, the same audit exits **0**. No owner document was edited.

## Evidence and handoff

Windows, Python 3.14.2, Node 24.12.0. From repository root:

```powershell
python conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/audit-P06-stored-evidence.py
# Expected exit 1 until the R4 breakdown is corrected; all other stored checks agree.
node --import ../hide-child-consoles.mjs --import ./foundation/node_modules/tsx/dist/loader.mjs conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/control-P06-licence-policy.mts
# Exit 0, existing gate accepts MIT and rejects MPL-2.0. The console preload is local-only.
```

- Saved variant/category totals still agree: **17/25** and **21/25**; **21/21 stored
  checks** agree. These are audited observations, not newly executed retrieval checks.
- Archived original audit/results/prose from review commit `357d2ef` reproduce the original
  R4 mismatch (325/0.37/0.83 versus 350/0.33/0.69), expected exit 1.
- Corrected-copy positive control: strengthened audit exit 0; integrated baseline exit 1
  on the sole remaining breakdown mismatch. Only 50 per-question samples are retained,
  so full quantiles cannot be independently recomputed.
- `git diff --check` passes. No product source, owner research, dependencies or policy
  changes; broad product suites unrun for this research review.
- No database or model runtime started. GPU worker remains off. No private corpus, live
  connector, remote host, deployment, cost re-quote or acceptance claim.

Claude owns the R4 sentence correction; Codex re-verifies its new SHA. P06 remains IN_REVIEW.
KB-R1–R7 core closures remain intact. K3/K5 implementation gates, K6/K8 runtime admission,
D3/D4 decisions and whole-product acceptance remain separate. P09 and the Windows console
follow-up stay in the queue after the review submission is merged.
