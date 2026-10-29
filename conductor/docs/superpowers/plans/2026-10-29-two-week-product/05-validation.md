# Validation runbook for implementation sessions

These are instructions for future work, not checks newly executed when writing this plan. Resolve the actual checkout root first. In this cloud task it is `/workspace/Shingon`; `/root/shingon` was not present. Never assume a path from another assistant's machine is current.

## Before coding

```
git status --short
git rev-parse HEAD
node --version
npm --version
```

Record pre-existing files/edits, applicable instructions, baseline SHA, installed versions and configured variable names/presence only. Do not dump the environment or credential files. Node must satisfy Foundation's `>=22.13` requirement; select and document a concrete supported version for the operator app in P00. Use checked-in lockfiles for reproducible installs.

## Foundation

From `foundation/`, with dependencies installed using `npm ci` and PostgreSQL available. `TEST_DATABASE_URL` must refer to a development/test role allowed to create databases; never a production database. Tests create isolated temporary databases. Backup tests also need PostgreSQL client tools on PATH. The cloud setup retains helpers in `/workspace/shingon-dev`; source `env.sh` there only if present and appropriate for this instance, never copy its values as company credentials.

```
npm run lint
npm run typecheck
npm run licences
npm test -- --maxWorkers=1
npm -w @hf/web run build
```

Use a normal `umask 022` in this development shell for tests that assert file modes. On the four-CPU cloud instance, one Foundation worker avoids contention in timing-sensitive tests; do not simultaneously launch another heavy suite. The sequential commands above cover the normal verify gate with controlled concurrency. Preserve exit statuses if logging output; a successful `tail` is not a passed test.

Focused packet checks, including newly added regressions in the matching files:

```
npx vitest run --project @hf/ops update.test.ts compose.test.ts set-env.test.ts --maxWorkers=1
npx vitest run --project @hf/ocr pdf-text.test.ts extract.test.ts read-receipt.test.ts --maxWorkers=1
```

Ensure the new regression files actually matched and ran. P01 should also include journal/update-cli checks if those interfaces change. P02 should run the existing PDF memory/deadline tests; do not replace them with only a text-extraction check.

`npm run verify:full` adds browser and corpus OCR checks; document any intentionally unrun release checks separately. Browser downloads/system libraries were blocked/incomplete in the earlier cloud setup; fix the actual prerequisite before claiming browser validation. Never disable TLS or checksums to install tooling. Client-box shipping smoke tests are outside this UI milestone.

## Conductor

From `conductor/`:

```
node --test --test-concurrency=4
```

The current cloud container's PID 1 leaves orphan processes as zombies. Earlier validation demonstrated a false failure in the wake-cancellation test without an orphan-reaping wrapper, and success with `/workspace/shingon-dev/reap.py`. If this same environment still needs it, use:

```
python3 /workspace/shingon-dev/reap.py node --test --test-concurrency=4
```

Set `XDG_CACHE_HOME` to a writable task-appropriate path if the default home cache is unavailable. Do not interpret a failed local CODEX_HOME creation as a model outage. On a normal host with a working cache and process reaping, the plain command should be sufficient; verify rather than copying cloud workarounds blindly.

Focused release-path regression checks:

```
node --test --test-concurrency=2 test/factory-release.test.js test/factory-later-ship.test.js test/factory-change-mainline.test.js test/factory-change-pipeline.test.js test/factory-change-ship.test.js
```

Use the reaper prefix if required on the current host. After P03/P04 establish their package scripts, add exact service/UI build, contract-test and browser-test commands here. Do not call a future script verified just because this plan names it. UI tests should use fake providers by default; CI must not accidentally spend real subscriptions.

## Acceptance evidence

For each matrix row in the master plan, record:

- Baseline and result commit; host topology/OS; tool/model versions; command and working directory.
- Counts/exit status, expected and observed behaviour, and sanitized artifact paths.
- Whether the model/backend was real or fake; tests skipped/unrun and exact blockers.
- For approval/rejection/cancellation: source HEAD, branch, status and index before/after, plus preservation of pre-existing user files.
- For recovery: the crashed process, on-disk state, reconstructed state and whether completed work repeated.
- Reviewer and the exact SHA they inspected.

Never infer remote model execution from a UI badge, cancellation from an exit code alone, or successful shipping from an app version string. For this milestone, the real-model coding result must show local work, both subscription vendors' actual participation, tests, exact diff and user-approved branch creation. No live deployment is required.
