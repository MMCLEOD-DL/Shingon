# Conductor Plan 3 — Routing, Fallback & the `conductor` Command

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** Make Conductor something a non-technical user can run: `conductor "add X"` inside a repo. They see live plain-English status, answer escalations and the final gate at the terminal, and can Ctrl-C and resume. When a model is unavailable, the run switches subscriptions, then uses paid API only if allowed, then pauses. It never silently stalls.

**Architecture:**
- **Routing.**
  - Every team slot (author, reviewer, local) becomes a `Seat`: a Participant-compatible wrapper over an ordered list of candidates sharing one `HealthBoard`.
  - When a call fails with an infrastructure error, the Seat marks that candidate down (or cooling, for rate limits) and tries the next. If nothing is left, it returns a `no-participant` failure, and the run turns that into a resumable `paused` status.
  - `buildTeam` runs health probes up front, picks preferred participants of different vendors, and builds the Seats. It reports degradation as plain-English warnings that end up in the final summary.
- **Terminal.**
  - A pure `StatusModel` folds the existing transcript events into the status block.
  - A `Terminal` object implements the Plan 2 hooks (`onEvent`, `escalate`, `approveResult`, `approveChunk`) over injectable streams.
  - `bin/conductor.js` wires config → team → `runTask`/`resume` → terminal.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`, `git` CLI, global `fetch` (Node 20) for API adapters and the local health probe.

**Spec:** `docs/superpowers/specs/2026-10-18-conductor-mvp-design.md`:
- §4: ApiAdapter, health-check + fallback.
- §7: routing, fallback ladder, two-vendor rule, budget awareness.
- §8: terminal interface.
- Plus the open follow-ups in `spikes/loop-smoke/RESULT.md`.

Plans 1–2 are merged (master `179c675`) and provide:
- the Participants and adapters;
- `runTask`/`resume` with hooks;
- `reviewLoop`, `RunLog` events, `Workspace`;
- secrets scrubbing/redaction;
- `summarizeFailure`, `isInfrastructureFailure`, `classifyFailure`, `checkHealth`.

## Rulings made while scoping (decided, not open)

1. **API fallback is opt-in.**
   - API participants are used only when the config sets `routing.allowApi: true` and their key env var is set.
   - The first paid call of a run emits `api-in-use`, and the final summary always states paid API use.
   - Why: spec §7 says the API is "a fallback, never the default". A non-technical user must never be billed by surprise.
2. **API participants are text-only.** They can serve `author` and `reviewer` calls with `write: false` (plan drafting, plan/chunk/final review), never a file-editing call. Why: spec §4 Capabilities.
3. **Seat candidate order follows the spec ladder literally:** preferred subscription → other subscriptions → APIs (same vendor as the preferred one first).
   - `routing.preferTwoVendors: true` puts an other-vendor API ahead of a same-vendor subscription in the reviewer seat.
   - Why: subscription first is the cost rule. Two-vendor preference is the user's opt-in trade.
4. **Pause = a new resumable run status `paused`.** It is used when a non-local Seat has nothing left. It is never used for the local model: local down means the frontier takes the step (spec §7 "Local branch"), unless `routing.localDown: "pause"`.
5. **Ctrl-C exits immediately (code 130).** It kills child processes, logs `interrupted`, and leaves `status: running`, so `conductor resume` continues from the last finished step. Why: Plan 2's resume already resets half-done steps. Making the loop abort-aware would touch every phase for no gain.
6. **No terminal = fail closed.** With no TTY, every escalation and the final gate answer "reject", and the user is told why.
7. **The local health probe is a 1-token chat completion against the local model.** Why: LocalAI's `/models` answers even when the worker is down (finding F-A5, and loop smoke run 1). The call is free because it runs locally.
8. **Out of scope:** packaging/installer (gated: **notify the operator before going live as a product**), GUI, budget dashboard, bubblewrap install and Codex model metadata (operator host tasks, noted in Task 11's RESULT template).

## Global Constraints

- Node ≥ 20, ESM (`"type": "module"`), **no npm dependencies**; tests run with `npm test` (`node --test`). Tests never make network calls outside `127.0.0.1`.
- **Real repository:** never modified except by `land()`, which only creates a **new** branch.
- **Credentials:**
  - No credentials or key values appear in prompts, transcripts, state files, terminal output or test output.
  - API keys are read from env vars named in config and sent only in the request header to that participant's `baseUrl`.
  - Error text from an API is passed through `redact()` before it leaves the adapter.
- **Fail closed:**
  - A missing or failed review is BLOCK.
  - A missing or unreadable user answer is reject.
  - Only `approveResult` returning exactly `true` lands.
- **Two-vendor rule:**
  - Author and reviewer Seats prefer different vendors (`vendorOf`).
  - A same-vendor run is allowed only when `buildTeam` sets `allowSameVendor`, and then the summary carries `SAME_VENDOR_WARNING`.
- **Plain English:** the user is asked only about outcomes and trade-offs, never technical correctness. Every user-facing string is plain English with no stack traces.
- **Reuse:** existing event names and Plan 2 behaviour stay as they are; this plan only adds fields and events. The existing test suite (289 tests) must stay green at every commit.

## Review Focus

1. **Ctrl-C in the middle of a step:**
   - The process exits 130, the run state stays resumable, nothing partial is committed, and the real repo is untouched.
   - `conductor runs` lists the run, and `conductor resume` picks it up.
   - Pinned in Task 10.
2. **Both subscriptions rate-limited mid-run (and no API allowed):**
   - The Seat waits once for the shortest cooldown (≤ `maxWaitMs`), then the run ends `paused` with a "resume when available" reason.
   - It never hangs, never lands and never counts as a deadlock.
   - Pinned in Tasks 4 and 6.
3. **stdin is not a terminal (piped, cron, CI):** every escalation and the gate fail closed to reject, the user is told why, and nothing lands. Pinned in Task 9.
4. **Only one frontier vendor healthy:** the run proceeds with the same vendor in both seats, and the final summary says the cross-checking is weaker. Pinned in Tasks 5 and 7.
5. **An API error body echoes the key** (a proxy that reflects headers): the key never appears in the result, transcript or screen. Pinned in Task 2.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/health.js`, `src/adapters/codex.js`, `src/adapters/claudeCode.js`, `src/chunkPhase.js`, `src/options.js` (modify) | timeout / context-overflow failure kinds; `localTimeoutMs`; local gives up early | 1 |
| `src/vendors.js` | `vendorOf`, `isApiKind`, `isSubscriptionKind` | 2 |
| `src/adapters/api.js` | `AnthropicApiAdapter`, `OpenAiApiAdapter` (fetch, text-only) | 2 |
| `src/config.js` (modify) | build API adapters; `routing` and `options` sections | 2 |
| `src/health.js`, `src/adapters/localAgent.js` (modify) | `checkHealth` uses `adapter.probe`; local 1-token probe | 3 |
| `src/router.js` | `HealthBoard`, `Seat` (fallback ladder) | 4 |
| `src/team.js` | `buildTeam` (preflight, preference, degradation warnings) | 5 |
| `src/conductor.js` (modify) | `validateTeam` vendor rule + `allowSameVendor` | 5 |
| `src/review.js`, `src/planPhase.js`, `src/chunkPhase.js`, `src/conductor.js`, `src/runlog.js` (modify) | `paused` status, usage totals, seat binding, run warnings | 6 |
| same files + `src/askUser.js`, `src/escalation.js` (modify) | same-vendor flag, real producer in notes, `plan-agreed`, chunk files/diff, gate note | 7 |
| `src/ui/status.js` | pure `StatusModel` (events → status lines) | 8 |
| `src/ui/terminal.js` | live redraw + escalation/gate/chunk prompts, fail-closed without a TTY | 9 |
| `src/cli/args.js`, `src/cli/runs.js`, `src/exec.js` (modify), `bin/conductor.js`, `package.json` | the command, config discovery, run listing, Ctrl-C | 10 |
| `README.md`, `spikes/cli-smoke/` | user docs; operator-run smoke of the real command | 11 |

## Tasks

1. [Local failure kinds](task-01-local-failures.md)
2. [Vendors & API adapters](task-02-api-adapters.md)
3. [Health probes](task-03-health-probes.md)
4. [Seat & fallback ladder](task-04-seat.md)
5. [buildTeam & two-vendor degradation](task-05-build-team.md)
6. [Pause, usage & run warnings](task-06-pause-usage.md)
7. [Vendor tracking, UI events & gate note](task-07-ui-events.md)
8. [Status view model](task-08-status-view.md)
9. [Terminal hooks](task-09-terminal.md)
10. [The `conductor` command](task-10-cli.md)
11. [Docs & operator CLI smoke](task-11-docs-smoke.md)

Order matters: 4 needs 1–3; 5 needs 4; 6–7 need 4–5; 9 needs 8; 10 needs 5–9.

## Shared Interfaces (all tasks)

```js
// Task 1 — result.failure kinds (adapters):
//   'infrastructure' | 'timeout' | 'context-overflow' | null; Seat adds 'no-participant' (Task 4)
isContextOverflow(text) -> boolean                      // src/health.js
DEFAULT_OPTIONS.localTimeoutMs = 900000                  // local grunt calls; frontier keeps agentTimeoutMs
LOCAL_FATAL = new Set(['infrastructure', 'timeout', 'context-overflow', 'no-participant'])  // src/chunkPhase.js

// Task 2
vendorOf(kind) -> 'anthropic' | 'openai' | 'local' | kind
isApiKind(kind) -> boolean; isSubscriptionKind(kind) -> boolean
new AnthropicApiAdapter({ model, envKey = 'ANTHROPIC_API_KEY', baseUrl = 'https://api.anthropic.com', timeoutMs = 300000, maxTokens = 8192, prices = null })
new OpenAiApiAdapter({ model, envKey = 'OPENAI_API_KEY', baseUrl = 'https://api.openai.com/v1', timeoutMs = 300000, maxTokens = 8192, prices = null })
  // .kind 'anthropic-api' | 'openai-api'; .run(role, task, context, opts) -> Result; .probe() -> { ok, reason }
  // prices: { inputPerMTok, outputPerMTok } (USD) -> usage.costUsd, else null
loadConfig(file) -> { participants, byName, routing, options }   // routing/options default {}

// Task 3
checkHealth(adapter, { timeoutMs }) -> { ok, reason }   // adapter.probe(opts) when present, else `<bin> --version`
localAgent.probe({ timeoutMs = 60000 }) -> { ok, reason } // reason: '' | 'unavailable' | 'unauthorized' | 'model-missing'

// Task 4 — src/router.js
new HealthBoard({ now = Date.now })
  .markDown(name, reason); .cool(name, reason, ms); .state(name) -> { status: 'ok'|'down'|'cooling', reason, until }
new Seat({ name, candidates, board, cooldownMs = 60000, maxWaitMs = 300000, sleep })
  // Participant-compatible: .name .roles .capabilities .adapter.kind .canPlay(role) .run(role, task, context, opts)
  // .bind(emit) where emit(type, data) logs an event
  // result extras: .servedBy (candidate name), .servedKind (candidate adapter kind)
  // events: 'route-failover' {seat, from, reason, error}, 'route-wait' {seat, ms}, 'api-in-use' {seat, participant}
  // nothing left: makeResult({ ok:false, failure:'no-participant', error:'no AI model is available for <seat> (<name>: <reason>; …)' })

// Task 5 — src/team.js
await buildTeam(participants, { routing = {}, health = checkHealth, env = process.env, board, sleep })
  -> { ok: true, team: { author, reviewer, local } (Seats), warnings: string[], report, allowSameVendor }
  |  { ok: false, error: string, report }
  // report: [{ name, kind, ok, reason }]
SAME_VENDOR_WARNING, LOCAL_DOWN_WARNING, API_KEY_BILLING_WARNING   // exported strings
validateTeam(team, { allowSameVendor = false } = {})   // src/conductor.js; vendorOf replaces kind equality

// Task 6
reviewLoop -> status may be 'paused' (with lastReason) when a producer artifact has .pause or a review Result has failure 'no-participant'
runTask({ ..., warnings = [] }); resume({ ..., warnings = [] })
outcome.status may be 'paused' (resumable, like 'failed'); state.usage = { costUsd, apiCostUsd, apiCalls }
'call' event gains { write }; 'result' event gains { servedBy }

// Task 7
state.flags.sameVendor -> SAME_VENDOR_WARNING in the summary; event 'same-vendor-review' {phase, index, vendor}
event 'plan-agreed' { chunks: string[], rounds, author, reviewer }
event 'chunk-done' gains { files, diff? }   // diff (clipped 20000) only when options.watchDiffs
DEFAULT_OPTIONS.watchDiffs = false
approveResult may return { approved: false, note } -> outcome { status:'rejected', note }; event 'gate-note'
escalation object gains { transcript }   // path, for "[s] see details"
DEFAULT_OPTIONS.approvePlan = false; hooks.approvePlan({ summary, steps, note }) -> exactly true continues, else 'stopped'

// Task 8 — src/ui/status.js
new StatusModel({ request }).apply(event) ; .lines() -> string[]

// Task 9 — src/ui/terminal.js
createTerminal({ input, output, isTTY, bell = true }) -> { onEvent, escalate, approveResult, approveChunk, approvePlan, say, close, model }

// Task 10
parseCli(argv) -> { command: 'run'|'resume'|'runs'|'doctor'|'help'|'version', request?, workspaceDir?, flags } | { error }
findConfig({ flag, cwd, env }) -> path   // throws a plain-English error listing the places looked
listRuns({ baseDir, repoDir }) -> [{ workspaceDir, request, status, phase, done, total, updatedAt }]
killAllChildren()   // src/exec.js
exit codes: landed 0 · rejected/stopped 1 · failed 2 · paused 3 · bad usage 64 · interrupted 130
```
