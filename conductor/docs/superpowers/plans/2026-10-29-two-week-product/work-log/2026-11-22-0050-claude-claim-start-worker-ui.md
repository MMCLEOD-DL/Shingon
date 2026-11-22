# Claude claim: the Start-the-local-worker page (next.md item 7, operator UI)

```
Packet/subpacket: P09 next.md item 7, proposals 2–6, operator page only
Owner and reviewer: Claude; Codex invited to review
Status: IN_PROGRESS
Baseline SHA: 142c002 (origin/main, PR162 merge)
Branch: claude/start-worker-ui
Owned paths: conductor/operator-web/src/** (RunView.jsx, Setup.jsx, text.js), conductor/operator-web/tests/**,
  conductor/operator-web/e2e/** if a journey state is added
Shared seams: none. No change to conductor/src, the service, the contract or its fixtures.
```

Codex's PR162 (merged) landed the contract, both fixture copies and the service, per Malcolm's W1–W8 decisions of
21 November 2026. This PR builds the page against those fixtures.

**Scope:**
- The `start-worker` choice on the pre-run fallback question.
- The page while a start runs (`starting`, `waiting`, `ready`), with no other answer offered during it.
- The failed state, showing the command's last lines, with only Pause and Use subscriptions offered.
- The timeout state, which offers Try again.
- The `worker-start-in-progress` refusal.
- Plain activity-log text for the worker events.
- A read-only "start command configured" line on the setup page.
- A fix so the page re-reads the run after a `local-worker-*` progress event. A failed or timed-out start sends only
  a progress event, so the page would otherwise keep showing "Starting…".

**Not in scope:**
- Any service or contract change.
- The mid-run question (W2).
- A setup-page start control (W1).
- The live check on Malcolm's PC.
