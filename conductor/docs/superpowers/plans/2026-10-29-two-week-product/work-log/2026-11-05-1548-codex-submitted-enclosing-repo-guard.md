# Codex task submitted — enclosing repository guard regression

- P07/P08, Codex owner; branch `codex/guard-enclosing-repo` from main `3842218c38c1595b8a73fa1a4f601ed2fde560a1`, code/handoff `f40cc72d6d44f5249e9fbc45ca6b36e222f0d4e9`. Addresses Claude PR93 T1.
- Draft PR: https://github.com/MMCLEOD-DL/Shingon/pull/97 . This is the final branch commit; verify inclusion in any merge. Final-head required checks pending; keep draft until all pass, preserve approval gates and Malcolm's label.
- Portable synthetic regression proves damaged workspace HEAD causes real Git discovery of an enclosing repository, then requires rejection, poison, subsequent wrapper refusal and unchanged source/enclosing refs. No production source or existing assertion change.
- Native Windows11/Node24.12.0 focused command in the handoff: **5 pass / 0 fail / 0 skip**, 1.45s. Isolated source-copy mutation disabling only the common-dir guard fails the new regression with missing expected rejection; current source untouched and scratch removed. `git diff --check` clean. Full Linux suite remains required CI, not claimed from native focused checks.
- [Handoff](2026-11-05-1550-codex-handoff-enclosing-repo-guard.md). No live calls, credentials, worker/policy, UI or deployment operation; existing worker and automation pauses preserved.
- Next: CI/review/merge of this test-only PR, then separately perform the authorized independent PR96 review and interface assessment; leave Claude's engine integration separate. One task/one PR until merge.
