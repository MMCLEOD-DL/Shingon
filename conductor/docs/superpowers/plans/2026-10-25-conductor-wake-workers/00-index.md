# Conductor Plan 4 — Wake the Workers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** Before a run starts, Conductor checks the workers that do its local work, tries to wake any that are down, and, if one still cannot be reached, tells the operator plainly and **asks** before Claude or Codex take over its work. Subscription usage counts as money.

**Architecture:**
- **Worker memory.** A small JSON file next to the run workspaces records which participants actually served calls in earlier runs. Readiness checks those first. `doctor` shows when each was last used.
- **Wake config.** Each participant may carry a `wake` block: `warn` (the default: check it, and say what to do by hand), `wol` (send a Wake-on-LAN magic packet) or `command` (run an operator-supplied program, for example a restricted `ssh` that starts the worker). Config loading validates the block, and every participant always ends up with a normalized `wake`.
- **Readiness.** `ensureWorkers` probes each worker. For one that is down, it runs its wake mechanism and polls the probe until the worker answers or `waitMs` runs out. The results feed `buildTeam` through a cached health function, so nothing is probed twice.
- **Consent.** The new default `routing.localDown: "ask"` makes `buildTeam` report a down local model instead of quietly planning a frontier fallback. The CLI then asks: check (or wake) it again, go ahead on the subscription, or stop. Without a terminal it stops, and nothing is spent. If the local model goes down **mid-run**, the chunk phase asks once through a new hook. A hang or an unclassified local failure is re-probed first, so a worker that vanished mid-call is treated as down rather than silently covered. Declining pauses the run so it can be resumed, and the resume starts with the readiness check again.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`, `node:dgram` (Wake-on-LAN), the existing `runCommand`.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §4.2 "Workers are woken before a run starts" (the operator request and both [call]s under it);
- §8 item 1 "Wake workers and readiness".

Also read `spikes/cli-smoke/RESULT.md` → "Product follow-ups" (the run-2 finding this plan fixes) and `spikes/loop-smoke/RESULT.md` run 1. Plans 1–3 are merged (master `2f61dbd`, 405 tests).

## Rulings made while scoping (decided, not open)

1. **"Before any money is spent" includes subscriptions** (spec §4.2 [call]). When the local model is down, Conductor asks before Claude or Codex do its steps. This holds before the run and mid-run alike.
   - The new default is `routing.localDown: "ask"`.
   - `"frontier"` keeps today's no-questions fallback, as an explicit operator opt-in.
   - `"pause"` keeps today's refusal to start, and now also pauses a run mid-way instead of falling back.
2. **No terminal means stop.** With no TTY, the consent question answers "stop": the run does not start (exit 1), or it pauses mid-run (exit 3). The operator is told why. This matches Plan 3 Ruling 6 (fail closed).
3. **The default wake method is `warn`.** With no `wake` block, Conductor probes the worker and, if it is down, prints a plain-English hint about what to start by hand. Conductor never sends packets or runs programs unless the config asks for it.
4. **Wake mechanisms are config hooks.** This plan provisions **no** credentials, keys, accounts or remote endpoints. `wol` needs only a MAC address. `command` runs whatever program the operator writes into the config. That program gets a stripped environment plus only the env vars the block names, and its output is redacted. Setting either up on the real .109 desktop is an operator follow-up (Task 9).
5. **`doctor` wakes too.** `doctor` runs the same readiness step as a run, so "check which models are available" gives the answer a run would get. It never asks the consent question, because `doctor` spends nothing.
6. **Memory records servers, not jobs.** After every run that reached the agents, the participants that served at least one successful call are recorded with `kind`, `lastUsedAt` and `runs`. Memory only orders and annotates the checks. It never adds a participant the config does not have.
7. **LocalAI "no healthy nodes".** When LocalAI is up on CT110 but the .109 GPU worker is missing, the local probe gets HTTP 5xx with "no healthy nodes available". It now reports a distinct reason `worker-offline` ("its GPU worker is not connected"), so the operator learns which machine to start.
8. **Out of scope:**
   - provisioning WoL on .109 (BIOS/NIC settings, the MAC), a remote-start account or key, or a worker start script;
   - automatic LocalAI node approval;
   - Proxmox test machines (§4.7);
   - the council and every later factory phase.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**; `npm test` (`node --test`). Tests never use the network outside `127.0.0.1` (this includes UDP).
- **No surprise spend:** with `localDown` at its default (`"ask"`), no frontier call does a local step until the operator has said yes in this run. That covers both a pre-run fallback and a mid-run one. Only exactly `true` (hook) or `'frontier'` (pre-run choice) counts as yes.
- **Credentials:**
  - Wake-command env values never appear in config errors, events, transcripts, terminal output or test output.
  - Command output passes through `redact()` before use.
  - The command's child env is `strictChildEnv()` plus only the names listed in `wake.env`.
- **Plain English:** every new user-facing string names the machine or model, what Conductor tried, and what the operator can do. No stack traces, no HTTP jargon beyond what `REASON_TEXT` already uses.
- **No silent intermediate commit:** from the commit that flips the `localDown` default (Task 5) onward, no commit lets the subscription cover a down local model without a question or a warning. Task 5 adds an interim fail-closed stop to `src/cli/main.js`, which Task 8 replaces with the consent loop. Even so, **Tasks 5–8 ship together** (one merge of the plan branch): only with Task 8 does the operator get the question instead of a plain stop.
- **Reuse:** existing event names and behaviour stay unless a task says otherwise. The only intended behaviour change for existing users is the `localDown` default (`"frontier"` → `"ask"`). The suite (405 tests) stays green at every commit; any existing test that relied on the implicit `"frontier"` default is changed to pass `localDown: 'frontier'` explicitly.

## Review Focus

1. **The worker's machine is switched off**, so the probe hangs until its timeout instead of being refused. The whole wake wait still ends within `waitMs` plus one probe, with no 60 s × N overrun. Pinned in Task 4.
2. **`workers.json` is corrupt, unreadable or unwritable** (disk full, wrong owner). The run proceeds exactly as with no memory, and nothing throws. Pinned in Task 1.
3. **A remembered worker was renamed or removed from the config.** It is ignored: it is never probed, woken or shown as configured. Pinned in Task 1.
4. **The wake command hangs, fails, or prints a secret.** It is killed after its `timeoutMs`, the run carries on to the consent question, and the secret never reaches the screen or transcript. Pinned in Task 3.
5. **The operator declines mid-run, then resumes.** The workspace goes back to the step's base, the run is `paused` (exit 3), and `conductor resume` runs readiness again before continuing from the finished steps. Pinned in Tasks 7 and 8.
6. **"Carry on" really carries on.** The terminal answers `'frontier'`, the hook must turn that into exactly `true`; a pass-through would pause on every yes. Pinned by the mid-run "carry on" e2e test in Task 8.
7. **The local worker vanishes mid-call** (the call hangs until `timeout`). The chunk phase re-probes once before deciding; down means ask, up means the usual no-question fallback. Pinned in Task 7.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/workerMemory.js` | read/merge/write `workers.json`; usage tracker over run events; recall in config order | 1 |
| `src/wake.js` | `normalizeWake` (validation + defaults); WoL magic packet; wake command; `wakeWorker` | 2, 3 |
| `src/config.js`, `src/participant.js` (modify) | attach `wake` to every Participant; validate `routing.localDown` | 2 |
| `src/readiness.js` | `workersToCheck`, `ensureWorkers` (probe → wake → poll), `cachedHealth`, plain messages | 4 |
| `src/adapters/localAgent.js`, `src/router.js` (modify) | `worker-offline` probe reason and its plain text | 4 |
| `src/team.js` (modify) | `localDown: "ask"` default; `built.localDown` | 5 |
| `src/ui/terminal.js` (modify) | `confirmLocalFallback` prompt, fail-closed without a TTY | 6 |
| `src/chunkPhase.js`, `src/conductor.js`, `src/options.js` (modify) | mid-run consent hook; re-probe on an ambiguous local failure; pause on decline | 7 |
| `src/cli/main.js` (modify) | interim fail-closed stop (5); readiness before `buildTeam`, consent loop, doctor lines, remember after the run (8) | 5, 8 |
| `README.md`, `config.example.json`, `spikes/wake-smoke/` | user docs; operator-run smoke | 9 |

## Tasks

1. [Worker memory](task-01-worker-memory.md)
2. [Wake config](task-02-wake-config.md)
3. [Wake mechanisms](task-03-wake-mechanisms.md)
4. [Readiness: probe, wake, wait](task-04-readiness.md)
5. [buildTeam: ask before the frontier covers for local](task-05-team-ask.md)
6. [Terminal: the consent question](task-06-terminal-consent.md)
7. [Mid-run consent](task-07-midrun-consent.md)
8. [CLI wiring](task-08-cli.md)
9. [Docs & operator wake smoke](task-09-docs-smoke.md)

Order matters: 3 needs 2; 4 needs 1–3; 8 needs 1–7; 9 needs 8. Tasks 5, 6 and 7 are independent of each other and of 1–4 (Task 7 imports `LOCAL_DOWN_WARNING`, which already exists). Tasks 5–8 ship together (Global Constraints).

## Shared Interfaces (all tasks)

```js
// Task 1 — src/workerMemory.js
memoryFileFor(baseDir) -> path.join(baseDir, '.workers.json')
readWorkerMemory(file) -> { version: 1, workers: { [name]: { kind, lastUsedAt /* ms */, runs } } }   // missing/corrupt → empty
rememberWorkers(file, used /* [{ name, kind }] */, { now = Date.now } = {}) -> boolean        // never throws; removes its temp file on failure
recallWorkers(memory, participants) -> [{ participant, lastUsedAt }]   // configured only, newest first
createUsageTracker(byName /* Map name→Participant */) -> { onEvent(e), used() -> [{ name, kind }] }

// Task 2 — src/wake.js, Participant
normalizeWake(raw, participantName) -> Wake   // throws plain-English Error on bad config
// Wake = { method: 'warn'|'wol'|'command', hint, waitMs, pollMs,
//          mac?, broadcast?, port?,               // wol
//          cmd?, args?, env?, timeoutMs? }         // command
WAKE_DEFAULTS = { method: 'warn', waitMs: 180000, pollMs: 5000, broadcast: '255.255.255.255', port: 9, timeoutMs: 60000 }
DEFAULT_WAKE_HINT = 'Start the machine that runs this model, and its model server, then try again.'
participant.wake   // always a Wake (normalizeWake(spec.wake, name)), set by loadConfig
routing.localDown  // 'ask' | 'frontier' | 'pause' — loadConfig rejects anything else

// Task 3 — src/wake.js
magicPacket(mac) -> Buffer (102 bytes)
sendMagicPacket({ mac, broadcast, port }, { createSocket = dgram.createSocket } = {}) -> Promise<void>
runWakeCommand(wake, { run = runCommand, env = process.env } = {}) -> { ok, detail }
wakeWorker(participant, { send = sendMagicPacket, runCmd = runWakeCommand } = {}) -> { attempted, ok, detail }
WAKE_METHOD_TEXT = { warn: 'none set up', wol: 'Wake-on-LAN', command: 'its start command' }

// Task 4 — src/readiness.js
workersToCheck(participants, recalled, { local = null /* routing.local */ } = {}) -> Participant[]
// = remembered locals + remembered wakeable non-API/non-subscription participants (newest first), then the run's own local
await ensureWorkers(workers, { health = checkHealth, wake = wakeWorker, sleep, now = Date.now, onProgress = () => {} })
  -> WorkerStatus[]
// WorkerStatus = { name, kind, local /* can play grunt */, ok, reason, detail, woke: 'not-needed'|'not-configured'|'sent'|'failed', wakeDetail, waitedMs, hint, method }
// onProgress events: { type: 'waking', name, method } | { type: 'woke', name, waitedMs } | { type: 'still-down', name, waitedMs }
cachedHealth(statuses, workers, health = checkHealth) -> (adapter, opts) => Promise<{ ok, reason, detail? }>
downMessage(status) -> string   // 'The local model "<name>"…' or, for local:false, 'The worker "<name>"…'
progressText(event) -> string; workerLine(status, lastUsedAt) -> string
REASON_TEXT['worker-offline'] = 'its GPU worker is not connected'   // src/router.js
localAgent.probe(): 5xx whose body matches /no healthy nodes/i -> { ok:false, reason:'worker-offline', detail }

// Task 5 — src/team.js
ROUTING_DEFAULTS.localDown = 'ask'
buildTeam(...) -> { ok: true, team, warnings, report, allowSameVendor, localDown: null | { name, reason, detail } }
// 'ask' + local unhealthy: ok:true, localDown set, LOCAL_DOWN_WARNING NOT pushed (the CLI adds it after consent)
// src/cli/main.js (interim, Task 5 only): built.localDown on a run → plain message, exit 1

// Task 6 — src/ui/terminal.js
confirmLocalFallback({ message, midRun = false, method = 'warn' }) -> 'wait' | 'frontier' | 'stop'   // midRun: never 'wait'
// [w] label: warn → '[w] check again (after you have started it)'; wol/command → '[w] try to wake it again'
NO_TTY_LOCAL   // exported string

// Task 7
DEFAULT_OPTIONS.confirmLocalFallback = false
hooks.confirmLocalFallback({ index, title, reason }) -> exactly true continues; anything else pauses
//   an answer { reason: '<text>' } becomes the pause reason (else LOCAL_DECLINED_REASON)
LOCAL_UNREACHABLE = Set(['infrastructure', 'no-participant'])   // src/chunkPhase.js
// any other local failure except 'context-overflow' → checkHealth(local adapter, 60 s) once; down → ask; event 'local-recheck' { index, ok, reason }
// attempt artifact on a failed call: { …, localFailed, localFailure, localDown }
// runTask/resume throw 'hooks.confirmLocalFallback is required when confirmLocalFallback is set' if missing
state.flags.localFallbackOk = true after consent; events 'local-fallback-approved' { index }, 'local-fallback-declined' { index }
LOCAL_DECLINED_REASON, LOCAL_PAUSE_SETTING_REASON   // exported from src/chunkPhase.js

// Task 8 — src/cli/main.js
main(argv, { ..., wakeDeps = {} })   // wakeDeps passed through to ensureWorkers (tests inject sleep/now/wake)
STOPPED_BEFORE_START   // exported string; exit EXIT.stopped (1)
// hooks.confirmLocalFallback = localDown 'pause' ? async () => ({ reason: LOCAL_PAUSE_SETTING_REASON })
//   : async ({ index, title, reason }) => (await term.confirmLocalFallback({ message, midRun: true })) === 'frontier'
// rememberWorkers runs once: after runTask/resume return, when they throw, and in the Ctrl-C handler
```
