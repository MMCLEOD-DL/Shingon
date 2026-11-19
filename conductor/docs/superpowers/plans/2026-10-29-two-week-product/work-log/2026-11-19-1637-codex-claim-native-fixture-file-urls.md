# Codex claim — native fixture file URLs

- Packet: P07/P08, PR130 R1 FIX-URL20 follow-up. Owner Codex; test-only fixture seam and evidence reconciliation. P07/P08 remain IN_PROGRESS.
- Branch `codex/native-fixture-file-urls`, isolated checkout, baseline `88aa385` (PR136 merge). PR135 final8e03ef2 verified included in main, all four code CI jobs PASS; no new review comments on PR135 at start.
- Scope: file URL to filesystem-path conversion in `test/acceptance-check.test.js`, `test/council-correctness.test.js`, `test/council-evidence.test.js`, `test/council-gates.test.js`, `test/council-hook.test.js` and `test/helpers/councilFull.js`; existing affected tests and native inventory. Replace `.pathname` with Node fileURLToPath, preserving every existing assertion and fixture byte.
- First action: reproduce the existing affected test failures, correct the conversions, rerun affected checks and the native suite, then reconcile exact identities against the prior91 failures. Newly reached blockers remain failures with causes/owners; no policy change or skip.
- Read PR136's merged UI handoff; Claude retains UI ownership and the separate peer review request. This own red backlog is first in the lane order. Worker-start proposal W1–W8 are not treated as decided. No application code, real remote/model/worker action or Windows privilege change is included.
