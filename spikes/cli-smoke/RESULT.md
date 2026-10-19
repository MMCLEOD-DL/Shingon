# CLI smoke — result

**Status:** RUN 1 PARTIAL. The whole loop worked on real models, but the gate failed closed because the run had no terminal (`!` gives no TTY). Gate not yet tested by hand: run 2 must be in a real terminal.

## Run 1 — 2026-10-19 (via `!`, no TTY)
- `doctor`:
  - ✓ claude installed
  - ✓ codex installed
  - ✓ local (1-token probe)
  - Team: author claude, reviewer codex, local local.
- Outcome:
  - Exit 1, `rejected`, with the message "There is no terminal to ask you…". No branch was created and the real repo is unchanged.
  - This is correct fail-closed behaviour (Ruling 6, Review Focus 3), confirmed live.
- Elapsed: about 62 s.
- Steps: 1 of 1 done by local, approved by codex on the first round. No fallback.
- Calls: 5 in total.
  - Plan: claude drafted it for about $0.30, and codex approved it.
  - Step: local did it, and codex approved it.
  - Final review: codex approved.
- No route-failover, route-wait or api-in-use events. No key strings appear in the transcript.

## Observations
- The live status read clearly, with no raw model chatter. Without a TTY, every redraw is appended instead of replacing the last one, so the cost line repeats. That is expected for non-TTY output.
- Cosmetic issues:
  - The step line shows `? ✎ …` for a moment, before the editor is known.
  - "What was done (1 steps)" should be singular for one step.
- Not yet checked:
  - Whether `v` shows the diff and `a` lands a branch. This needs a real terminal.
  - Quota and sign-in detection against real CLI output. No limit was hit.
  - Ctrl-C followed by resume.

## Operator follow-ups (outside the code)
- Install bubblewrap on the host that runs Codex. Codex currently uses its bundled copy.
- Codex warns that model metadata for `shingon-qwen3.8-27b-q4` is missing. `contextWindow`
  already sets the window; check whether the warning still matters.
- Packaging for others is out of scope: **notify the operator before going live as a product**.
