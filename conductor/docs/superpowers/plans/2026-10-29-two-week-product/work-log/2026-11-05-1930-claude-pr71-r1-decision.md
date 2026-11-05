# Malcolm's decision on PR71 R1: check the tests once at the start, and stop if they already fail

```
Packet/subpacket: P07/P08 follow-up to PR71 (F8), finding R1 in reviews/2026-11-05-claude-review-PR71-failed-tests-block-step.md.
Recorded by: Claude, from Malcolm's message in chat on 5 November 2026 ("Option 1 for PR71").
Owner of the change: Codex (engine). Reviewer: Claude.
Status: decision recorded; implementation NOT_STARTED.
Baseline SHA: 6f636ac.
```

## The decision

Option 1 from the review. When a run starts, Conductor runs the configured test command once on the base commit and
records the result. If the tests already fail:

- the run stops **before any work starts**: no local, subscription or review call is made;
- the operator is told the tests already fail before any change, and that they need fixing first;
- the run is not continued against a failing baseline. Option 2 (compare each step against the baseline) is **not**
  chosen: matching on exit codes alone is too weak, and per-test comparison would need a test-output format.

The R1 review notes still apply:
- N1: once the start check exists, "Your previous attempt's tests failed before review" is accurate.
- N2: a test command that cannot start (for example `npm` not on PATH) fails the start check, so it is caught at
  the start rather than at every step.

## What the change should show (for Codex's PR)

- The R1 reproduction (`reviews/fixtures/pr71-baseline-failing-tests.mjs`) on the change: status stops at the start,
  with 0 local, 0 subscription-author and 0 rival-review calls, and one operator-facing stop, not an `escalate`.
- A passing baseline still runs normally, and F8 still blocks a step whose **new** failure the producer caused.
- No configured test command (`ran: false`): no start check, unchanged behaviour.
- Resume after the operator fixes the tests: the start check runs again rather than trusting the earlier result.
- The UI wording for the new stop, if it needs a new event or question kind, comes to Claude as a UI follow-up.

## Not decided here

- Whether the operator can deliberately override a failing baseline. Not asked for, so it is not offered.
- Factory and change entry points: the review covered ordinary runs only. Codex should state in the PR whether they share
  the start check.
