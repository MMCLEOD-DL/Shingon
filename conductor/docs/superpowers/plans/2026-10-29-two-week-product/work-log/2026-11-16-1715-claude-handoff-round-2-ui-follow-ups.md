# Claude handoff: round 2 operator app follow-ups, and the stop-before-work outcome

```
Packet/subpacket: P07 (operator app, Claude-owned UI). Follows work-log/2026-11-16-17*-claude-claim-round-2-ui-follow-ups.md.
Owner and reviewer: Claude; Codex reviews.
Status: IN_REVIEW. Packet rows in 04-work-log.md unchanged.
Baseline SHA: f77e85d (PR116 merge). Branch: claude/brave-ride-tz7f25. Code commit: c7fe4b2.
Owned files changed: conductor/operator-web/src/{text.js,views/RunView.jsx,views/Setup.jsx,components/Evidence.jsx},
  conductor/operator-web/tests/{fakeService.js,text.spec.js,views.spec.jsx}. No service, engine, contract-fixture or workflow change.
Contract version: none changed.
```

## What now works

1. **Stop before work is explained on the run page.** `finishReason(events)` in `text.js` returns the last `finished`
   event's message when it is a sentence rather than a status word. A paused run that cannot be resumed shows that
   sentence above the existing "Paused. It has no saved work to resume…" line. For Part E1 of the Windows round 2
   runbook the page therefore reads "The configured tests already fail or could not run before any changes. Fix the
   tests or test command, then start a new run. …" without opening the activity log. Other outcome boxes are unchanged.
2. **Finding 3:** the `authenticated` probe button on a `local-agent` participant reads "Check connection and key";
   subscription participants keep "Check sign-in". The notes list says both.
3. **Finding 4:** "Local model: not known yet" reads "no completed call yet".
4. **Finding 5:** the UI test harness (`tests/fakeService.js`) seeds the three History runs with distinct ids. The shared
   contract fixture is untouched and still identical to `conductor/test/fixtures/operator-app/contract-v1.json`.

## Checks (cloud Linux, Node 22.23.4, Playwright Chromium; synthetic only, no models)

From `conductor/operator-web`, each new test shown failing before its change and passing after:

- `npx vitest run`: **86 passed** (3 files; 78 before, 8 new), 0 failed, exit 0.
- `npm run build`: exit 0.
- `node e2e/journey.mjs`: **22, 6 and 4 passed**, exit 0.

The duplicate-key warning (finding 5) did not reproduce on Linux before the change; the new test asserts the seeded ids
are unique and that React logs no "same key" message.

## Live / fake / skipped / unrun

All fake. Not run: native Windows; the live Part E1 run that would show item 1 with real models (Malcolm's).

## Open defects or unknowns

- R1 from the PR116 review still stands: the baseline test *output* reaches neither the app nor the CLI. The service
  drops it from the progress event (Codex seam, `runs.js`). Item 1 shows the reason sentence only.
- The reason sentence says "See the run transcript for the test output", which the app cannot show. Codex's wording.

## External blocker and exact owner/action

None for this PR. No high-risk path; it needs Malcolm's merge because auto-merge is not enabled on the repository.

## Next packet unblocked

G1 (per-step report from run logs), Claude-owned, decided GD3.
