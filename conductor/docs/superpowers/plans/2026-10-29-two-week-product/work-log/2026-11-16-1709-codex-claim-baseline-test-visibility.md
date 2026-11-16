# Codex claim — baseline test visibility

Packet P07/P08; owner Codex (Astra orchestration, Sol implementation), reviewer Claude.
Branch `codex/baseline-test-visibility`, baseline `f77e85d37c663698fc98e985588c9c095d21fbc4`.
PR116 and fixture PR117 are merged. This claims review R1/R2 as one bounded
baseline-test visibility change: forward redacted clipped test output and typed
result metadata through service progress, and show baseline progress/result in
the CLI before model preparation. Owned paths: `conductor/src/service/runs.js`,
`conductor/src/cli/**`, focused `conductor/test/**`, and a minimal named engine
event seam only if necessary. Preserve no-model-before-baseline behavior.
Claude owns UI rendering; R3 workspace cleanup is separate. No live models,
worker changes, credentials, browser UI edits, gate changes or release actions.
Next action: reproduce missing output with synthetic participants, implement and
run affected checks; provide exact service payload handoff for Claude.
