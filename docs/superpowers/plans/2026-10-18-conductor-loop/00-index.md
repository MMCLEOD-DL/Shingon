# Conductor Plan 2 — Workspace & Adversarial Loop

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** Turn the Plan 1 participants into a working end-to-end run: plan → adversarial plan review → per-chunk local execution with frontier checkpoint review → final review → approval → result lands as a new branch in the real repo.

**Architecture:** All work happens in a throwaway git clone (the Workspace). A single generic `reviewLoop` (produce → review → feedback, capped rounds, fails closed) drives the plan phase, each chunk, and the frontier fallback. Deadlocks are settled by evidence (tests) and an explicit `IRREVERSIBLE:` marker; anything that needs the user goes out through hooks as a plain-English recommendation. Run state and a transcript are persisted inside the workspace so a crashed run can resume.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`, `git` CLI.

**Spec:** `docs/superpowers/specs/2026-10-18-conductor-mvp-design.md` (§3, §5, §6). Plan 1 (merged, master `223989d`) provides `Participant`, the three adapters, `runCommand`, `normalize`, `makeResult`, `loadConfig`.

## Global Constraints

- Node ≥ 20, ESM (`"type": "module"`), **no npm dependencies**; tests run with `npm test` (`node --test`).
- The real repository is never modified except by `land()`, which only creates a **new** branch and never overwrites an existing one.
- Agents run with `cwd` = the workspace; write access only when the role needs it (local `workspace-write`, Claude `acceptEdits`).
- Workspace has **no git remotes**; every Conductor git call passes `-c core.hooksPath=/dev/null -c commit.gpgsign=false` and a fixed identity.
- Each chunk ends as exactly **one commit** on the workspace branch.
- A missing, malformed, or failed review is treated as **BLOCK** (fail closed).
- Two-vendor rule: the two frontier participants must use different adapter kinds.
- The user is only asked about outcomes/trade-offs, never technical correctness.
- No credentials or keys appear in prompts, transcripts, state files, or test output.
- No UI in this plan: user interaction is via hooks (`escalate`, `approveResult`, optional `approveChunk`, `onEvent`). Plan 3 wires the terminal UI to them.

## Review Focus

1. **Rejected run leaves the real repo untouched** — no new branches, refs, or files → pinned in Task 9.
2. **Reviewer reply with no `VERDICT:` line, or a crashed reviewer** → treated as BLOCK, never approval → pinned in Task 4.
3. **Agent crash/timeout mid-chunk** → workspace rolled back to the chunk's base, no partial commit; `resume` continues from the last good chunk → pinned in Tasks 8 and 9.
4. **`land()` when the target branch already exists** → refuses, existing branch unchanged → pinned in Task 2.
5. **Malformed plan (bad JSON, zero chunks, too many chunks)** → error fed back to the author as a round, never a crash → pinned in Tasks 3 and 7.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/adapters/*.js`, `src/participant.js`, `src/config.js` (modify) | run opts `{cwd, write, timeoutMs}` | 1 |
| `src/text.js` | `clip()` long text for prompts/logs | 2 |
| `src/workspace.js` | git clone, commit, diff, squash, reset, tests, land | 2 |
| `test/helpers/gitRepo.js` | build throwaway git repos in tests | 2 |
| `src/plan.js` | parse the author's plan JSON | 3 |
| `src/prompts.js` | every prompt string the loop sends | 3 |
| `src/review.js` | `verdictOf`, generic `reviewLoop` | 4 |
| `src/deadlock.js` | evidence-based deadlock settlement | 5 |
| `src/escalation.js` | plain-English escalation + final summary | 5 |
| `src/options.js` | `DEFAULT_OPTIONS` (round caps, timeouts, test command) | 6 |
| `src/runlog.js` | transcript JSONL, state save/load, safe `callRole` | 6 |
| `test/helpers/fakes.js` | scripted fake participants, `makeCtx` | 6 |
| `src/askUser.js` | the single fail-closed path to the user | 7 |
| `src/planPhase.js` | plan + plan review | 7 |
| `src/chunkPhase.js` | one chunk: local → review → fallback → deadlock | 8 |
| `src/conductor.js` | `runTask`, `resume`, team validation, defaults | 9 |
| `spikes/loop-smoke/` | operator-run real-CLI smoke test | 10 |

## Tasks

1. [Adapter run options](task-01-adapter-opts.md)
2. [Workspace](task-02-workspace.md)
3. [Plan parsing & prompts](task-03-plan-prompts.md)
4. [Review loop](task-04-review-loop.md)
5. [Deadlock & escalation](task-05-deadlock-escalation.md)
6. [Run log, state & safe calls](task-06-runlog.md)
7. [Plan phase](task-07-plan-phase.md)
8. [Chunk phase](task-08-chunk-phase.md)
9. [Conductor: runTask & resume](task-09-conductor.md)
10. [Real-CLI smoke spike](task-10-smoke.md)

## Shared Interfaces (all tasks)

```js
// Task 1
adapter.run(role, task, context = '', opts = {})   // opts: { cwd, write = false, timeoutMs }
participant.run(role, task, context = '', opts = {})

// Task 2
clip(text, max = 8000) -> string
defaultBaseDir(env) -> $XDG_STATE_HOME/conductor/workspaces | ~/.conductor/workspaces   // Workspace.create's default baseDir
class Workspace {
  static async create({ repoDir, baseDir, taskId }) -> Workspace
  static async open(dir) -> Workspace          // throws "<dir> is not a Conductor workspace"; branch null when detached
  source                                        // { sha, branch, dirty } of the real repo at create (m5)
  remove()                                      // deletes the workspace and its metaDir
  async currentBranch() / onOwnBranch() / assertOnBranch() / returnToBranch(sha)
  async snapshot() -> sha                       // commit of the worktree on HEAD; HEAD and index untouched
  async ignoredPaths() -> Set<string>
  baseSha                                       // clone-time HEAD (set by create; open reads <dir>.conductor/base)
  dir; branch; metaDir                          // metaDir = `${dir}.conductor`: base, state.json, transcript.jsonl, repo.json, git-config
  async head() -> sha
  async commitAll(message) -> sha | null
  async diff(fromSha) -> string                 // fromSha..worktree (uncommitted + untracked), via a scratch index
  async listFiles(fromSha) -> string[]
  async diffRange(fromSha, toSha) -> string     // commit-to-commit (--no-ext-diff --no-textconv)
  async filesRange(fromSha, toSha) -> string[]
  async isClean() -> boolean
  restoreConfigIfTampered() -> null | { expected, found }   // restores the sealed .git/config
  async checkRepo(repoDir) -> null | problem
  static async findBranchAt(repoDir, names, sha) -> name | null
  async squashSince(baseSha, message) -> sha | null
  async resetHard(sha, { keepIgnored })          // keepIgnored: Set from ignoredPaths(); other ignored paths are removed
  async runTests(command, { timeoutMs }) -> { ran, passed, code, output }
  async land({ repoDir, branch, sha }) -> { ok, branch, error }   // fetches into a temp ref, verifies == sha, create-only update-ref
}

// Task 3
parsePlan(text, { maxChunks }) -> { ok: true, plan: { summary, chunks: [{ title, instructions }] } } | { ok: false, error }
prompts: planAuthor, planReview, chunkExec, chunkReview, finalReview   // planAuthor/chunkExec take feedbackKind
// normalize(): the LAST VERDICT line of a reply wins (Ruling 12)

// Task 4
verdictOf(result) -> { decision: 'APPROVE' | 'BLOCK', reason, detail }   // detail = reviewer's full notes (clipped 6000)
reviewLoop({ produce, review, maxRounds }) -> { status: 'approved' | 'exhausted', artifact, lastGood, rounds, lastReason, history }
// produce(round, feedback, feedbackKind) -> artifact; an artifact with .error skips review and counts as a BLOCK round
// feedback = reason + "Reviewer's full notes"; feedbackKind = 'blocked' | 'failed' (null on round 1)
// review(artifact, round) -> Result; lastGood = most recent artifact without .error (or null)

// Task 5
settleDeadlock({ reason, tests, produced }) -> { action: 'accept' | 'escalate', situation, note, recommendation }
// situation: 'unproduced' | 'unreviewed' | 'tests-failing' | 'irreversible' | 'disagree'
buildEscalation({ kind, title, reason, recommendation, situation }) -> { kind, title, message, options }
buildSummary({ request, plan, notes, files, tests }) -> string

// Task 6
DEFAULT_OPTIONS (src/options.js)
class RunLog { constructor(metaDir, { onEvent }); event(type, data); saveState(state); loadState() -> state | null }   // metaDir = ws.metaDir
callRole(log, participant, role, task, context, opts) -> Result   // never throws
callAgent(ctx, participant, role, task, opts) -> Result         // callRole + restore a tampered .git/config (logs config-tampered)
// state = { version: 1, taskId, request, repoDir, phase: 'plan'|'chunks'|'final'|'done', plan, chunkIndex, chunkShas, notes, status, landing? }

// Task 7
askUser(ctx, { kind, title, reason, recommendation, situation }) -> 'approve' | 'reject'   // only exact 'approve' continues
runPlanPhase(ctx) -> { status: 'ok', plan, note } | { status: 'stopped' | 'failed', reason }

// Task 8
chunkRoles(index, team) -> { reviewer, fallback }
runChunk(ctx, chunk, index) -> { status: 'done', sha, note, tests } | { status: 'stopped' | 'failed', reason }   // failed = nothing usable produced; no question asked

// Task 9
DEFAULT_OPTIONS; validateTeam(team); validateHooks(hooks, options)
// hooks: escalate(esc) -> 'approve'|'reject'; approveResult({ summary, files, tests, finalReview, diff }) -> true lands;
//        approveChunk({ index, title, total }) -> true continues (needed if approveEachChunk); onEvent(entry)
runTask({ repoDir, request, team, hooks, options, baseDir }) -> RunOutcome
resume({ workspaceDir, repoDir, team, hooks, options }) -> RunOutcome   // repoDir required; must match the run's recorded repo
// RunOutcome: { status: 'landed' | 'rejected' | 'stopped' | 'failed', branch?, reason?, workspaceDir }

// ctx object passed to phases (built in Task 9; Task 7/8 tests build it via test/helpers/fakes.js makeCtx)
ctx = { request, team: { author, reviewer, local }, hooks, options, ws, log, state }

// Final-review fixes (C1): src/secrets.js
SCRUB_ENV; childEnv({ allow }) -> env      // parent env minus SCRUB_ENV keys; runCommand's default env
secretValues(env) -> string[]; redact(x) -> x   // deep-walk; applied to events, state, prompts (callRole), escalations, hook payloads, outcomes
new LocalAgentAdapter({ ..., envKey = 'LOCALAI_API_KEY' })   // only the local Codex harness gets envKey
```
