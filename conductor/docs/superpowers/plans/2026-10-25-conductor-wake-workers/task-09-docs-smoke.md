# Task 9: Docs & operator wake smoke

This task finishes Plan 4 in four parts:
- the README tells the operator what Conductor now does when the local model is down;
- the README explains how to set up waking;
- `config.example.json` shows the new defaults;
- an operator-run smoke proves the real thing: the .109 desktop worker is off, CT110's LocalAI is up, and Conductor says so plainly and asks.

**The implementer writes the files and checks syntax only. The implementer does NOT run the smoke**, and does not ssh anywhere. Malcolm runs it with `!` from a real terminal, because it needs the live LocalAI key, the tunnel, both subscriptions, a human at the questions, and the desktop worker deliberately off.

**Files:**
- Modify: `README.md`, `config.example.json`
- Create: `spikes/wake-smoke/run-wake-smoke.sh`, `spikes/wake-smoke/RESULT.md`
- Test: `test/config.test.js` (existing `config.example.json loads into three Participants`, plus one assertion)

**Interfaces:**
- Consumes:
  - the `wake` block (Task 2) and `routing.localDown` (Tasks 2 and 5);
  - the CLI behaviour (Task 8);
  - the tunnel and key handling of `spikes/cli-smoke/run-cli-smoke.sh`.
- Produces: the operator command `bash spikes/wake-smoke/run-wake-smoke.sh`, and the docs.

- [ ] **Step 1: Update `config.example.json` and its test**

Set `"localDown": "ask"` under `routing`. Add this to the `local` participant:

```json
      "wake": { "method": "warn", "hint": "Turn on the desktop PC (192.168.1.109) and start its LocalAI worker." },
```

In `test/config.test.js`, inside `'config.example.json loads into three Participants'`, add:

```js
  assert.equal(byName.get('local').wake.method, 'warn');
```

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Update `README.md`**

- In **When a model is unavailable**, replace the bullet "If the local model is down, the subscription models do every step…" with:

```markdown
- Before every run (and in `conductor doctor`) Conductor checks the local model and tries to
  wake it if you have set that up (see **Waking the local model**). If it still is not
  answering, Conductor tells you what is wrong and **asks** before Claude or Codex do its
  steps, because that uses your subscription. You can try again, go ahead, or stop. Without a
  terminal to ask you, Conductor stops and nothing is spent.
- If the local model stops answering **during** a run, Conductor asks once. If you say no,
  the run pauses; start the local model and run `conductor resume`.
```

- In **Settings**, change the `localDown` line to: `` `localDown`: `"ask"` (default: ask you first), `"frontier"` (let Claude/Codex cover without asking) or `"pause"` (never cover; stop or pause instead); ``.
- Add a new section after **When a model is unavailable**:

````markdown
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

After waking, Conductor waits up to `waitMs` (default 180 s), checking every `pollMs`
(default 5 s).

```json
"wake": { "method": "wol", "mac": "aa:bb:cc:dd:ee:ff", "broadcast": "192.168.1.255",
          "hint": "Turn on the desktop PC and start its LocalAI worker." }
```

What Conductor remembers is kept in `.workers.json` in its workspaces folder. Deleting it is
safe.
````

- [ ] **Step 3: Write `spikes/wake-smoke/run-wake-smoke.sh`**

Copy `spikes/cli-smoke/run-cli-smoke.sh` and change it as follows. Keep its tunnel, key, `trap` and throwaway-repo handling as they are.
- Update the header comment: `# Plan 4 smoke (operator-run via ! in a REAL terminal): the .109 desktop worker is OFF, CT110 LocalAI is up. Conductor must say so plainly and ASK before Claude/Codex do the local work.`
- Keep the `node -e` config builder. Pass it two more arguments, `"${WAKE_MAC:-}" "${WAKE_BROADCAST:-192.168.1.255}"`. When `WAKE_MAC` is non-empty, the builder sets `p.wake = { method: 'wol', mac, broadcast, hint: 'Turn on the desktop PC and start its LocalAI worker.' }` on the `local-agent` participant. Otherwise it leaves the example's warn-only block.
- Before `doctor`, print:

```bash
echo "== precondition: the .109 desktop LocalAI worker should be STOPPED now (CT110 stays up) =="
read -r -p "Press Enter when the worker is stopped (Ctrl-C to abort) " _
```

- Change the run line's echo to: `echo "== conductor run: at the local-model question press w AFTER starting the worker (or f to let Claude do it); then v, a at the gate =="`.
- Keep `CONDUCTOR_BASE_DIR="$HOME/.conductor/smoke-workspaces"`. After the run, print the memory file with `echo "== remembered workers ==" && cat "$CONDUCTOR_BASE_DIR/.workers.json"`. It holds only names, kinds, times and counts, never keys.

- [ ] **Step 4: Write `spikes/wake-smoke/RESULT.md`**

```markdown
# Wake smoke — result

**Status:** NOT RUN YET (operator-run: `! bash spikes/wake-smoke/run-wake-smoke.sh` in a real terminal)

## Run 1 — <date>
- Wake method: warn | wol (MAC set via WAKE_MAC)
- `doctor` with the worker stopped: (paste the local line and the Note)
- Did it say "its GPU worker is not connected"? yes / no
- Run: question shown? answer given (w / f / s)? outcome, branch, elapsed
- Steps done by local / by fallback:
- Frontier cost reported:
- Remembered workers after the run:

## Observations

## Operator follow-ups (outside the code)
1. **Choose how .109 gets woken**, then put the `wake` block in `~/.config/conductor/config.json`:
   - **Wake-on-LAN:** enable it in the desktop's BIOS/UEFI and in the Windows network adapter
     settings ("Wake on Magic Packet"). Turn off Windows Fast Startup. Note the wired NIC's MAC.
     Check that the host running Conductor sends broadcasts onto the same LAN (192.168.1.255).
   - **Worker auto-start:** waking the PC is not enough on its own. The LocalAI worker container must
     start by itself after boot: Docker Desktop starting at sign-in (which needs a signed-in session)
     plus a restart policy on the container, or a Windows service.
   - **Node approval:** CT110 runs with `LOCALAI_AUTO_APPROVE_NODES=false`. Check whether a rebooted
     worker comes back as the *same* approved node. A past restart changed its identity. If it needs
     approving again, decide whether that stays a manual step. Any automation of it is a separate
     security decision for the OP06 setup and is not part of Conductor.
   - **Remote start (optional, `method: "command"`):** needs a restricted account and key on .109
     (for example OpenSSH with a forced `start-worker` command). That is SSH provisioning, which needs
     your explicit go-ahead. Plan 4 only provides the config hook.
2. Carried over: install bubblewrap on the host that runs Codex; check the Codex model-metadata warning.
3. Packaging for others is still out of scope: **notify the operator before going live as a product**.
```

- [ ] **Step 5: Check syntax only. Do not run the smoke.**

Run: `bash -n spikes/wake-smoke/run-wake-smoke.sh && node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))" && npm test`
Expected: no output from `bash -n`, no JSON error, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md config.example.json test/config.test.js spikes/wake-smoke
git commit -m "docs: waking the local model; operator wake smoke"
```

- [ ] **Step 7: Hand off to the operator**

Tell Malcolm:
- Plan 4 is ready for its smoke: stop the .109 LocalAI worker, then run `! bash spikes/wake-smoke/run-wake-smoke.sh` from a real terminal (the Proxmox xterm.js console worked for the CLI smoke). Optionally set `WAKE_MAC=<mac>` first to try Wake-on-LAN.
- The operator follow-ups in `spikes/wake-smoke/RESULT.md` are his decisions. Nothing was provisioned.

Once the output is back, fill in `RESULT.md` and commit it with the message `docs: wake smoke result`.
