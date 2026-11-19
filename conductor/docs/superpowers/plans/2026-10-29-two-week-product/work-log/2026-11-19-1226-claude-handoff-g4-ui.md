# Claude handoff: step-gate details in the operator UI (N3)

```
Packet/subpacket: next.md item 6 (G4) UI follow-up; PR130 review note N3
Owner and reviewer: Claude; Codex invited to review
Status: IN_REVIEW
Baseline SHA: 6e79bb8 (origin/main)
Result commit(s) / patch artifact: branch claude/eloquent-golick-5a8ff6
Owned files and shared seams changed: conductor/operator-web/src/components/StepChecks.jsx (new), src/text.js,
  src/views/RunView.jsx, src/styles.css, tests/stepChecks.spec.jsx (new), tests/views.spec.jsx; next.md G4 note.
  No service, engine, contract or fixture change.
Contract version: unchanged (uses interface.md "G4 step activity" as it is)
```

## What now works

- **A "Step checks" section on the run page,** shown only when the run has `gate`, `scope-flag` or `protected-path`
  events. It groups them by step and shows:
  - each attempt: "Attempt 1 of 3: failed at the “types” check.", with the clipped output behind "Output from the failed
    check", or "the checks passed";
  - files outside the step's expected list, marked as a note for the reviewer and not a failure, with "Showing n of N
    files" when the service shortened the list;
  - protected files, as a warning that the attempt was blocked before review, naming the participant.
- **Activity log lines are built from the fields**, for example "Step 2: attempt 1 of 3 failed at the “types” check.".
  An event without usable fields keeps the service's own sentence.
- **The status line** says "checking the step" for these phases, instead of nothing.
- **Untrusted text stays text.** Stage names, output excerpts, file names and participants go through `plain()`, which
  strips terminal codes and control characters, and are rendered as React text only. A test checks that hostile
  `<img>`, `<script>` and `<b>` content and URLs stay literal.
- Missing fields are shown as missing, never guessed: "No output was recorded.", "no result was recorded", "A step".

## Checks (native Windows 11, Node v24.12.0, `conductor/operator-web`)

- `npx vitest run tests/stepChecks.spec.jsx` failed first (the component did not exist), then passed **13/13**.
- `npm test`: **100/100 pass**, 4 files. That is 86 before, 13 new unit tests and 1 new run-page test that streams a gate
  event through the fake service.
- `npm run build`: pass.
- `node e2e/journey.mjs` (global Playwright on `NODE_PATH`): **22/22 fixture, 6/6 real engine with stand-in CLIs, 4/4
  restart/Resume/fallback**, exit 0.

## Live / fake / skipped / unrun

All synthetic. The journeys do not produce gate events (no `gateCommands` in their configs), so the new section is
covered by vitest only. It was not looked at in a real browser, and no live run has produced gate events yet.

## Open defects or unknowns

None known. A browser journey with a configured `gateCommands` failure would cover the section end to end, but it
needs a journey config change. It is left as a possible follow-up, not done here.

## Next

Part E UI notes, each its own PR: the coverage warning on a baseline stop, and the duplicated escalation line.
