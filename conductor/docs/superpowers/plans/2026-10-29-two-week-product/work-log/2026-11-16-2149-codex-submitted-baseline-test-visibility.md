# Codex task submitted — baseline test visibility

- Packet/subpacket: P07/P08, PR116 review R1/R2 service and CLI visibility. Owner Codex (Astra orchestration and independent review, Sol implementation); cross-reviewer Claude. Status IN_REVIEW.
- Branch `codex/baseline-test-visibility`, original baseline `f77e85d37c663698fc98e985588c9c095d21fbc4`. Implementation `21827e0`; latest main `6473e74` integrated by merge commit `11a975dbfa0b506e3f8b2d3c33c5cd5648da6f1e`, the tested code head. [Draft PR126](https://github.com/MMCLEOD-DL/Shingon/pull/126). Auto-merge off; service path requires Malcolm's approval.
- Owned changes: `src/service/runs.js`, `src/cli/main.js`, and their regression tests. No engine or UI source edits. The claim filename was corrected to the observed claim time.
- Contract v1 is additive: `progress.data` for `engineType: baseline-tests` now retains boolean `passed`, safe-integer or null `code`, and string `output`. Output passes existing redaction/control stripping before the 8,000-character service cap and persists for replay. CLI shows checking/pass/failure and output capped at 4,000 characters before model preparation, including pending-baseline resume. Existing prepared hooks take over afterward. The handled interruption message includes a resume hint once a workspace exists.

## Validation

Synthetic providers only; no live-model calls or deployment. Native Windows, Node 24.12.0, existing Playwright 1.63.0. Initial targeted regressions reproduced the missing CLI visibility and discarded service metadata before implementation. Sol's final focused command from `conductor/`, `node --test --test-name-pattern="baseline|missing test executable" test/cli-e2e.test.js test/service/engine.test.js`, passed 6/6, exit 0. All six also passed in the final integrated full run.

At integrated code head `11a975d`:

- `conductor/`: `node --test --test-concurrency=4`: 1,718 total, **1,516 passed, 201 failed, 1 skipped**, exit 1. Evidence retained locally as `%TEMP%/shingon-visibility-integrated-full.log`. Native suite is not green. Failures include POSIX tooling/mode/signal assumptions and symlink permission cases; not every failure has been independently classified as pre-existing. No tests were weakened to clear those failures.
- `conductor/operator-web/`: `npm test`: **86/86 passed**, 3 files, exit 0; `npm run build`: exit 0.
- Same directory, `NODE_PATH` set to existing global npm modules: `node e2e/journey.mjs`: **22/22** HTTP/UI fixture checks, **6/6** real-engine checks with stand-in CLIs, **4/4** restart/resume/fallback checks, exit 0. Evidence `%TEMP%/shingon-visibility-browser.log`. No real subscription or local-model acceptance inferred.
- [Linux CI run43963025650](https://github.com/MMCLEOD-DL/Shingon/actions/runs/43963025650) at code head: conductor, operator-web, knowledge and foundation all **PASS**. Conductor Node22.22.0: **1,715 passed, 0 failed, 3 skipped**, 1,718 total.
- Risk gate is red for protected-path approval. No approval label or gate setting changed.
- Astra read-only review at `11a975d`: no blocking defect found. Windows abrupt process termination verifies resumed checking but does not prove the handled Ctrl-C message. Output cap/type filtering was source-reviewed; redaction, terminal controls and replay were exercised.

## Handoff and remaining work

Claude owns browser rendering of `progress.data.output`; the existing UI currently shows the baseline reason, not this output. R3 workspace cleanup and G4 service-event follow-ups are separate tasks. Claude cross-review remains requested through this handoff, not represented as completed. Malcolm's merge or protected-path approval is required. The next Codex task starts only after PR126 merges. Existing untracked `docs/operator-app/windows-acceptance-results-2026-11-12.md` was untouched and excluded.
