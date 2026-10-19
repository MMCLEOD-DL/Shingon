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
