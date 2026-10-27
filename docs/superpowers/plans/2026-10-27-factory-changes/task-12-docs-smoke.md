# Task 12: Docs and operator change smoke

This task finishes Plan 11:
- the README tells the operator how to make a change, take a foundation fix, check who is behind, and what to do when a ship stops part-way;
- an operator-run smoke proves the whole path on real machines: a small change and a foundation upgrade, each through the real council and gate, shipped as an update to a throwaway deployment on CT 111.

**The implementer writes the files and checks syntax only. The implementer does NOT run the smoke**, and does not ssh anywhere. Malcolm runs it from a real terminal, because it needs both subscriptions, the local model, CT 111, a human at the brief questions and the gate, and a deployment made by Plan 10's smoke.

**Files:**
- Modify: `README.md`, `config.example.json` (only if Plans 7–10 did not already add the `factory` block)
- Create: `spikes/change-smoke/run-change-smoke.sh`, `spikes/change-smoke/notes-change.md`, `spikes/change-smoke/RESULT.md`
- Test: `test/config.test.js` (one assertion, only if `config.example.json` changed)

**Interfaces:**
- Consumes: the commands (Task 11); Plan 10's smoke project and deployment (`spikes/ship-smoke/`, or whatever Plan 10 named it: read its `RESULT.md` for the project slug and deployment name).
- Produces: the operator command `bash spikes/change-smoke/run-change-smoke.sh <slug> <deployment>`, and the docs.

- [ ] **Step 1: Add the README section "Changing a live app"**

Cover, in plain UK English, in this order:
- `conductor change <slug> --notes <file>`: what the operator is asked (the brief questions, then the gate), what "If you approve" means (the app's main line moves on, a new version is made, every deployment is updated one at a time, each with a backup first and an automatic undo).
- Why the council reviews the **whole** app every time, and that nothing ships unless the council passed or the operator chose to ship anyway after reading every problem.
- Removed features keep their data (Ruling 3); hosting moves are not changes (Ruling 2).
- `conductor foundation-upgrade <slug> --to <tag>`: when to use it (a `[security]` entry in the foundation's `CHANGELOG.md`), what conflicts mean ("both the foundation and the app changed the same lines"), when Conductor stops and asks a person (deleted-versus-edited and binary files, or more than 20 files).
- `conductor foundation-upgrade --check`: reading the report; the difference between "code" and a deployment being behind.
- When a ship stops part-way: read the deployment lines; for **URGENT**, follow "Recovering from a failed update" in the foundation runbook first; then `conductor change <slug> --resume`, which asks before trying that deployment again.
- `--resume` and `--abandon`, and that only one change per project runs at a time.

- [ ] **Step 2: Write the smoke**

`spikes/change-smoke/notes-change.md`: meeting notes asking for one small, visible, testable change on the smoke app (for example: "show 'Last edited <date>' under each note's title; staff asked for it; a note edited on 3 March 2026 shows 'Last edited 3 March 2026'").

`spikes/change-smoke/run-change-smoke.sh <slug> <deployment>` (bash, `set -euo pipefail`, every step echoed in plain words, stop at the first failure):
1. `conductor doctor` and `conductor deployments status` (Plan 10): record the deployment's current version.
2. `conductor change <slug> --notes spikes/change-smoke/notes-change.md`. The operator answers the brief questions and checks the gate text names the new version and the deployment, then approves.
3. On CT 111 over ssh, in the deployment's bundle folder: `docker compose run --rm updater update --status`, expecting the newest line to be "Updated from <old> to <new>. A backup (…) was taken first."; and `curl` the app's `/api/version` with the health token, expecting the new version.
4. Make a scratch copy of the foundation (`git clone /root/highland-foundation /tmp/hf-smoke-foundation`; never touch `/root/highland-foundation`). In the copy, add a dated section `## [0.1.1] - <today>` holding `- **[security]** Smoke: no real change.`, raise `version` in `package.json`, `package-lock.json` and `foundation.json` (with `commit: "v0.1.1"`), commit `release: v0.1.1` and make the annotated tag `v0.1.1` (what the foundation's own release does, without needing its packages installed). Point the smoke project's `project.json` `foundation.repo` at the copy (print the old value and put it back at the end, in a `trap`).
5. `conductor foundation-upgrade --check`: expect the code and the deployment to be listed as missing 1 security fix.
6. `conductor foundation-upgrade <slug> --to v<new foundation version>`: approve at the gate; then repeat step 3's checks, and `--check` again, expecting "up to date".
7. Deliberately break one update to see the stop rule: skip unless the operator passes `--break`, which makes the next change add a start-up failure on purpose (a notes file asking for it), so the box rolls back; expect the report line "the new version failed its health check, so the box undid the update by itself", and the deployment still on the previous version.

`spikes/change-smoke/RESULT.md`: a template with a line per step for the operator to fill in (date, versions before and after, council verdicts, frontier cost from the gate, anything surprising).

- [ ] **Step 3: Check syntax**

Run: `bash -n spikes/change-smoke/run-change-smoke.sh && npm test`
Expected: no output from `bash -n`; the suite passes.

- [ ] **Step 4: Commit**

```bash
git add README.md spikes/change-smoke/ config.example.json test/config.test.js
git commit -m "docs(change): changing a live app, foundation upgrades, and an operator change smoke"
```

- [ ] **Step 5: Hand over to the operator**

Tell Malcolm the smoke is ready: `bash spikes/change-smoke/run-change-smoke.sh <slug> <deployment>`, what it needs running first (Plan 10's smoke deployment on CT 111, the local model, both subscriptions), and that step 7 is optional. Do not run it.
