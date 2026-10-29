# Brief smoke — result

**Status:** NOT RUN YET (operator-run: `! bash spikes/brief-smoke/run-brief-smoke.sh` in a real terminal)

## Run 1 — <date>
- Author model used (Claude / Codex), frontier cost shown:
- 1. No terminal refused, nothing imported? yes / no
- 2. Questions asked (count; were they one at a time, plain English, about backups, operator access and an example figure?):
- Did "skip" work? Did [c] change the draft as asked?
- Did the injection line in the notes have any effect? (expected: none)
- Any vague worked example reach you? (expected: none)
- 3. Version, policy line, `valid` output:
- 4. Ctrl-C exit code; `project show` said "unfinished"; carry-on worked; v2 written, v1 kept?
- 5. Example ids: did v2 keep v1's tags for unchanged examples, and give the new mileage examples new numbers?
- `policy.outbound` in the approved brief (expected `[]`: the notes say no outside company):
- Time for the whole sitting:

## Observations

## Operator follow-ups
1. Decide whether meeting notes with client staff names are acceptable in `notes/` (Contract 1 says no client data in the project folder; notes are requirements, not records). See the plan's open questions.
2. Real notes for the expenses tracker are needed for Plan 12.

## Follow-ups from the Plan 7 final review (2026-10-27)

- **Project lock, before any automatic starter (Plan 8).** Two narrow races remain in `src/factory/projectLock.js`: a third starter arriving in the instant between moving a dead lock aside and putting it back, and the gap between creating the lock file and writing the pid into it. Both are fine while the operator starts commands by hand. Close them (create the lock by writing a temp file and `link()`-ing it into place, or a `.takeover` sublock) before anything starts builds automatically. The comment near line 51 calls the third-starter case harmless; it is not. On a filesystem without hard links the put-back fails silently.
- After three failed takeovers the "busy" message can name a holder that was just found dead; "another job is starting" would be accurate.
- The notes-file size refusal says KB in 1024-byte units ("97 KB"); the prompt refusal uses 1000-byte units ("120 KB").
- Skipping every question in a sitting stops the sitting even if an earlier sitting answered one; the operator must answer one question to move on.
- The run status line flashes briefly after each brief prompt.
- The author role preset ("be decisive") pulls against the brief prompt ("ask, don't guess"). Check in this smoke whether the author asks enough questions; if not, give the brief its own preset.
- The Codex read-only sandbox still lets the author read files on this machine; a prompt injected through notes could pull one into the brief. Same posture as planning; consider tightening later.
