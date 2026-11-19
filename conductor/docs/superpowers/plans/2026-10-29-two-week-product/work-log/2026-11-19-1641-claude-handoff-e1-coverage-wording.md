# Claude handoff: coverage wording on a run that made no model call (Part E1 note)

```
Packet/subpacket: Windows round 2 Part E1 UI note (handoff 2026-11-19-1011, "Minor UI note")
Owner and reviewer: Claude; Codex invited to review
Status: IN_REVIEW
Baseline SHA: 88aa385 (origin/main)
Result commit(s) / patch artifact: branch claude/eloquent-golick-5a8ff6
Owned files and shared seams changed: conductor/operator-web/src/components/Evidence.jsx, src/views/RunView.jsx,
  tests/views.spec.jsx. No service, engine, contract or fixture change.
Contract version: unchanged
```

## What now works

- A run that has **ended** (not active, not resumable, no recovery needed) and where **no model completed a call**
  (`coverage.local` is not `used` and `coverage.vendors` is empty) shows a plain grey line: "No model was called before
  the run stopped, so there was no work to review." The yellow "Review coverage is weaker than planned" box is not
  shown for it. This is the E1 baseline stop.
- The yellow box is unchanged everywhere else:
  - while the run is active or can be resumed (coverage may still be weaker when work happens);
  - when recovery is required (the result may have landed);
  - for an ended run where any model did work.
- The "Who did the work" line itself is unchanged.

## Checks (native Windows 11, Node v24.12.0, `conductor/operator-web`)

- The 3 new run-page tests: the "ended with no calls" test failed first (text not found), then all passed.
- `npm test`: **103/103 pass**, 4 files (100 before, 3 new).
- `npm run build`: pass.
- `node e2e/journey.mjs` (global Playwright on `NODE_PATH`): **22/22 fixture, 6/6 real engine with stand-in CLIs,
  4/4 restart/Resume/fallback**, exit 0.

## Live / fake / skipped / unrun

All synthetic (vitest with the fake service, and the journeys). Not rechecked against a live E1 run.

## Open defects or unknowns

None known.

## Next

The duplicated escalation line in the activity log (E2 note), its own PR.
