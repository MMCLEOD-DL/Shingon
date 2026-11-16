# Claude handoff: G1, `conductor report`

```
Packet/subpacket: P09 next-phase item 6, task G1. Follows work-log/2026-11-16-18*-claude-claim-g1-step-report.md.
Owner and reviewer: Claude; Codex reviews (it owns the CLI service seams the command sits beside).
Status: IN_REVIEW. Packet rows in 04-work-log.md unchanged; next.md G1 carries a "Done" note.
Baseline SHA: a3094d0 (PR119 merge). Branch: claude/brave-ride-tz7f25. Code commit: ea96a4f.
Owned files: conductor/src/cli/report.js (new, 260 lines), conductor/test/report.test.js (new), conductor/README.md (one table row),
  conductor/docs/operator-app/next.md (G1 status).
Shared seams, as claimed: conductor/src/cli/args.js (+7: 'report' in SUBCOMMANDS, USAGE line, --json flag and guard, argument
  branch) and conductor/src/cli/main.js (+5: import and one dispatch branch before repoRoot, so the command works outside a
  repository and needs no config or model). No engine, runlog, service or workflow change. No high-risk path.
Contract version: none.
```

## What now works

`conductor report [<path>...] [--json]`. Paths may be a transcript file, a `*.conductor` directory or a workspace
directory; with none, every live transcript under the base directory plus archived finished runs in `<base>/logs`
(where `archive()` writes them) and `<base>/../logs`. Per step: producer, outcome (done, fallback-then-done,
deadlock:<action>, error, incomplete), local attempts, blocks by tests split local/frontier, blocks by reviewer, frontier
takeover and reason, frontier calls, each call's wall-clock (`result.ts - call.ts`, `n/a` when no result followed),
allowance-limit failures (`route-failover` with reason `rate-limit`, and failed results whose error classifies as one),
and cost. Cost prints `$x.xx (n calls reported, m not reported)` or exactly `not reported`; it is never `$0.00` for an
unreported figure. A `chunk` for an index already seen starts a new block marked resumed. Malformed transcript lines are
counted as warnings, not thrown. Output is passed through `redact` at print time.

## Checks (cloud Linux, Node 22.23.4)

From `conductor/`, each new test shown failing before its implementation (module missing, then one failing test for the
allowance addition):

- `node --test --test-concurrency=2 test/report.test.js test/cli.test.js test/cli-e2e.test.js test/runlog.test.js
  test/chunkPhase.test.js test/failed-tests-block-step.test.js`: **115 pass, 0 fail, 0 skipped**, exit 0 (report.test.js
  alone: 8). Orchestrator re-run of the first four files: 54 pass.
- Scenarios (a)–(c) use real transcripts written by `runChunk` with fake participants: G1's "a logged run" example
  (local, 3 attempts, 2 blocked by tests, no fallback, 1 frontier review call); a reviewer-driven fallback
  (fallback-then-done, produced by the author, takeover reason recorded); G1's "missing cost" example (Claude Code 0.12
  reported; a Codex-only run prints `not reported` and no `$`).
- Smoke: `conductor report` on an empty base directory prints "No run transcripts found." and exits 0; `--help` lists it.

## Live / fake / skipped / unrun

Fake transcripts and hand-written fixtures only. Not run: a report over a live run's transcript (none exists in this
container), the full Conductor suite (CI), native Windows.

## Open defects or unknowns

- Events after a step's `chunk` and before the next one are attributed to that step, so a limit failure during the
  council phase after the last step counts against the last step. Run-level counting applies only before the first
  step. Acceptable for a first report; a `phase` event could split them later.
- Codex and the local adapter report no cost, so totals will mostly read "not reported" until an adapter does.

## External blocker and exact owner/action

None. Needs Malcolm's merge (auto-merge is off). Codex's review is invited at ea96a4f for the two seam files.

## Next packet unblocked

G1's numbers from real runs (Malcolm's live runs, then `conductor report`) feed the G5 decision. G2–G4 wait for a
recorded seam note; nothing else in the Claude lane is queued.
