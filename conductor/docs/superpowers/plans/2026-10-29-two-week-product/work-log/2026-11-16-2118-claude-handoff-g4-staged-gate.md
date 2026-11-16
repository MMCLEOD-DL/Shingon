# Claude handoff: G4, the staged step gate and the scope flag

```
Packet/subpacket: P09 next-phase item 6, task G4 (GD4). Follows work-log/2026-11-16-21*-claude-claim-g4-staged-gate.md.
Owner and reviewer: Claude; Codex reviews the four seam files.
Status: IN_REVIEW. Packet rows in 04-work-log.md unchanged; next.md G4 carries a "Done" note.
Baseline SHA: 159cdd3 (PR123 merge). Branch: claude/brave-ride-tz7f25. Code commit: f9051b9.
Shared seams changed: conductor/src/options.js (+1: `gateCommands: []`), conductor/src/chunkPhase.js (+80/-8: `gateExcerpt`,
  `validateGateCommands`, `runGate`, the scope and protected checks, stage-aware block reasons), conductor/src/prompts.js (+4/-1:
  `chunkReview` flag line), conductor/src/council/foundationRules.js (+4/-1: `isProtectedPath` exported and used by the existing
  check; no rule change). Tests: test/step-gate.test.js (new, 12 tests). conductor.js, runlog.js, workspace.js, review.js, service: untouched.
Contract version: none. New events: `gate`, `scope-flag`, `protected-path`. The operator service does not render them yet.
```

## What now works

- `gateCommands` (config option, default none): each attempt runs them in order before the step's `check` (G3) and the suite.
  The first failure ends the gate; its output is trimmed by a fixed rule (from two lines before the first line that looks like
  a failure, at most 3,000 characters; no model) and the attempt is blocked with "The step gate failed at stage \"<name>\"; fix
  it before review." plus the excerpt. No reviewer call is made. One `gate` event per attempt:
  `{ index, attempt, of, result, failedStage, excerpt }`.
- After an attempt passes the gate, the check and the suite (or when no tests are configured), the files it touched are
  listed. Files outside the step's `files` are flagged in the reviewer's prompt ("Files outside the expected set (a flag, not a
  failure): …") and logged as `scope-flag`; they never fail the step on their own. A touched protected path blocks the attempt
  before review and is logged as `protected-path`, **on factory builds only** (`options.factoryFeature`), the same gate the
  council's Foundation member applies.
- Runs without `gateCommands` and steps without `files` behave exactly as before; invalid `gateCommands` fail fast at the start
  of the step with one plain message.

## Two corrections made during review, both now tested

1. The scope and protected checks first ran only when tests had run; a run with no test command would never have blocked a
   protected edit at step level. They now run whenever the attempt was not already blocked. The test stub had hidden this by
   answering `ran: true` for a null command; it now mirrors `ws.runTests`.
2. The protected-path block first applied to every run. The Foundation lists include generic names (`modules/`,
   `foundation.json`), so an ordinary repository would have been blocked at every step. It is now gated on
   `options.factoryFeature`, as the council is.

## Checks (cloud Linux, Node 22.23.4, from `conductor/`)

- Test-first: the new test file failed to load before the source change (missing export); each correction's test shown
  failing before its fix (11 of 12 pass, then 12 of 12).
- Focused, 11 files: **212 pass, 0 fail**.
- **Full suite** `XDG_CACHE_HOME=/root/.cache node --test --test-concurrency=4`: **1716 tests, 1712 pass, 0 fail, 4 skipped**.
- Acceptance "G4, stage order": lint then types with a type error: `gate` says `failedStage: "types"`, the suite and step check
  do not run, no reviewer call, the retry prompt holds the trimmed excerpt and not the noise before it.
- Acceptance "G4, scope": `files: [src/a.js]`, attempt also edits `src/b.js`: the reviewer's prompt flags `src/b.js`; the step
  lands. A protected edit on a factory build is blocked with zero reviewer calls; the same edit on an ordinary run is not.

## Live / fake / skipped / unrun

Fake participants and stubbed commands. Not run: a live run with real gate commands, native Windows.

## Open defects or unknowns

- The gate failure's retry text reuses the tests-failed wording ("Tests: FAILED (exit N)" above the gate excerpt). Accurate
  enough; a dedicated wording is a small follow-up if the numbers show gates failing often.
- `gate`, `scope-flag` and `protected-path` events are not yet shown by the operator service or app: **Codex handoff**
  (`runs.js` projection), then a Claude UI follow-up.

## External blocker and exact owner/action

None. Not a high-risk path; needs Malcolm's merge (auto-merge is off). Codex review invited at f9051b9.

## Next packet unblocked

GD4 is complete with this PR. G3b (opt-in `testFirst`) and G5 wait on their own decisions and on G1's numbers.
