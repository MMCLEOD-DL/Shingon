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

## Follow-ups from the Plan 11 reviews (2026-10-28)

Fixed during Plan 11 but worth knowing:
- Plan 10's `releaseApp`, its adoption of an untagged release and `approvedRelease` now refuse a release whose release files change more than version numbers (and the foundation's `commit: v<version>` stamp). An app whose current release tag changed `package.json` beyond its version cannot be shipped until a new release is made.

Still open:
- Foundation upgrade (Ruling C1): the merge keeps the app's `foundation.json`, so apps that made a release on foundation v0.1.x keep a wrong version in it after upgrading. `project.json` stays the source of truth. Plan 12: correct the file once release.ts stops stamping it.
- A hard kill between a temporary fetch and its clean-up can leave `refs/conductor/changelog-*` or `refs/conductor/incoming/*` in the app repo. Harmless; sweep them on the next run.
- The release-content check compares JSON after parsing: duplicate keys and values that parse the same (null vs 1e999) pass. npm reads the same values, so nothing extra runs. `foundation.json` and the lock's top-level version are not tied to the approved version (nothing trusts them).
- `resolveVersionHunks` keeps the app's side for any single-line `"version"` conflict in `package-lock.json`, including a dependency's. Low risk: dependency changes normally sit next to `resolved`/`integrity` lines.
- `advanceMain` does not notice `main` checked out in a linked worktree of the app; a very large change could hit the argument limit of one `ls-files` call (fails closed); a CRLF changelog gets LF lines.
- Brief delta: with roughly 100+ retired test tags a build step can exceed the instruction limit (Plan 8 refuses it loudly).
- An approved change build re-called returns `saved.runId` without checking it matches its folder (only reachable by hand-editing build.json).
- The integration test across Plans 8/9/11 runs the real build, gate and report writer, but stubs the council round itself.
- Wording: `approvedRelease`'s refusal has a capital letter after its colon; the content refusal says "nothing was shipped" where Plan 10's sentences say "nothing was added".
- Smoke script: the `[Unreleased]` emptiness check misses the last line if that section is last in the file; the project folder inside `SOURCE_PROJECTS_ROOT` is not itself refused if it is a link (still confined to `/var/tmp/hf-ship-smoke.*`); without a Conductor config file the config-root check is skipped silently.
- The ship smoke's phases 2 and 3 (updates through `conductor change`) can now run.
