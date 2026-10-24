# CLI smoke — result

**Status:** RUN 2 PASSED (2026-10-24, real terminal via the Proxmox xterm.js console). The gate was answered by hand (`v`, then `a`) and the change landed on a branch. Run 1 (via `!`) had failed closed for lack of a TTY, as designed.

## Run 2 — 2026-10-24 (Proxmox xterm.js console, real TTY)
- The desktop worker on .109 was **not started** (operator forgot), so local was unreachable.
- Outcome: `landed` on branch `conductor/add-a-multiply-a-b-function-to-math-js-a` in the throwaway repo. The diff was correct: `multiply` plus 4 asserts.
- Elapsed: about 81 s.
- Timeline:
  - Plan: claude drafted it for about $0.23, and codex approved it.
  - Step 1: local failed at once with "not reachable". It went straight to the fallback with no retries (the dead-backend fix from Plan 2). Claude did the step for about $0.34, and codex approved it.
  - Final review: codex approved. The operator pressed `v`, then `a`, and the change landed.
- Total frontier cost reported: about $0.57.
- Confirmed: the gate's `v`/`a` work, a dead local backend fails over cleanly, and the run still lands.

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
- Cosmetic issues (both fixed after run 1):
  - The step line shows `? ✎ …` for a moment, before the editor is known. It now says `starting…`.
  - "What was done (1 steps)" should be singular for one step. It now is.
- Not yet checked:
  - Quota and sign-in detection against real CLI output. No limit was hit.
  - Ctrl-C followed by resume.

## Product follow-ups
- **Wake the workers before a run.** This was an operator request after run 2. The full product should remember which workers earlier runs used (for example the .109 desktop worker) and wake or start them before it begins, instead of silently falling back to a paid frontier model. At minimum, `doctor` and the start of a run should say plainly that local is down and offer to start it.

## Operator follow-ups (outside the code)
- Install bubblewrap on the host that runs Codex. Codex currently uses its bundled copy.
- Codex warns that model metadata for `shingon-qwen3.8-27b-q4` is missing. `contextWindow`
  already sets the window; check whether the warning still matters.
- Packaging for others is out of scope: **notify the operator before going live as a product**.
