# Task 11: Docs & operator CLI smoke

This task finishes Plan 3 with two pieces:

- **A README** that a non-technical user can follow: what Conductor does, how to set it up, how to run it, and what is safe.
- **An operator-run smoke test of the real `conductor` command.** It uses the real CLIs and the real local model, and the operator answers the final gate by hand. That is the one thing the e2e tests in Task 10 cannot prove.

**The implementer writes the files and checks syntax only. The implementer does NOT run the smoke.** Malcolm runs it with `!`, because it needs the live LocalAI key, both frontier subscriptions and a human at the gate.

**Files:**
- Create: `README.md`, `spikes/cli-smoke/run-cli-smoke.sh`, `spikes/cli-smoke/RESULT.md`
- Modify: `config.example.json` (add a `routing` section with the defaults spelled out)

**Interfaces:**
- Consumes:
  - `bin/conductor.js` and `CONDUCTOR_BASE_DIR` (Task 10);
  - the config format (`participants`, `routing`, `options`) (Tasks 2 and 5);
  - the tunnel and key handling of `spikes/loop-smoke/run-smoke.sh`.
- Produces:
  - the operator command `bash spikes/cli-smoke/run-cli-smoke.sh`;
  - the docs.

- [ ] **Step 1: Update `config.example.json`**

Replace the file with:

```json
{
  "participants": [
    { "name": "claude", "adapter": "claude-code", "bin": "claude",
      "roles": ["author", "reviewer"], "capabilities": { "is_agentic": true, "can_edit_files": true } },
    { "name": "codex", "adapter": "codex", "bin": "codex",
      "roles": ["author", "reviewer"], "capabilities": { "is_agentic": true, "can_edit_files": true } },
    { "name": "local", "adapter": "local-agent", "bin": "codex", "model": "shingon-qwen3.8-27b-q4",
      "baseUrl": "http://192.168.1.110:8081/v1", "contextWindow": 32768,
      "roles": ["grunt"], "capabilities": { "is_agentic": true, "can_edit_files": true } }
  ],
  "routing": {
    "allowApi": false,
    "preferTwoVendors": false,
    "localDown": "frontier",
    "cooldownMs": 60000,
    "maxWaitMs": 300000
  },
  "options": {}
}
```

Then run `npm test`. The config tests and the loop smoke script read this file. Expected: PASS.

- [ ] **Step 2: Write `README.md`**

```markdown
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
```

- [ ] **Step 3: Write `spikes/cli-smoke/run-cli-smoke.sh`**

```bash
#!/usr/bin/env bash
# Plan 3 smoke (operator-run via `!`): the real `conductor` command, real CLIs, real local
# model, and YOU at the final gate. Key handling as in spikes/loop-smoke/run-smoke.sh:
# the LocalAI key lives only in an env var for this process. It is never printed and never
# written to the temp config.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)" || exit 2
LPORT=8091

CFG=""
REPO=""
cleanup() { pkill -f "${LPORT}:127.0.0.1:8081" 2>/dev/null; }
cleanup_all() {
  [ -n "$CFG" ] && rm -f "$CFG"
  cleanup && echo "tunnel closed"
  [ -n "$REPO" ] && echo "throwaway repo kept for inspection: $REPO"
}
trap cleanup_all EXIT
trap 'exit 130' INT TERM
cleanup; sleep 1

echo "== tunnel =="
ssh -f -N -o ExitOnForwardFailure=yes -o ConnectTimeout=6 \
    -L 127.0.0.1:${LPORT}:127.0.0.1:8081 root@192.168.1.110 \
    && echo "tunnel up (127.0.0.1:${LPORT} -> CT110:8081)" || { echo "TUNNEL FAILED"; exit 1; }

export LOCALAI_API_KEY="$(ssh -o ConnectTimeout=6 root@192.168.1.110 \
    'grep -E "^LOCALAI_API_KEY=" /opt/shingon-localai/.env | cut -d= -f2-')"
[ -n "${LOCALAI_API_KEY:-}" ] && echo "key loaded" || { echo "NO KEY"; exit 1; }

CFG="$(mktemp --suffix=.json)" || { echo "CONFIG BUILD FAILED"; exit 1; }
node -e '
  const fs = require("fs");
  const [src, dst, url] = process.argv.slice(1);
  const c = JSON.parse(fs.readFileSync(src, "utf8"));
  for (const p of c.participants) if (p.adapter === "local-agent") p.baseUrl = url;
  fs.writeFileSync(dst, JSON.stringify(c, null, 2));
' "$ROOT/config.example.json" "$CFG" "http://127.0.0.1:${LPORT}/v1" || { echo "CONFIG BUILD FAILED"; exit 1; }

REPO="$(mktemp -d -t cli-smoke-repo-XXXXXX)" || exit 1
cd "$REPO" || exit 1
printf '{ "name": "smoke", "private": true, "type": "module" }\n' > package.json
printf 'export function add(a, b) { return a + b; }\n' > math.js
printf "import assert from 'node:assert/strict';\nimport { add } from './math.js';\nassert.equal(add(2, 3), 5);\nconsole.log('tests ok');\n" > test.js
git init -q -b main && git add -A && git -c user.name=smoke -c user.email=smoke@local commit -qm init

export CONDUCTOR_BASE_DIR="$HOME/.conductor/smoke-workspaces"
echo "== conductor doctor =="
node "$ROOT/bin/conductor.js" doctor --config "$CFG" || { echo "DOCTOR FAILED"; exit 1; }

echo "== conductor run (answer the final gate yourself: v to look, then a to approve) =="
node "$ROOT/bin/conductor.js" "Add a multiply(a, b) function to math.js and a test for it in test.js." \
  --config "$CFG" --test "node test.js"
rc=$?
echo "conductor exit: $rc"
[ $rc -eq 0 ] && git --no-pager log --oneline --all
exit $rc
```

- [ ] **Step 4: Write `spikes/cli-smoke/RESULT.md`**

```markdown
# CLI smoke — result

**Status:** NOT YET RUN (operator runs `! bash spikes/cli-smoke/run-cli-smoke.sh`)

## Run
- Date:
- `doctor` output (✓/✗ per participant, chosen team):
- Outcome (exit code / branch):
- Elapsed:
- Steps done by local / by fallback:

## Observations
- Did the live status read clearly, with no raw model chatter?
- Did `v` show the diff, and did `a` land a new branch?
- Any routing notices (failover, wait, paid API)?
- Optional: Ctrl-C during a local step, then `conductor resume`. Did it carry on?

## Operator follow-ups (outside the code)
- Install bubblewrap on the host that runs Codex. Codex currently uses its bundled copy.
- Codex warns that model metadata for `shingon-qwen3.8-27b-q4` is missing. `contextWindow`
  already sets the window; check whether the warning still matters.
- Packaging for others is out of scope: **notify the operator before going live as a product**.
```

- [ ] **Step 5: Check syntax only. Do not run the smoke.**

Run:
```bash
chmod +x spikes/cli-smoke/run-cli-smoke.sh
bash -n spikes/cli-smoke/run-cli-smoke.sh && node -e 'JSON.parse(require("fs").readFileSync("config.example.json"))' && echo SYNTAX-OK
npm test
```
Expected: `SYNTAX-OK`, and the full suite PASSES.

- [ ] **Step 6: Commit**

```bash
git add README.md config.example.json spikes/cli-smoke
git commit -m "docs: README and operator-run CLI smoke"
```

- [ ] **Step 7: Hand off to the operator**

Stop and tell Malcolm:

> Run `! bash spikes/cli-smoke/run-cli-smoke.sh`. It needs the CT110 stack and the .109 worker up, and it uses both frontier subscriptions for a few minutes. At the end you answer the gate yourself: `v` to look, then `a` to approve.

Once the output is back, fill in `RESULT.md` and commit it with the message `docs: CLI smoke result`.
