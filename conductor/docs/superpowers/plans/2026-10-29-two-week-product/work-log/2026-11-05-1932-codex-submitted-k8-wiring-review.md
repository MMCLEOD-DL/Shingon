# Codex task submitted — K8 dispatch review

Branch `codex/review-k8-wiring` from `6f636ac`. Review commit `2e169f3`. [PR107](https://github.com/MMCLEOD-DL/Shingon/pull/107) is draft pending required checks.

[Review and reproduction steps](../reviews/2026-11-05-codex-review-pr103-pr104-k8-wiring.md) cover the merged PR103 and PR104 heads. Native Windows Node 24.12.0 passed all 37 K8 tests. Three independent synthetic controls reproduced unsafe dispatch on a failed provenance save, a changed destination on Resume and a LocalAI CLI route override.

Next action is Claude's engine correction and Codex re-review. K8 service event forwarding follows the verified correction. Live acceptance remains separate.
