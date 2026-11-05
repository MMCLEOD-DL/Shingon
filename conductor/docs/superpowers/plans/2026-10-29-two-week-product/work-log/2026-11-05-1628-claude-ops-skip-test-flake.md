# Claude: ops skip test waits for the slow job to start, not a fixed 50 ms

```
Packet/subpacket: none (CI red item). foundation job of run 42058248487 on PR96 (docs-only head f08ab8b):
  foundation/ops/test/app-jobs.test.ts, "a fire skipped because the last run is still going is logged each time and
  alerted once", TypeError: release is not a function.
Owner and reviewer: Claude, at Malcolm's direct request on 5 November 2026 (handoff of this one test from Codex's
  foundation/ops/** ownership); reviewer Codex. High-risk path (risk-gate.yml): needs Malcolm's merge.
Status: IN_REVIEW.
Baseline SHA: 3842218 (main after PR95). Result commit: 4458642.
Owned files changed: foundation/ops/test/app-jobs.test.ts (that test only). No ops source, scheduler or other test
  changed. No assertion removed or relaxed.
Cause: the test slept 50 ms after the 09:00 fire and assumed the job's run() had been called by then, which is what
  sets release. The scheduler claims the run in the database before calling run(), so on a slow runner run() can come
  later. The two "skipped" assertions still pass (the run is already marked as going), then release() throws.
Fix: the first run() resolves a started promise in the same tick as it sets release; the test awaits it before the
  09:05 fire. Same pattern as the neighbouring "ops was stopping" test.
Checks (cloud Linux, 4 CPUs, Node 22.23.4, PostgreSQL 16 local, vitest via npx from foundation/):
  Reproduce: with a 100 ms await injected at the top of the first run() (temporary, not committed), the old test fails
    with "TypeError: release is not a function", the CI error. With the fix and the same injection (100 ms and
    500 ms), it passes.
  Loop, unloaded: npx vitest run --project @hf/ops ops/test/app-jobs.test.ts --maxWorkers=1, 20 runs: 20 passed
    (24 tests each).
  Loop, CPU load (8 busy loops on 4 CPUs): target test alone (-t "still going is logged") 40/40 passed with the fix.
    Caveat: the OLD test also passed 40/40 under this load, so CPU load here does not reproduce the CI failure; the
    injected delay is the reproduction. Full-file runs under that load: the target test passed 20/20 with the fix,
    but every run had another failure (see open defect below).
  npx vitest run --project @hf/ops: 21 files passed, 1 skipped; 303 tests passed, 6 skipped (backup.integration,
    which runs only when restic, pg_dump and pg_restore are installed; restic is not here). npx eslint on the file: clean. npx tsc -b ops: clean.
Not run: full Foundation suite (only the ops project), native Windows, CI itself (PR checks will run).
Open defect (not fixed here, Codex-owned): app-jobs.test.ts "dueSince is capped, never a hang" asserts a wall-clock
  limit of 5000 ms. It takes about 2.7 s unloaded on this box and 6.1-6.7 s under the load above (failed 40/40
  loaded full-file runs). Less than 2x headroom on a shared CI runner: a likely next flake. Options for Codex: make
  dueSince cheaper for a year of minutes, or assert on iteration count instead of time.
Next action: Malcolm reviews and merges (high-risk path); Codex may review.
```
