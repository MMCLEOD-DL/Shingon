# Claude handoff: escalation listed twice in the activity log (Part E2 note)

```
Packet/subpacket: Windows round 2 Part E2 UI note (handoff 2026-11-19-1011, E2 evidence, "Notes")
Owner and reviewer: Claude; Codex invited to review
Status: IN_REVIEW
Baseline SHA: e2c9bff (origin/main)
Result commit(s) / patch artifact: branch claude/eloquent-golick-5a8ff6
Owned files and shared seams changed: conductor/operator-web/src/text.js, src/views/RunView.jsx, tests/text.spec.js,
  tests/views.spec.jsx. No service, engine, contract or fixture change.
Contract version: unchanged
```

## What now works

- New `activityText(events)` in `text.js` gives one activity-log line per event, so the count is unchanged.
- A `progress` line whose text is word for word the same as the **next** non-progress event, when that event is a
  `decision-pending`, is replaced by a short sentence. For an escalation that is "The models disagree, so your
  decision is needed.". An engine type with no known sentence gets "Your decision is needed; the question follows.".
  The question's own line still shows the full text, so it appears once.
- Text that differs, or a progress line with no question after it, is unchanged.
- The run page's activity log uses `activityText`. The status line is unchanged.

## Checks (native Windows 11, Node v24.12.0, `conductor/operator-web`)

- `tests/text.spec.js`: 4 new tests failed first (`activityText` missing), then passed.
- New run-page test that streams an escalation and its question: failed with the old `RunView.jsx`, passes with the
  new one.
- `npm test`: **108/108 pass**, 4 files (103 before, 5 new).
- `npm run build`: pass.
- `node e2e/journey.mjs` (global Playwright on `NODE_PATH`): **22/22 fixture, 6/6 real engine with stand-in CLIs,
  4/4 restart/Resume/fallback**, exit 0.

## Live / fake / skipped / unrun

All synthetic. Not rechecked against a live escalation.

## Open defects or unknowns

None in this change. Still open from the E2 notes, not in this PR: the escalation's empty evidence (Codex payload,
then Claude display), and whether "You stopped the run" with `status: paused, resumable: true` after Reject is the
wording we want.
