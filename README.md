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

   You will see a ✓ or ✗ for each model, and which one will plan, review and code. For
   `claude` and `codex` a ✓ only means the program is **installed** (it answers
   `--version`); whether it is signed in is found out the first time Conductor uses it. The
   local model gets a real test request, so its ✓ means it answered.

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
| `conductor doctor` | check which models are installed (subscriptions) or answering (local model) |

Add `--approve-plan` to see the plan and say yes before any work starts.

Press **Ctrl-C** at any time to stop. Your project is untouched, and `conductor resume`
carries on from the last finished step.

## When a model is unavailable

- If one subscription is signed out, out of its usage limit or rate-limited, Conductor
  switches to the other one. A signed-out model stays out for the rest of the run; one that
  is rate-limited or briefly unreachable is tried again after `cooldownMs`.
- If only one company's models are left, the run carries on, and the summary tells you the
  cross-checking was weaker.
- Before every run (and in `conductor doctor`) Conductor checks the local model and tries to
  wake it if you have set that up (see **Waking the local model**). If it still is not
  answering, Conductor tells you what is wrong and **asks** before Claude or Codex do its
  steps, because that uses your subscription. You can try again, go ahead, or stop. Without a
  terminal to ask you, Conductor stops and nothing is spent.
- If the local model stops answering **during** a run, Conductor asks once. If you say no,
  the run pauses; start the local model and run `conductor resume`.
- If no model is left, the run **pauses**. Run `conductor resume` when one is back.
- Paid API keys are used **only** if you set `"allowApi": true` under `routing` in the config.
  The run tells you the moment it starts using one, and the summary says how much it cost.

## Waking the local model

Conductor remembers which models your earlier runs used, and checks them before each run. Each
participant in the config can say how to wake it with a `wake` block:

- `"method": "warn"` (the default): just check it, and if it is down show your `hint`, the
  words that tell you what to start by hand.
- `"method": "wol"`: send a Wake-on-LAN signal to its `mac` address (optional `broadcast`,
  default `255.255.255.255`, and `port`, default `9`). The machine must have Wake-on-LAN
  switched on, and Conductor must run on the same network.
- `"method": "command"`: run a program you choose, for example a restricted `ssh` that starts
  the model server: `"cmd"`, `"args"`, and `"env"` (the names of environment variables the
  program may see; it sees no other secrets). It is stopped after `timeoutMs` (default 60 s).
  The values of those variables are hidden from anything Conductor prints or records.

After waking, Conductor waits up to `waitMs` (default 180 s), checking every `pollMs`
(default 5 s).

```json
"wake": { "method": "wol", "mac": "aa:bb:cc:dd:ee:ff", "broadcast": "192.168.1.255",
          "hint": "Turn on the desktop PC and start its LocalAI worker." }
```

How this behaves:

- If the model is still down after waking, Conductor asks (see above) unless `localDown` is
  `"frontier"` (go ahead without asking) or `"pause"` (never cover for it).
- With no terminal to ask you, a stop before the run starts exits with code 1, and a stop
  during the run pauses it with exit code 3.
- `conductor doctor` wakes your models but never asks anything.
- `conductor resume` asks again. Your earlier answer does not carry over to a resumed run.

What Conductor remembers is kept in `.workers.json` in its workspaces folder. Deleting it is
safe.

## Settings (`config.json`)

- `participants`: your models. Each one has an `adapter`: `claude-code`, `codex`,
  `local-agent`, `anthropic-api` or `openai-api`.
- `routing`:
  - `allowApi` (default `false`; must be `true` or `false`, not `"true"`);
  - `preferTwoVendors` (default `false`; `true` or `false`): use a paid API for the second
    opinion instead of letting one company review its own work. It has no effect unless
    `allowApi` is `true`;
  - `localDown`: `"ask"` (default: ask you first), `"frontier"` (let Claude/Codex cover without asking) or `"pause"` (never cover; stop or pause instead);
  - `cooldownMs`: how long a rate-limited or unreachable model rests before it is tried
    again; `maxWaitMs`: the longest Conductor waits when every model is resting;
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
