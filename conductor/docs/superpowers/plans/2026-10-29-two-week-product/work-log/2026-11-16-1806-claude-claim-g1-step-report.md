# Claude claim: G1, the per-step report from run logs

```
Packet/subpacket: P09 next-phase item 6, task G1 (conductor/docs/operator-app/next.md). Owner Claude per next.md; GD3 puts it before the expenses build.
Owner and reviewer: Claude; Codex reviews.
Status: IN_PROGRESS. Packet rows in 04-work-log.md unchanged.
Baseline SHA: a3094d0 (PR119 merge). Branch: claude/brave-ride-tz7f25.
Owned files: new conductor/src/cli/report.js and conductor/test/report.test.js; conductor/docs/operator-app/next.md (G1 status).
Shared seams, named and minimal: conductor/src/cli/args.js (a `report` entry in SUBCOMMANDS, its USAGE line, a `--json` flag
  and the argument branch) and conductor/src/cli/main.js (one read-only dispatch branch beside `runs`, before config loading).
  No engine, runlog, service or workflow change. No high-risk path.
```

## What G1 is

A read-only command, `conductor report [<transcript or run dir>...] [--json]`, that reads run transcripts and prints,
for each step: who produced it; local attempts used; attempts blocked by tests and by a reviewer; whether the frontier
took over and why; frontier calls made; wall-clock time per call; and cost only where an adapter reported one ("not
reported", never 0). It prints a total across the runs given. No engine change.

## Facts the design rests on (from reading the engine at a3094d0)

- The transcript has no duration field: wall-clock is `result.ts - call.ts`, pairing a `call` with the next `result`
  of the same participant and role (calls are sequential).
- Only the Claude Code adapter sets `costUsd`; Codex and the local adapter give null. No tokens are logged.
- A step's local attempts are its `call` events with role `grunt`; frontier calls are roles `author` and `reviewer`.
  `chunk-tests-failed` replaces the reviewer call for that attempt. A reviewer block is a `reviewer` result whose
  verdict is not APPROVE. `chunk-fallback` carries the takeover reason; `chunk-done.by` names the producer.
- Finished runs are archived to `<base>/../logs/<taskId>.jsonl` without `state.json`, and `listRuns` lists unfinished
  runs only, so the report must accept both `*.conductor/transcript.jsonl` and `logs/*.jsonl`.
- Transcript lines are redacted when written; the report prints counts, names and times, and clips any excerpt.

Not in scope: G2–G5, any change to what the engine logs, the operator app.
