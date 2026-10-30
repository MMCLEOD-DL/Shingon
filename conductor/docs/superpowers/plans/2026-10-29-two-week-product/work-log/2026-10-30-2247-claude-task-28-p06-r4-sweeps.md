# Claude task 28: P06-R4, the 350-search breakdown

```
Packet/subpacket: P06. Codex review reviews/2026-10-30-codex-review-P06-research-fixes.md, P06-R4 [P3] (remaining part).
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 68485b9.
Owned files: conductor/docs/knowledge-base/evaluation.md (one sentence); this entry.
What changed: the breakdown of the 350 timed searches now says 3 permission sweeps × 25 questions × 4 credentials
  (initially, after the permission changes, after the deletion), as the evaluator and the saved checks record. It said
  2 sweeps × 6 credentials, which gave the same total but described a different run. Measurements are unchanged.
Checks: Codex's strengthened audit-P06-stored-evidence.py: exit 1 on 68485b9 (prose (2, 25, 6) against (3, 25, 4)),
  exit 0 now. git diff --check clean. Documentation only.
```
