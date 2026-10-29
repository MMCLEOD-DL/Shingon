# Task 10: Images, modest-box check, docs and v0.2.0

**Repo: `/root/highland-foundation`. Steps 3–5 run on the Docker build machine (Plan 6 follow-up); the rest anywhere.**

This task ships M1:
- the images carry the modules and `app-profile.json`;
- the full foundation smoke, with Task 9c's hard-kill step, passes on the build machine;
- local OCR is **proven on a modest CPU-only box** (spec §5), offline;
- the docs tell whoever builds a client app how to switch modules on;
- the foundation is released as `v0.2.0`.

**Files:**
- Modify: `ops/src/setEnv.ts` (`SETTABLE_ENV_KEYS` gains the `OCR_*` keys), `deploy/Dockerfile` (copy `modules/*` manifests and builds, `app-profile.json`; build `@hf/ocr`, `@hf/pdf-export`, `@hf/xlsx-export`), `deploy/ops.Dockerfile` (copy `app-profile.json` and the server's `jobs` build), `deploy/.env.example` and `ops/src/init.ts` (`OCR_ENGINE=local`, `OCR_CONCURRENCY=1`, and the three `OCR_AZURE_*` lines commented out with a note that the data policy must allow it), `deploy/test/compose.test.ts` (the new variables pass through to `app`; `OCR_AZURE_KEY` is treated as a secret)
- Create: `deploy/smoke/ocr-modest-box.sh`, `deploy/smoke/OCR-RESULT.md`
- Modify: `deploy/smoke/RESULT.md` (the v0.2.0 smoke run, Step 3)
- Modify: `README.md` (an "Optional modules" line under what it gives a client app; drop OCR, PDF and spreadsheet export from "Later work" if listed), `docs/BUILDING-ON.md` (new section "Optional modules"), `docs/RUNBOOK.md` (OCR settings, cloud OCR, `ops jobs`), `docs/LICENCES.md` (regenerated), `CHANGELOG.md`
- Test: `deploy/test/compose.test.ts`, `deploy/test/docs.test.ts` (existing: LICENCES up to date)

**Interfaces:**
- Consumes: everything in Tasks 1–9 and 9a–9c; `benchCorpus` CLI (Task 3); `deploy/smoke/run-smoke.sh` with step 7a (Task 9c); the release fix (Task 9a).
- Produces: images `highland/app:0.2.0` and `highland/ops:0.2.0`; tag `v0.2.0`; `deploy/smoke/RESULT.md` (smoke at v0.2.0) and `deploy/smoke/OCR-RESULT.md` with the measured figures; the crossing route count at v0.2.0 (for Task 11's `foundationRoutes`).

Modest-box gate [call]. The box is the app image run with `docker run --cpus=2 --memory=2g --network none`, with `OCR_CONCURRENCY=1`, over the rendered corpus (16 images) and any operator photos.

| Measure | Pass |
|---|---|
| Median seconds per receipt | ≤ 10 |
| Slowest receipt | ≤ 30 s (below `OCR_TIMEOUT_MS`) |
| Out-of-memory kills | none |
| `confidentlyWrong` (all fields) | 0 |
| Network | none needed (`--network none` succeeds) |
| App image growth over v0.1.0 | ≤ 60 MB |

If the median fails: first try `PSM.SINGLE_BLOCK` and `maxSide` 1600 (Task 6). If it still fails, **stop and report to the operator** with the figures; the fallback is native Tesseract in the image (index, engine table), which is a new decision for the operator.

- [ ] **Step 1: Write the failing compose test**

In `deploy/test/compose.test.ts`:
- `app` receives `OCR_ENGINE`, `OCR_CONCURRENCY`, `OCR_TIMEOUT_MS`, `OCR_AZURE_ENDPOINT`, `OCR_AZURE_REGION` and `OCR_AZURE_KEY` from `.env`;
- `ops` receives none of the `OCR_*` variables;
- `.env.example` contains `OCR_ENGINE=local` and no uncommented `OCR_AZURE_KEY`.

Run: `npx vitest run deploy` → FAIL.

- [ ] **Step 2: Update the Dockerfiles, `.env.example` and `ops init`**, and add `OCR_ENGINE`, `OCR_CONCURRENCY`, `OCR_TIMEOUT_MS`, `OCR_AZURE_ENDPOINT`, `OCR_AZURE_KEY` and `OCR_AZURE_REGION` to `SETTABLE_ENV_KEYS` (`ops/src/setEnv.ts`, Task 9b; its test fails until they are there). Then run `npx vitest run deploy ops/test/set-env.test.ts` → PASS.

- [ ] **Step 3: Run the full foundation smoke** (build machine)

The smoke refuses to run where `highland/app` or `highland/ops` images exist, so it runs **before** Step 4 builds them (it builds and removes its own).

```bash
bash deploy/smoke/run-smoke.sh 2>&1 | tee /tmp/hf-smoke-v020.log
HF_SMOKE_DIR=/tmp/hf-smoke-alt HF_SMOKE_PROJECT=hf-smoke-alt bash deploy/smoke/run-smoke.sh 2>&1 | tail -3
```
Expected: both end `SMOKE PASSED`, and step 7a prints `ok: hard kill of db, app and ops: …`. Update `deploy/smoke/RESULT.md` with the date, the commit, the step lines of the first run (including 7a) and one line saying the second run used the two settings and passed. If step 7a fails, that is a real recovery defect in the foundation: stop and report it to the operator with the log; do not weaken the step.

- [ ] **Step 4: Build the images and measure the size** (build machine)

```bash
npm run images
docker image inspect highland/app:0.2.0 --format '{{.Size}}'
docker image inspect highland/app:0.1.0 --format '{{.Size}}'
```
Expected: growth ≤ 60 MB. If it is over, delete the unused `tesseract.js-core` variants (keep only the LSTM SIMD and non-SIMD files that `localEngineOptions` loads) and the `4.0.0` legacy model folder in the image's prune step, then measure again.

- [ ] **Step 5: Run the modest-box check** (build machine)

`deploy/smoke/ocr-modest-box.sh`:
- copies `modules/ocr/test/fixtures/receipts` into a temporary folder;
- runs `docker run --rm --cpus=2 --memory=2g --network none -v <tmp>:/corpus:ro highland/app:0.2.0 node modules/ocr/dist/bench.js /corpus/rendered --today 2026-03-31 --json /dev/stdout`, and the same for `/corpus/photos` when it has images;
- reads `docker inspect` for an OOM kill;
- writes `deploy/smoke/OCR-RESULT.md`: the date, the host's CPU model, the gate table filled in with the measured values, and PASS or FAIL per line.

Run: `bash deploy/smoke/ocr-modest-box.sh`
Expected: every line PASS. Commit `OCR-RESULT.md` as evidence.

- [ ] **Step 6: Write the docs**

- `docs/BUILDING-ON.md`, "Optional modules":
  - switching modules on in `app-profile.json`, which the factory writes from the approved brief (Plan 8's `nameApp` at the first build, in the BRAND-line commit, Plan 11 on a change: Contract 7.5);
  - **OCR:** copy the receipts pages' pattern. Staff always confirm; a client expense row stores the **confirmed** values and the reading's id, never the proposal; corrected field names are audited; nothing reads `proposal` after confirmation.
  - **Reports:** build one `MoneyReport` with `buildMoneyReport` and pass it to `renderPdf`, `renderXlsx` and the screen alike. Pin it with worked examples like `W1_MARCH` before the feature counts as done; serve it with `sendReport` from a `defineRoute` route.
  - **Scheduled jobs:** `registerAppJob` in a file imported from `apps/server/src/jobs/index.ts`; switch on `scheduled-jobs`; pick `catchUp`; jobs must be safe to run once late.
  - **Cloud OCR:** only when the brief's policy allows `azure-document-intelligence`, and only with the region rules; the app refuses to start otherwise.
- `docs/RUNBOOK.md`:
  - the OCR settings, and what staff see when a receipt can't be read;
  - setting up cloud OCR (the key goes in `.env` only; the data policy must already allow it);
  - `docker compose run --rm ops jobs`;
  - "a reading is slow": `OCR_CONCURRENCY` and the CPU.
- `npm run licences:doc` to regenerate `docs/LICENCES.md`. It now lists tesseract.js, the English model package, pdfjs-dist, write-excel-file, pdfkit (or not) and their trees. If `png-js` was accepted, add a sentence to the generated file's preamble template in `scripts/check-licences.ts` explaining the exception, as for Vite.
- `CHANGELOG.md`: check that Unreleased has one line per module and the Task 9a–9c lines, plus `[security]`-free entries.
- Count the routes in `apps/server/reports/crossing.json` after `npm test` (every module on); write the number in the hand-off.

Run: `npm run verify` → PASS (the docs test confirms LICENCES matches the lockfile).

- [ ] **Step 7: Full gate, merge and release**

```bash
npm run verify:full          # browsers + OCR accuracy (test:ocr)
git add -A && git commit -m "feat: optional-module images, smoke with hard kill and modest-box OCR proof, docs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git checkout main && git merge --ff-only plan12-modules
npm run release -- minor     # 0.1.0 -> 0.2.0: moves Unreleased, stamps foundation.json (name is highland-foundation, Task 9a), commits and tags v0.2.0 locally
git tag --list 'v*'          # expect v0.1.0 and v0.2.0
```
Expected: `verify:full` PASS; release prints the new tag; nothing is pushed.

- [ ] **Step 8: Hand-off**

Tell the operator:
- `v0.2.0` is tagged (local);
- the smoke result (with the hard-kill step) and the modest-box figures from `OCR-RESULT.md`;
- the crossing route count at v0.2.0 (Task 11's `foundationRoutes` default must equal it);
- whether the `png-js` exception is in place;
- for the acceptance run, set `factory.foundation.tag` to `v0.2.0` in Conductor's config (Plan 8's setting, Contract 7.2; Task 12 Step 1 checks it);
- the operator follow-up for photographed fictional receipts, if the `photos/` folder is still empty.
