# Conductor — MVP Design Spec

- **Date:** 2026-10-18
- **Status:** Draft for review
- **Working name:** Conductor (provisional)
- **Author:** drafted with Claude Code (Opus 4.8), with Malcolm McLeod

---

## 1. Purpose and intent

Conductor is a **downloadable program** people run on their own machine to coordinate work
between **local** and **frontier** AI models. Rival frontier models (via the user's own
Claude and Codex subscriptions) **collaborate and adversarially review** each other's and a
local model's work; grunt work is pushed to a **supervised local coding agent** so the
expensive frontier budget is spent on judgment, not typing.

The headline value is **quality through models checking each other** — the adversarial
process stands in for the senior-engineer review that a non-technical user cannot provide
themselves. Freeing up frontier budget is the enabler, not the primary goal.

It is **not** a hosted platform: single-user, self-hosted, bring-your-own-models. Day one it
is for the author's own use; if it proves useful, it is packaged for others to download.

### Who it is for and success criteria
- **Primary user (day one):** the author — **largely non-technical**. Therefore the models
  own design and architecture; the user states intent and approves outcomes, never technical
  correctness.
- **Primary workflow:** *"implement feature X in this repo."*
- **Success / win condition:** a better-quality result than a single frontier agent working
  alone, produced by the adversarial process, with the local agent absorbing enough grunt work
  that the frontier budget is reserved for decisions and review.

### Economic reality this design must manage
Two frontier vendors cross-reviewing **costs more frontier usage per task than one model
alone.** The thesis holds only if (a) the local agent carries enough of the work, and (b)
adversarial rounds are capped (disagree-and-commit is a cost control as well as a quality one).

---

## 2. Scope

**In scope (MVP):**
- One task type: *implement feature X* in a given git repo.
- Participants: the user's local coding agent + Claude Code + Codex.
- The adversarial plan → chunk → execute → checkpoint-review loop.
- Git-based isolated workspace and an approval gate.
- Escalation to the user as short written recommendations.
- Terminal interface.
- Hardcoded/declarative routing (subscriptions first, local for grunt, API fallback).

**Out of scope (deferred):**
- Graphical UI (the user wants a nicer UI eventually; terminal is fine for MVP).
- Multi-user, accounts, hosting.
- Packaging/installer for public distribution.
- Budget dashboards / usage optimization.
- Provider auto-discovery.
- Parallel/concurrent tasks.

---

## 3. Architecture overview

Four components, each with one job:

- **Conductor** — the brain. Runs the loop, tracks state, enforces the resolution rules,
  decides when to escalate.
- **Participant** — a uniform wrapper so local agent, Claude Code, and Codex all present the
  same interface to the Conductor.
- **Workspace** — a throwaway git copy where all work happens; the real repo is untouched
  until the user approves.
- **Session** — the terminal front-end: takes the request, streams progress, shows written
  recommendations, collects approvals.

### Life of one task
```
You ──"add CSV export to the reports page"──▶ Conductor
  1. PLAN              frontier author drafts plan + ordered chunk list
  2. PLAN REVIEW       rival frontier reviews; converge & commit, or escalate (written rec)
  3..N  PER CHUNK:     local agent EXECUTES → frontier CHECKPOINT-REVIEWS the diff
                       (blocking fix loop, capped; deadlock → evidence → escalate)
  final REVIEW         whole-branch adversarial review
  GATE                 you see plain-English summary (+ diff on request) → approve/reject
```

**Key safety property:** nothing reaches the real repo without the final gate, and the user is
interrupted mid-flight only for a genuine escalation (a written recommendation), never a
technical question.

---

## 4. Participant abstraction

Every model is wrapped behind one shared contract:

```
Participant.run(role, task, context) -> Result { text, diff?, verdict?, usage, ok }
```

### Adapters
| Adapter | Driven by | Natural roles |
|---|---|---|
| **ClaudeCodeAdapter** | `claude -p --output-format json` (+ role via `--append-system-prompt`, optional `--json-schema`) | author / reviewer |
| **CodexAdapter** | `codex exec -o <file>` and `codex review` | author / reviewer |
| **LocalAgentAdapter** | the **Codex CLI harness pointed at the local model** (custom `model_providers` in `~/.codex/config.toml`, `base_url` → LocalAI `/v1`, `wire_api = "chat"`; `codex exec -c model_provider=localai -c model=<local-model>`) | chunk execution (grunt) |
| **ApiAdapter** (fallback) | Anthropic / OpenAI API directly | any role when a subscription is unavailable |

**Harness unification:** the Codex CLI is the single agent harness, used two ways — Codex on the
ChatGPT subscription (frontier), and the same harness pointed at the local model (local agent).
LocalAgentAdapter and CodexAdapter are therefore nearly one driver differing only by
provider/model config. Claude Code is the other frontier participant. The harness stays
pluggable (if the local model drives Codex's protocol poorly, Codex natively supports
ollama/lmstudio as an alternative serving path).

### Roles
"Author," "Reviewer," and "Grunt/Executor" are system-prompt + expected-output-shape presets the
adapter injects. The same participant can be author in one step and reviewer in the next
(role rotation).

### Capabilities
Each Participant declares `is_agentic`, `can_edit_files`, etc. The Conductor assigns roles by
capability. All three primary participants are agentic (the local model is a first-class coding
agent via the Codex harness); plain chat/API participants that only emit text are restricted to
text-producing roles.

### Shared services every adapter runs through
- **Normalizer** — strips stray markdown fences, extracts the diff/verdict into the structured
  `Result`; the Conductor never trusts model formatting.
- **Health-check + fallback** — a cheap liveness check per adapter; on failure (expired token,
  CLI/backend version-skew, 401, rate-limit) the Conductor falls back per the routing policy.

### Configuration
"Bring your own models" lives in **one config file** listing which participants exist, their
adapter, model, and role-eligibility — the only thing a new user edits to point Conductor at
their own setup.

---

## 5. The adversarial loop

### Plan phase (adversarial)
A frontier **author** drafts a plan: architecture plus an **ordered list of small chunks**, each
sized for one reliable local-agent run. A rival frontier **reviewer** critiques it, raising
**blocking concerns only** (substantive, with a reason — not preferences). They converge and
commit, or the disagreement escalates to the user as a written recommendation.

### Per-chunk checkpoint cycle
For each chunk, in order:
1. **Execute** — the local agent (Codex→LocalAI) does the chunk: edits files, runs tests,
   produces a diff.
2. **Checkpoint review** — a frontier model (the one *not* supervising this chunk)
   adversarially reviews the diff + test results.
   - **Blocking issue** → local agent retries the fix, **capped rounds**.
     - If the chunk is **still too hard for local after the cap → escalate the chunk to a
       frontier agent to implement** (no dynamic re-chunking). It then rejoins the normal
       checkpoint review.
   - **Frontier-vs-frontier deadlock** → settle by **evidence first** (run the tests); then if
     the decision is **reversible**, pick and note it; if **irreversible**, **escalate to the
     user as a short written recommendation** (approve/choose).
   - **Clean** → commit the chunk, move to the next.

### After all chunks
A final whole-branch adversarial review, then the user gate (Section 6).

### Division of labor
- **Frontier = judgment & supervision:** architecture, chunking, checkpoint review, cross-chunk
  coherence, and the only thing that talks to the user. This is where frontier budget goes.
- **Local (via Codex harness) = execution:** the actual coding inside each bounded chunk —
  cheap, local, absorbing the grunt.
- **Adversarial everywhere:** the plan is cross-reviewed, and every chunk is cross-reviewed by
  the rival frontier vendor; roles rotate so neither frontier model is permanently in charge.

### Resolution model (summary)
Author decides / reviewer advises; block only for stated substantive reasons; disagree-and-commit
caps rounds; deadlock → evidence → reversible pick / irreversible escalate as a **written
recommendation**; roles rotate per task. The user decides **outcomes/trade-offs**, never
technical correctness.

---

## 6. Workspace and safety gate

**Governing rule:** all work happens in an isolated copy; the real repository is untouched until
the user approves.

- The real repo is cloned (or worktree'd) into a temporary **workspace**; agents operate only
  there.
- **Each chunk = one commit** on a feature branch. The checkpoint reviewer reads that commit's
  diff (both CLIs consume diffs natively; `codex review` reads the working-tree/diff). Rollback
  of a bad chunk is a single `git revert`.
- **History = audit trail.**
- **Crash-safe & resumable:** the workspace persists; both CLIs support session resume.

**Execution safety:**
- Agents are **sandboxed to the workspace** — Codex in `workspace-write` mode, Claude Code under
  matching permission limits. File edits and command/test runs are confined to the workspace;
  reach outside it and unrelated network/commands are gated.
- **The gate protects the non-technical user:** at the end they get a **plain-English summary**
  (what changed and why, files touched, test status), not raw code — unless they ask to see the
  diff. They approve outcomes, not syntax.
- **Approval granularity is configurable:** default one approval at the end; optionally approve
  each chunk.
- The approved result lands as a **separate branch** in the real repo, so even "approve" never
  clobbers the main code; the user merges when ready.

---

## 7. Routing and cost policy

Principle: **send each job to the cheapest capable resource; reserve frontier budget for
judgment.** MVP uses a declarative policy, not an optimizer.

### Default role → tier
| Work | Goes to |
|---|---|
| Chunk execution (coding) | Local agent (Codex→LocalAI) |
| Planning & architecture | Frontier (subscription) |
| Checkpoint & final review | Frontier (subscription), rotating vendors |
| Hard-chunk takeover | Frontier (subscription) |

### Preference within a tier
**Subscription first → API only when necessary.** The API key is a fallback, never the default.

### Fallback ladder
```
need a frontier turn
  ├─ preferred subscription healthy? ── yes ─▶ use it
  │     │ no (expired token / version-skew / 401 / 429)
  ├─ other subscription available & role allows? ── yes ─▶ use it
  │     │ no
  ├─ matching API key present? ── yes ─▶ use API (and notify user it now costs $)
  │     │ no
  └─ pause & notify user (never silently stall)
```
Local branch: local down → frontier covers grunt (degraded, pricier) or pause+notify.

### Two-vendor rule (adversarial requirement)
Real cross-review needs **two different vendors.** The router makes author and reviewer different
providers whenever possible. If only one frontier subscription is alive, it degrades gracefully
(API for the second opinion, or same-vendor review) **and flags to the user that the adversarial
value is reduced** this run.

### Budget awareness (minimal for MVP)
No dashboard. The router reacts to limit signals (repeated 429 / "limit reached" → back off →
switch subscription → API → pause) and logs the per-call cost/usage telemetry the CLIs return
(e.g. Claude's `total_cost_usd`/usage) so the data exists when budgeting is built later.

### Config-driven
All routing defaults are overridable in the config file: keep grunt local, never use API,
specific models per role, caps, etc.

---

## 8. Terminal interface

One command run inside the project; a clean, plain-English view — never raw model chatter.

**Start:**
```
$ conductor "add a CSV export button to the reports page"
```

**Live status** (updating; shows which model did what and whether each checkpoint passed):
```
  ✓ Plan agreed            Claude drafted · Codex reviewed (2 rounds)
  ✓ Chunk 1/4  export util   local ✎ · Codex reviewed ✓
  ⟳ Chunk 3/4  UI button     local ✎ … (running tests)
    Chunk 4/4  docs          queued
  frontier usage so far: ~$0.42 equiv · local chunks: 2
```
Code is shown only on request (`--watch-diffs`).

**The three stop points:**
1. **Plan approval** — optional, off by default.
2. **Escalation** — a short written recommendation: the decision, options with plain-English
   consequences, the system's recommendation, and a pick prompt (`[a] accept · [1] · [2] ·
   [s] see details`). Never a technical question.
3. **Final gate** — plain-English summary + `[v] view diff · [a] approve → branch · [r] reject ·
   [n] reject with a note`.

**Underneath:** a full transcript (every exchange, diff, decision) is written to a file (saved,
not shown). Runs are interruptible (Ctrl-C) and resumable. Because local chunks can be slow, it
pings the user (terminal bell / desktop notification) only when it needs them.

---

## 9. Key risks and build-time spikes

1. **Build-spike #1 (do first): Codex-on-LocalAI agentic execution.** Driving the local model
   through Codex's harness requires it to follow Codex's tool-call / `apply_patch` protocol well
   enough to edit files and run commands reliably. The model is known to do agentic work under
   another harness (Hermes); Codex's protocol is different and possibly stricter. Validate before
   leaning on the local agent. Fallback: serve the model via ollama/lmstudio (natively supported
   by Codex) instead of LocalAI.
2. **Output normalization.** Models ignore format instructions (observed: Claude emitted markdown
   fences when told not to). The Normalizer must not trust formatting.
3. **Subscription CLI drift.** CLIs break against an evolving backend (observed: Codex 0.118
   rejected the backend's new `max` reasoning variant; fixed by updating to 0.163). Need
   health-checks + graceful API fallback, and tolerance for version skew.
4. **Two-vendor availability.** Adversarial value depends on two live frontier vendors; the
   router must degrade transparently when only one is available.
5. **Cost of adversarial review.** More frontier spend per task than solo; mitigated by local
   grunt + capped rounds. Watch that the net economics actually favor the user.

### Evidence already gathered (feasibility spike, 2026-10-18)
- Drove `claude -p --output-format json` (author) and `codex exec -o` (adversarial reviewer)
  headless, with structured output, on **subscription** auth, chained author→reviewer
  cross-vendor. Codex caught 3 real bugs in Claude-authored code. Conclusion: **feasible.**
- Confirmed subscription endpoints are the CLIs' default (Claude oauth/max; Codex ChatGPT
  websocket). Confirmed Codex ships `exec` / `review` / `apply` / `sandbox` primitives and
  structured output (`-o`, `--json`, `--output-schema`).

---

## 10. Non-goals / deferred

- Nicer GUI (wanted later; terminal for MVP).
- Packaging and distribution for public download (gated: **notify the operator before going
  live as a product**; revisit security/key hardening then).
- Multi-user, hosting, accounts.
- Budget optimization and dashboards.
- Provider auto-discovery; parallel tasks.

---

## 11. Glossary

- **Participant** — a model wrapped behind the shared `run(role, task, context)` contract.
- **Role** — Author, Reviewer, or Grunt/Executor; a system-prompt + output-shape preset.
- **Chunk** — a unit of work sized for one reliable local-agent run; one git commit.
- **Checkpoint review** — adversarial frontier review of a chunk's diff before proceeding.
- **Escalation** — a deadlock surfaced to the user as a short written recommendation about a
  trade-off (never a technical question).
- **Gate** — the final user approval before anything touches the real repo.
