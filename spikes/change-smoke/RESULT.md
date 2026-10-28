# Change smoke result

Not run yet.

Run it with: `SOURCE_PROJECTS_ROOT=/var/tmp/hf-ship-smoke.XXXXXX bash spikes/change-smoke/run-change-smoke.sh <project> <deployment>` (add `--break` for the optional step 7). The ship-smoke folder's own deployment record is stale afterwards (it shows the old version).
The script header says what must be running first.

Fill in after the run:

- Date:
- Project / deployment:
- Step 1, doctor and deployment status (version before):
- Step 2, small change through the council and gate (new version; council verdicts; frontier cost shown at the gate):
- Step 3, box checks (updater status line "Updated from ... to ... A backup (...) was taken first."; version the app reports):
- Step 4, scratch foundation release made (foundation version, previous tag):
- Step 5, `foundation-upgrade --check` listed the code and the deployment as missing 1 security fix:
- Step 6, foundation upgrade (council verdicts; cost; box checks; `--check` afterwards says up to date):
- Step 7, optional deliberate failure (skipped / report line seen / deployment still on previous version):
- Anything surprising:
