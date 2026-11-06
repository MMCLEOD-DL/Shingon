# Claude: step gate and local simplifier added to the next-phase backlog

- **Packet:** P09 (next-phase backlog). This is a documentation change only. It changes no code or configuration and touches no high-risk path.
- **Owner and reviewer:** Claude; Codex reviews; Malcolm prioritises.
- **Status:** IN_REVIEW. P09's row in `04-work-log.md` is unchanged.
- **Branch and baseline:** `claude/blissful-cerf-6ew63e` from `7b06f41`.
- **Requested by:** Malcolm, on 6 November 2026: "fold it into our working plan".
- **Source:** Library of Babel `shingon` project, "Shingon: Verifier and Simplifier/Reviewer agents (proposal, 6 Nov 2026)", `41417a83-3ae0-417a-a8bc-53d4e6936ced`. It was read-only; nothing was written back.

## What changed

There is a new section, `conductor/docs/operator-app/next.md` §6, plus a note in "Recommended order". The section records:
- what the engine already does: the test gate before rival review (PR #71), local and frontier round budgets, lean retries, and run-log events that carry the per-step data;
- what is missing;
- eight points where the plan departs from the proposal;
- tasks G1–G5 and one deferred item;
- decisions GD1–GD3 for Malcolm, and acceptance examples.

The main departures from the proposal:
- The local simplifier runs *before* the frontier step review and does not replace it (GD1).
- Measuring comes first: G1 builds a read-only per-step report from the existing run logs, with no engine change.
- Usage is counted as calls, time and allowance limits, because the Codex and local adapters report no tokens.
- A scope check flags files that were not listed, and fails only on protected paths.
- The gate's stages are commands configured per repository, not hardcoded Python tools.
- The name is "step gate", because "verify" already has two meanings in this repo.

## Evidence

- The claims about the engine were checked against the source at `7b06f41`:
  - `src/chunkPhase.js` (`review()`, `runChunkFrom` fallback reset);
  - `src/review.js`, `src/options.js`, `src/plan.js`, `src/prompts.js`;
  - `src/runlog.js` (`callRole`, `callAgent` usage);
  - `src/adapters/{codex,claudeCode,localAgent}.js`;
  - `src/factory/checks.js`, `src/council/foundationRules.js`.
- The #71 attribution comes from `git log -S chunk-tests-failed` (`c105e04`, merged in #71).
- No tests were run, because the change is Markdown only.

## Open questions

- GD1: should frontier review stay on every step?
- GD2: who writes the acceptance tests for new steps?
- GD3: should G1 go before the expenses build?

None of this enters the fortnight, because the feature freeze is at the end of 9 November.
