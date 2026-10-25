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
