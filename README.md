# Conductor

Conductor gets AI models to build a change in your project **and check each other's work**
before anything reaches your code.

- Two rival AI models (Claude and Codex, on your own subscriptions) plan the work and review
  every step. They come from different companies, so each one checks the other.
- A model running on your own machine does the routine coding, which saves your subscription
  for planning and reviewing.
- Nothing touches your project until you approve the result. Even then, it arrives as a **new
  branch** that you merge when you are ready.

## What you need

- Node.js 20 or newer, and `git`.
- The `claude` (Claude Code) and `codex` (Codex) command-line programs, both signed in.
- Optionally, a local model server that speaks the OpenAI API (LocalAI, Ollama, LM Studio),
  driven through `codex`.

## Set up

1. Copy `config.example.json` to `~/.config/conductor/config.json` (or to `conductor.json`
   inside a project) and edit it to point at your models.
2. Check that everything is reachable:

       node /path/to/conductor/bin/conductor.js doctor

   You will see a ✓ or ✗ for each model, and which one will plan, review and code.

(If you make `bin/conductor.js` available as `conductor` on your PATH, the commands below work
as written.)

## Use it

Inside your project folder:

    conductor "add a CSV export button to the reports page" --test "npm test"

You will see a live status. Conductor stops to ask you only when it needs you:

- **A disagreement it cannot settle safely:** you get a short written recommendation and
  choose approve or reject.
- **The end:** a plain-English summary of what changed. Type `v` to see the actual changes,
  `a` to approve (the result becomes a new branch), `r` to reject, or `n` to reject with a note.

Other commands:

| Command | What it does |
|---|---|
| `conductor resume` | carry on with the latest unfinished run in this project |
| `conductor runs` | list the unfinished runs in this project |
| `conductor doctor` | check which models are available |

Add `--approve-plan` to see the plan and say yes before any work starts.

Press **Ctrl-C** at any time to stop. Your project is untouched, and `conductor resume`
carries on from the last finished step.

## When a model is unavailable

- If one subscription is signed out or rate-limited, Conductor switches to the other one.
- If only one company's models are left, the run carries on, and the summary tells you the
  cross-checking was weaker.
- If the local model is down, the subscription models do every step. This costs more of your
  subscription, and the summary says so.
- If no model is left, the run **pauses**. Run `conductor resume` when one is back.
- Paid API keys are used **only** if you set `"allowApi": true` under `routing` in the config.
  The run tells you the moment it starts using one, and the summary says how much it cost.

## Settings (`config.json`)

- `participants`: your models. Each one has an `adapter`: `claude-code`, `codex`,
  `local-agent`, `anthropic-api` or `openai-api`.
- `routing`:
  - `allowApi` (default `false`);
  - `preferTwoVendors` (default `false`): use a paid API for the second opinion instead of
    letting one company review its own work;
  - `localDown`: `"frontier"` (default) or `"pause"`;
  - `cooldownMs` and `maxWaitMs`: how long to wait out a rate limit;
  - `author`, `reviewer`, `local`: which participant to prefer for each job.
- `options`:
  - `testCommand`;
  - `approveEachChunk`;
  - `maxChunks`;
  - round limits: `planRounds`, `localRounds`, `frontierRounds`;
  - timeouts: `agentTimeoutMs`, `localTimeoutMs`, `testTimeoutMs`;
  - `keepWorkspace`;
  - `watchDiffs`.

## Safety

- All work happens in a separate copy of your project, under `~/.conductor/workspaces`. Your
  project gets only a new branch, and only after you approve.
- Keys are never written to logs or shown on screen. Your local model's key goes only to your
  local model.
- Without a terminal (for example in a script), Conductor answers every question "reject", so
  nothing can land unattended.
- The full record of every run is kept as a log file. Its path is printed at the end of
  each run.
