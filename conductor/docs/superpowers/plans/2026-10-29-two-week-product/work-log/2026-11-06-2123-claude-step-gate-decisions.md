# Claude: Malcolm's decisions GD1–GD3 on the step gate backlog

- **Packet:** P09 (next-phase backlog), item 6 in `conductor/docs/operator-app/next.md`. This entry follows `2026-11-06-2120-claude-step-gate-backlog.md`.
- **Decided by:** Malcolm in chat, on 6 November 2026. Claude recorded the decisions.
- **Branch:** `claude/blissful-cerf-6ew63e`, on the same PR (#113), which has not yet been merged.

## Decisions

- **GD1: every step keeps its frontier review.** The local simplifier (G5) only filters before that review; it never replaces it.
- **GD2: an opt-in `testFirst` option, off by default.** This was Claude's recommendation. It is now task G3b in `next.md`.
- **GD3: G1, the per-step report, goes before the expenses build.**

## Also noted

PR #85 (the Hoon design note, task 39) stays open on purpose. It is a speculative feature, and Malcolm will merge it once there is an MVP. Neither lane should treat it as waiting work.

## Evidence

The change is Markdown only. No tests were run.
