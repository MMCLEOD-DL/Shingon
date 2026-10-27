# Plan 12 — Optional modules and the expenses-tracker acceptance test (factory phase 9)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** Give the foundation the optional modules the expenses tracker needs (OCR with a confirm-or-correct pattern, PDF and spreadsheet export, scheduled app jobs) as foundation release v0.2.0, then prove the whole factory by building the expenses tracker from real meeting notes, through brief, build, council, gate, preview, ship and one change request, against pass/fail criteria taken from spec §2.

**Architecture:**
- **Two milestones in two repos.**
  - **M1 (Tasks 1–9, 9a–9c, 10)** is built in **`/root/highland-foundation`** by the operator with Claude Code in hand-steered sessions, exactly like Plan 6. It ends with the tag `v0.2.0`. Conductor is not touched in M1.
  - M1 also carries the **foundation follow-ups** Contract 7.9 assigns to v0.2.0 (Tasks 9a–9c): `scripts/release.ts` stamps `foundation.json` only for the foundation itself; `update --json`; `ops status --json`; `ops set-env`; `ops test-alert`; the smoke's `HF_SMOKE_DIR`/`HF_SMOKE_PROJECT` settings and a hard-kill step. Plans 9 and 10 stay on their v0.1.0 text parsers; switching them is a later Conductor follow-up.
  - **M2 (Tasks 11–15)** is the acceptance run. Task 11 adds a small, zero-dependency acceptance kit to **`/root/conductor`** (`spikes/acceptance/`). Tasks 12–15 are operator-run checklists that drive Plans 7–11's commands and fill in a results file. No new product code.
- **Modules are libraries plus a thin server and web integration.**
  - `modules/ocr`, `modules/pdf-export` and `modules/xlsx-export` are new npm workspaces (`@hf/ocr`, `@hf/pdf-export`, `@hf/xlsx-export`). They know nothing about HTTP or the database, so their correctness tests are fast and need no Postgres.
  - The server wiring lives in `apps/server/src/modules/<name>/`; the web wiring in `apps/web/src/modules/<name>/`.
  - Money arithmetic and the report model live in `packages/shared` (`money.ts`, `report.ts`), so the screen, the PDF and the spreadsheet all show totals computed **once, in integer pence**. The two export modules only lay out what the model already computed.
- **Opt-in through one committed file, `app-profile.json`, at the app's repo root:** `{ schema: 1, modules: [...], policy: { outbound: [...], residency } }`. Conductor writes it from the approved brief's `modules` and `policy` fields: Plan 8's `createApp` at the first build (committed with the BRAND line), and Plan 11 when a change alters them (Contract 7.5). `policy.outbound` holds ids from Conductor's `OUTBOUND_SERVICES` (Plan 7, Contract 7.4), which seeds `azure-document-intelligence`. The server reads it at start: a module's routes, queue and pages exist only when it is listed. The web build reads the same file at build time. The foundation ships it with `modules: []`, `outbound: []`, `residency: "uk"`: nothing on, nothing allowed out.
- **The data policy decides the OCR engine, twice locked.** A cloud engine is used only when (1) `app-profile.json` lists its outbound id in `policy.outbound`, (2) its declared region satisfies `policy.residency`, and (3) the deployment's `.env` selects it. Any mismatch stops the app at start with a plain-English reason; it never quietly sends receipts out. A failing cloud engine falls back to the local one (data stays on the box), never the other way round.
- **Scheduled jobs are not a new module.** The ops container's scheduler (Plan 6 Task 18/19: croner, no overlap, failure alerts) gains an **app-job registry**: client features declare jobs next to their code, and ops runs them exactly once per due time, catching up a missed run once after downtime. The `scheduled-jobs` profile flag switches them on.

**Tech Stack (new in this plan; everything else as Plan 6):** `tesseract.js` 7.0.0 (+ `tesseract.js-core` 7.0.0) and `@tesseract.js-data/eng` 1.0.0 for local OCR; `pdfjs-dist` 6.4.299 for the text layer of PDF receipts and for reading generated PDFs back in tests; `write-excel-file` 4.1.1 (+ `read-excel-file` 9.3.12, test only); `pdfkit` 0.20.2 (subject to Operator question 1). Conductor side: unchanged (Node ESM, zero dependencies, `node --test`).

**Spec:** `/root/conductor/docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §1: the expenses tracker (40–50 staff; receipts uploaded; OCR reads them; staff confirm; expense reports). It is the acceptance test (§8 item 9).
- §2: the quality bar. All five items are binding and are the M2 pass/fail criteria.
- §3 anti-goals: receipts never go to a cloud OCR the policy forbids; no surprise paid-API bills.
- §5: optional modules; local OCR on a modest CPU-only box; staff confirm every reading.
- §5a: permissive licences only. §6: the data policy profile drives local versus cloud OCR. §7: client data never goes to the factory's models.

**Roadmap:** `/root/conductor/docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md` (Contracts 1–7 and the cross-cutting rules are binding; Contract 7, the library seams, wins over anything here). M2 consumes Plans 7–11's commands (Contract 5) and the modules Contract 7.1 names, and assumes nothing beyond the contracts, except the items still open under Contract gaps.

**Foundation inputs:** `/root/highland-foundation` at `v0.1.0`: `README.md`, `docs/BUILDING-ON.md`, `docs/LICENCES.md`, `scripts/check-licences.ts`, the notes and files example, `ops/src/scheduler.ts` and `ops/src/daemon.ts`; for Tasks 9a–9c, `scripts/release.ts`, `ops/src/{cli,init-cli,init,update,checks,runs,alerts,durable}.ts` and `deploy/smoke/run-smoke.sh`; Plan 6's index and `DECISIONS.md` (`../2026-10-25-highland-foundation/`).

## Engine and library choices (spec §10 leaves these to the builder)

Licences below were read from the npm registry and from published tarballs on 2026-10-27. Each full dependency tree was resolved with a throwaway `npm i --package-lock-only` and every lockfile entry was checked against the foundation's `ALLOWED` list (`scripts/check-licences.ts`). Task 1 repeats this as a pre-flight before anything is installed in the foundation.

### Local OCR engine: **Tesseract (LSTM), via `tesseract.js` 7.0.0** — chosen

| Candidate | Licence | CPU-only | Verdict |
|---|---|---|---|
| **tesseract.js** 7.0.0 + tesseract.js-core 7.0.0 (Tesseract 5 compiled to WebAssembly) + **@tesseract.js-data/eng** 1.0.0 | Apache-2.0 / Apache-2.0 / MIT. Full tree is **14 packages, all on the allowed list.** | Yes; WebAssembly with SIMD, one worker thread per job | **Chosen.** Runs wherever Node runs: the Claude VM, the build machine, the `node:22-bookworm-slim` image, a client box. No `apt`, no native build, no Python. The licence gate sees every part, including the model data (it is an npm package). It works in Node worker threads, so a reading never blocks the web server. Cost: about 2× slower than native Tesseract, and about 45 MB on the app image (measured and budgeted in Task 10). |
| Native `tesseract-ocr` (Debian package) called as a child process | Apache-2.0 (Leptonica BSD-2) | Yes; fastest Tesseract | Rejected for now. It needs `apt` in the image and on every test machine (the Claude VM has none), and its OS-package licences sit outside the npm licence gate (Plan 6 Operator question 2). Kept as the upgrade path if Task 10's modest-box timing fails. |
| PaddleOCR (PP-OCR) via ONNX (`onnxruntime-node`) | Apache-2.0 / MIT | Yes | Rejected: better on crumpled photos, but needs separate detection and recognition models, our own pre- and post-processing, and a native runtime of about 50 MB. Too much new surface for v0.2.0. |
| docTR, EasyOCR | Apache-2.0 | Slow without a GPU | Rejected: Python plus PyTorch, hundreds of MB, poor on a modest CPU box. |
| Surya | GPL-3.0 | — | Rejected: copyleft (§5a). |

Configuration that matters:
- **LSTM only** (`OEM.LSTM_ONLY`), with the `4.0.0_best_int` English model (2.9 MB gzipped) from `@tesseract.js-data/eng`.
- **`langPath` is a local folder and `cacheMethod: 'none'`.** Without an explicit `langPath`, tesseract.js downloads the model from the jsDelivr CDN at run time; that must never happen on a client box (Task 3 pins it with a test, Task 10 proves it with `--network none`).
- Images are passed as `Buffer`s, never URLs (tesseract.js fetches URLs).

What the engine cannot read, and what happens instead:
- **HEIC photos.** The only HEIC decoder on npm (`libheif-js`, used by `heic-decode`) is LGPL-3.0, and `sharp` ships LGPL-3.0 `libvips`. So the server never decodes HEIC. Instead the **browser prepares every photo before upload** (Task 6): it decodes the photo (Safari decodes HEIC natively), applies the EXIF rotation, scales the longest side to 2000 px and re-encodes as JPEG. A HEIC that still arrives is marked "can't be read automatically" and staff type the details.
- **Scanned-picture PDFs.** PDFs are read through their text layer only (`pdfjs-dist`, Apache-2.0; e-receipts from rail, taxi and online shops have one). A PDF without text is marked unreadable. Rasterising PDFs would need a canvas library; that is later work.

### Cloud engine: an interface plus one adapter, **Azure AI Document Intelligence `prebuilt-receipt`** [call]
- It has UK regions (`uksouth`, `ukwest`), so `residency: "uk"` can be honoured.
- It returns receipt fields with confidences directly.
- It is called over plain `fetch` (REST), so there is no SDK dependency.
- It is tested only against a stub on 127.0.0.1. Using it live is an operator follow-up (an Azure resource, a key, and a policy that allows it).

### Exports
| Need | Choice | Licence (full tree) | Rejected |
|---|---|---|---|
| Spreadsheet | **write-excel-file 4.1.1**, Node entry `write-excel-file/node` | MIT; 2 packages (with `fflate`, MIT) | **exceljs 4.4.0:** 193 packages, three of which fail the gate (`buffers`: no licence; `chainsaw`: "MIT/X11"; `pako`: "MIT AND Zlib"), and old `unzipper`/`archiver` trees. **SheetJS `xlsx` 0.18.5:** the npm copy is abandoned and has a known prototype-pollution advisory; newer versions are not on npm. |
| Reading spreadsheets back in tests | **read-excel-file 9.3.12** (dev only) | MIT; 7 packages | — |
| PDF | **pdfkit 0.20.2** | MIT, but **`png-js` 2.0.0 has no `license` field** (its tarball's `LICENSE` file is MIT). The gate fails on it. Every pdfkit release fails the same way or worse. | **pdf-lib 1.17.1** and **jsPDF 4.2.1:** both pull `pako`, "(MIT AND Zlib)"; Zlib is permissive but is not on the allowed list. |
| Reading PDFs back in tests; PDF receipt text | **pdfjs-dist 6.4.299** | Apache-2.0; 13 packages | — |

PDF text uses the PDF standard fonts (Helvetica), so no font file is shipped and none needs a licence. Characters outside Windows-1252 (WinAnsi) are replaced with `?` rather than printed as garbage (Review Focus 4).

## Rulings made while scoping (decided, not open)

1. **Staff confirm every reading.** Nothing the OCR proposes is ever saved as an expense value until a person presses Confirm. Fields below `CONFIDENT = 0.85` are marked "Please check". Why: spec §2.5 and §5 [call].
2. **The one OCR safety number is "confidently wrong = 0".** Across every fixture, no field may come out wrong with a confidence at or above `CONFIDENT`. A wrong value marked "Please check" costs a tap; a wrong value that looks certain costs the client money. Accuracy thresholds are secondary and are set in Task 3.
3. **Money is integer pence everywhere.** VAT from a gross amount is `round half up(gross × rate ÷ (1 + rate))` in integer arithmetic. £12.40 at 20% gives £2.07, the spec's own example.
4. **Exports never calculate.** `buildMoneyReport` (shared) computes every subtotal and total once; the PDF and spreadsheet only lay it out. Spreadsheet totals are written as **values**, not formulas, so the file shows exactly the figure the app computed.
5. **OCR keeps no raw text.** A reading stores only the proposed fields, their confidences, warnings, and later the confirmed values and the list of corrected field names. The recognised text of a receipt is personal data and is thrown away. A reading is deleted with its file (`on delete cascade`).
6. **A reading follows its file's rules.** Asking for a reading needs edit rights on the file (owner or admin); others get **404**, as with `attachFile` (Plan 6 Task 10). Seeing a reading follows the file's visibility (a manager sees the team's). Confirming needs edit rights: a manager who can see the reading gets **403** (Ruling 2's order).
7. **Opt-in is decided at start-up, never per request.** A module that is not listed registers no routes, starts no queue or worker and shows no pages. The crossing harness and the browser gate always run with **every** module on, so a module's routes are always checked.
8. **`scheduled-jobs` reuses the ops scheduler** (no new package). App jobs run in the ops container, never in the app process, so they are stopped during an update (Plan 6 Ruling 6) and never run twice when the app restarts.
9. **The acceptance run fixes the factory, not the app.** If a criterion fails, the fix goes into Conductor, a plan or the foundation, and the stage is run again. A hand edit to the client app's code is itself a recorded failure (spec §1: the operator never needs to read or write code).
10. **No client data in tests or fixtures.** Receipt fixtures are rendered from fictional templates, or are fictional receipts the operator prints and photographs himself. Meeting notes stay in the project's `notes/` folder (Contract 1). Phone tests on the test box use fictional receipts only.

## Global Constraints

**M1, in `/root/highland-foundation` (Plan 6's constraints all still apply):**
- Work on branch `plan12-modules` from `main` at `v0.1.0`; fast-forward `main` at the end of Task 10, then tag with `npm run release -- minor` (gives `v0.2.0`). One commit per task. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Node `>=22.12`, TypeScript 6.0.3, ESM, `"module": "NodeNext"`, `.js` extensions in relative imports.
- Every dependency exact-pinned (`save-exact=true`), recorded in `package-lock.json`.
- `npm run licences` must pass. **A task that installs something and then fails the gate stops and asks the operator; it never adds a `licence-exceptions.json` entry on its own** (Plan 6 rule). The only planned exception is Operator question 1.
- `npm run verify` (lint + typecheck + licences + test) passes at every commit. Tasks that add pages also pass `npm run verify:full` where the Playwright browsers are installed.
- Every route through `defineRoute`; every row query filtered by `visibleTo`; every input `z.strictObject`; Plan 6 Ruling 2's status order is law; new routes get hand-written `EXPECTED_ROLES` and crossing cases.
- Plain UK English in every message staff or the operator see; no stack traces; secrets (`OCR_AZURE_KEY` joins the list) never in logs, audit details, API responses, alerts or snapshots.
- Money in integer pence; dates as `YYYY-MM-DD` strings for receipt dates; timestamps `timestamptz` UTC, shown in `Europe/London`.
- **Tests never reach the network beyond 127.0.0.1 / localhost and never use real client data.**

**M2, in `/root/conductor` and on operator machines:**
- Conductor stays Node ESM, zero dependencies, `npm test` (`node --test`). Task 11 works on branch `plan12-acceptance` from `master`, one commit, merged by the operator.
- Acceptance runs use a **throwaway test box** (CT 111 `hf-build` or a `proxmox`-provider machine), never a client box.
- Plain UK English in every file the operator reads.

## Review Focus

1. **A receipt that looks certain but is wrong.** A VAT registration number ("VAT No. GB 123 4567 89"), a phone number, a card's last four digits, "Subtotal", "Total savings £3.00" or "Change £7.60" taken as the total or the VAT. The reading must pick the real total, or mark the field "Please check". Never certain and wrong. Pinned in Task 2 (`extract.test.ts` "distractor lines") and Task 3 (the corpus's `confidentlyWrong === 0`).
2. **A sideways or upside-down phone photo, or an iPhone HEIC.** The browser rotates it upright and sends JPEG; if it cannot (old browser, HEIC on Chrome), the original is uploaded and the reading says plainly it couldn't be read, with the form still usable. Pinned in Task 6 (EXIF-rotated fixture through real Chromium and WebKit) and Task 5 (HEIC → `unreadable` with its sentence).
3. **The policy forbids outbound, but the box's `.env` asks for the cloud engine** (or the region is outside the residency). The app refuses to start with one plain sentence; no request ever leaves the box. Pinned in Task 4 (a 127.0.0.1 stub counts zero requests; start-up refusal text).
4. **Awkward text in exports:** a merchant called `=HYPERLINK("http://x","click")`, "Łódź Café 🍕", a 200-character merchant name, a refund of −£5.00. The spreadsheet stores formulas-looking text as plain text; the PDF prints `?` for unsupported characters and wraps long names; negative amounts read "−£5.00" and totals stay exact. Pinned in Tasks 7 and 8.
5. **The box was off when a monthly job was due, or ops restarts mid-job.** On start, a missed run happens once, not once per missed slot; a run already recorded for that due time never runs again. Pinned in Task 9 (`job_runs` primary key and `dueSince`).
6. **A box's settings written by a script.** `ops set-env` given an unknown key, a generated secret (`DB_PASSWORD`), a repeated key or a value with a carriage return must refuse and write nothing; on success it keeps every other line, the file's mode and owner, and never prints a value. `update --json` and `status --json` must print exactly one line on standard output with no secret in it. An app's own release must leave `foundation.json` byte for byte. Pinned in Tasks 9a and 9b.

## Operator questions (open; the plan's defaults let work start without them)

1. **pdfkit needs one licence exception: `png-js` 2.0.0**, whose `package.json` has no `license` field although the `LICENSE` file inside its published tarball is the MIT licence (checked 2026-10-27, `png-js-2.0.0.tgz`). Approve this entry in the foundation's `licence-exceptions.json`?
   ```json
   { "png-js@2.0.0": "MIT: the LICENSE file in the published package is the MIT licence; only the package.json field is missing. Approved by the operator on <date>." }
   ```
   **Needed before Task 8; Tasks 1–7 don't depend on it.** If the answer is no, Task 8 takes its "If the exception is refused" path: a small PDF writer of our own (`modules/pdf-export/src/writer.ts`, standard fonts only, no dependencies). The tests are identical either way. (`licence-exceptions.json` is keyed `name@version` by the installed folder name, per `scripts/check-licences.ts`.)
   Plan 9's Legal member treats the app's own `licence-exceptions.json` entries as accepted licences, showing their reasons (Contract 7.7), so the approved entry also clears the council on every client build built from v0.2.0.
2. **Should `Zlib` join the allowed licence list?** It is OSI-approved and permissive, like MIT. Allowing it would make `pdf-lib`, `jsPDF`, `jimp` and `exceljs`'s `pako` acceptable. **Default:** no change; this plan needs none of them.
3. **A cloud OCR account.** Is an Azure Document Intelligence resource in UK South wanted for any client? **Default:** no account; the adapter stays stub-tested only, and the expenses tracker's acceptance run uses the local engine (policy `outbound: []`). The `azure-document-intelligence` id is already in Conductor's `OUTBOUND_SERVICES` (Plan 7), so a brief can allow it later without any Conductor change.

## Operator follow-ups (outside the code)

- **Fictional receipts for the photo corpus (Task 3):** print the 8 rendered templates on an ordinary printer (thermal-style if available), crumple two, and photograph each with an iPhone and an Android phone, in daylight and under office light. No real receipts.
- **Docker build machine** (as Plan 6) for Task 10's image and modest-box check, and for the M2 test box.
- **Real meeting notes** for the expenses tracker (Task 13); a solicitor's check of §5a terms before the first contract (Plan 6 follow-up).
- **Two real phones** for M2: one iPhone (Safari) and one Android (Chrome), on the operator's LAN.

## Contract gaps (after Contract 7)

Settled by Contract 7 and removed from this list: how the brief reaches the app (`app-profile.json`, written by Plan 8 and rewritten by Plan 11, §7.5); the `policy.outbound` vocabulary (`OUTBOUND_SERVICES` ids, §7.4); the foundation tag setting (`factory.foundation.tag`, §7.2); example ids (`<featureId>#<n>`, test tag `[<featureId>#<n>]`, §7.4); where the council report is saved (`builds/<runId>/council-report.json`, §7.5); and the two licence-acceptance lists (Plan 9's Legal reads the app's `licence-exceptions.json`, §7.7).

Still open:
1. **The cloud region is outside the council's view** (still open). `@hf/ocr`'s `OUTBOUND_DESTINATIONS` mirrors Conductor's `OUTBOUND_SERVICES['azure-document-intelligence']` (same id and hosts; Task 4). The region is chosen in the deployment's `.env`, which the council never sees, so the app's start-up check (Task 4) is the only enforcement of `residency`.
2. **`scheduled-jobs` is not a separate module** (Ruling 8). Briefs may still list it; it only switches on app jobs in the ops scheduler. Brief `modules` values must be exactly `ocr`, `pdf-export`, `xlsx-export`, `scheduled-jobs` (the `MODULES` constant in `@hf/shared`, Task 1), which Plan 7's brief validator should share.
3. **Restore-test and alert evidence from a deployment** (still open for v0.1.0 apps). Contract 4's `history` records updates, not restore tests or alerts. Task 9b adds `ops status --json` and `ops test-alert` in v0.2.0, but Plan 10 keeps its v0.1.0 routes (Contract 7.9), so Task 14 collects the evidence by hand over SSH with those commands.

## Milestones

| Milestone | Tasks | Usable result at the end |
|---|---|---|
| M1a Profile and money | 1 | Module workspaces, `app-profile.json`, money helpers, licence pre-flight |
| M1b OCR | 2–6 | Receipt photos read on the box (or by an allowed cloud engine), proposed fields with confidences, staff confirm or correct on a phone |
| M1c Exports and jobs | 7–9 | Exact money reports as spreadsheet and PDF; scheduled app jobs in ops |
| M1c′ Foundation follow-ups | 9a–9c | App releases keep `foundation.json`; machine-readable `update`/`status`; `set-env`; `test-alert`; smoke settings and hard kill (Contract 7.9) |
| M1d Release | 10 | Images, smoke with hard kill, modest-box proof, docs, `v0.2.0` |
| M2a Kit | 11 | Acceptance criteria, evidence checker with tests, results template |
| M2b Runs | 12–15 | Dress rehearsal; the real expenses tracker built, shipped to a test box and changed once; signed results |

## File Structure

M1 paths are relative to `/root/highland-foundation`; M2 paths to `/root/conductor`.

| File | Responsibility | Task |
|---|---|---|
| `package.json` (workspaces `modules/*`, scripts), `vitest.config.ts`, `app-profile.json`, `packages/shared/src/{modules,money}.ts`, `apps/server/src/{appProfile,config}.ts`, `apps/web/vite.config.ts`, `modules/{ocr,pdf-export,xlsx-export}/{package.json,tsconfig.json,vitest.config.ts,src/index.ts}` | profile, opt-in plumbing, money helpers | 1 |
| `packages/shared/src/receipts.ts`, `modules/ocr/src/{extract,money-tokens,dates}.ts`, `modules/ocr/test/text-fixtures/*.txt` | receipt types; fields from recognised lines | 2 |
| `modules/ocr/src/{types,local,pdfText,bench}.ts`, `modules/ocr/test/fixtures/{make-receipts.ts,templates/*.html,receipts/*,expected.json}`, `modules/ocr/vitest.accuracy.config.ts` | Tesseract engine, PDF text layer, corpus, accuracy report | 3 |
| `modules/ocr/src/{azure,choose,fallback,destinations}.ts` | cloud adapter, policy gate, fallback | 4 |
| `apps/server/src/db/schema/receiptReadings.ts`, `apps/server/drizzle/*`, `apps/server/src/modules/ocr/{queue,repo,routes}.ts`, `apps/server/src/seed/seeders/receipts.ts`, `apps/server/test/crossing/resources/readings.ts` | readings table, queue, API, crossing, demo data | 5 |
| `apps/web/src/modules/ocr/{prepareImage,useReading,ReceiptReadingFields,ReceiptNew,ReceiptCheck}.ts(x)`, `apps/web/src/ui/FileDropzone.tsx`, `apps/web/src/{appPaths,routes,nav}.ts(x)`, `apps/web/e2e/{pages,flows.spec,fixtures}.ts` | prepare photo, confirm or correct, example pages, browser flows | 6 |
| `packages/shared/src/report.ts`, `modules/xlsx-export/src/xlsx.ts`, `apps/server/src/modules/exports/reply.ts`, `test/worked-examples.ts` | report model, spreadsheet, download helper | 7 |
| `modules/pdf-export/src/{pdf,winAnsi}.ts` (and `writer.ts` only if Operator question 1 is refused) | PDF | 8 |
| `apps/server/src/jobs/{registry,index}.ts`, `apps/server/src/db/schema/jobRuns.ts`, `ops/src/appJobs.ts`, `ops/src/daemon.ts` | app jobs in the ops scheduler | 9 |
| `scripts/{release,release.test}.ts`, `ops/src/{update,cli,init-cli}.ts`, `ops/test/update.test.ts` | app releases keep `foundation.json`; `update --json` | 9a |
| `ops/src/{status,setEnv,testAlert}.ts`, `ops/src/{runs,init,cli,init-cli}.ts`, `ops/test/{status,set-env,test-alert,init-cli}.test.ts`, `docs/RUNBOOK.md` | `ops status --json`, `ops set-env`, `ops test-alert` | 9b |
| `deploy/smoke/{run-smoke.sh,RESULT.md}`, `deploy/test/smoke.test.ts` | smoke settings, hard-kill step | 9c |
| `deploy/{Dockerfile,ops.Dockerfile,.env.example}`, `ops/src/{init,setEnv}.ts`, `deploy/smoke/{ocr-modest-box.sh,OCR-RESULT.md,RESULT.md}`, `README.md`, `docs/{BUILDING-ON,RUNBOOK,LICENCES}.md`, `CHANGELOG.md` | images, smoke run, modest-box proof, docs, release | 10 |
| `spikes/acceptance/{check-acceptance.mjs,PROCEDURE.md,RESULT-TEMPLATE.md,rehearsal-notes.md}`, `test/acceptance-check.test.js`, `test/helpers/acceptanceProject.js` | acceptance kit (Conductor repo) | 11 |
| `<projectsRoot>/<slug>/acceptance/RESULT.md` (operator's machine, not committed to either repo) | the filled-in results | 12–15 |

## Tasks

1. [Module workspaces, app profile and money helpers](task-01-profile-money.md)
2. [Receipt field extraction](task-02-extraction.md)
3. [Local OCR engine and the receipt corpus](task-03-local-engine.md)
4. [Engine choice under the data policy, and the cloud adapter](task-04-policy-cloud.md)
5. [Readings on the server](task-05-readings-server.md)
6. [Confirm or correct on the phone](task-06-confirm-web.md)
7. [Money reports and spreadsheet export](task-07-report-xlsx.md)
8. [PDF export](task-08-pdf.md)
9. [Scheduled app jobs](task-09-app-jobs.md)
9a. [Foundation follow-ups 1: release stamp and `update --json`](task-09a-release-stamp-update-json.md)
9b. [Foundation follow-ups 2: `ops status --json`, `ops set-env`, `ops test-alert`](task-09b-ops-status-set-env-test-alert.md)
9c. [Foundation follow-ups 3: smoke settings and a hard-kill step](task-09c-smoke-settings-hard-kill.md)
10. [Images, modest-box check, docs and v0.2.0](task-10-release.md)
11. [Acceptance kit (Conductor)](task-11-acceptance-kit.md)
12. [Dress rehearsal on fictional notes](task-12-rehearsal.md)
13. [Real run, part 1: brief to preview](task-13-run-brief-preview.md)
14. [Real run, part 2: ship and prove it runs](task-14-run-ship.md)
15. [Real run, part 3: one change request and the verdict](task-15-run-change-verdict.md)

Order matters:
- 2 needs 1; 3 needs 2; 4 needs 3; 5 needs 4; 6 needs 5.
- 7 needs 1; 8 needs 7 (and Operator question 1); 9 needs 1. 7–9 may run before or alongside 2–6.
- 9a, 9b and 9c need only `v0.1.0` and may run in any order, alongside 1–9 (9b's set-env key test is extended by Task 10).
- 10 needs 1–9 and 9a–9c.
- 11 imports Plan 7's modules (`projects.js`, `brief.js`, `acceptance.js`, `fsAtomic.js`) and Plan 10's (`deployments/store.js`, `foundationLog.js`), so it needs Plans 7 and 10 merged; it needs nothing from M1.
- 12 needs 10, 11 and Plans 7–10 merged; 13 needs 12; 14 needs 13 and Plan 10; 15 needs 14 and Plan 11.

## Shared Interfaces (all tasks)

```ts
// ── Task 1 · packages/shared/src/modules.ts
MODULES = ['ocr', 'pdf-export', 'xlsx-export', 'scheduled-jobs'] as const; type ModuleName = typeof MODULES[number]
RESIDENCIES = ['uk', 'uk-eu', 'any'] as const; type Residency = typeof RESIDENCIES[number]
AppProfileSchema = z.strictObject({ schema: z.literal(1), modules: z.array(z.enum(MODULES)), policy: z.strictObject({ outbound: z.array(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)), residency: z.enum(RESIDENCIES) }) })
type AppProfile = z.infer<typeof AppProfileSchema>
DEFAULT_PROFILE: AppProfile = { schema: 1, modules: [], policy: { outbound: [], residency: 'uk' } }
// apps/server/src/appProfile.ts
loadAppProfile(file: string): AppProfile      // missing file -> DEFAULT_PROFILE; bad JSON or shape -> ConfigError (plain English, one line per problem); duplicate module -> problem
// Config (Plan 6 Task 2) gains:
Config.profile: AppProfile                    // env APP_PROFILE (path), default <repo root>/app-profile.json; image: /app/app-profile.json
Config.ocr: { engine: 'local' | 'azure'; concurrency: number /* OCR_CONCURRENCY, default 1, 1..4 */; timeoutMs: number /* OCR_TIMEOUT_MS, default 60000 */;
              azure?: { endpoint: string; key: string; region: string } }    // OCR_AZURE_ENDPOINT/KEY/REGION, only read when OCR_ENGINE=azure
moduleOn(cfg: Pick<Config, 'profile'>, m: ModuleName): boolean
// apps/web: build-time constant from the same file
declare const __HF_MODULES__: readonly ModuleName[]

// ── Task 1 · packages/shared/src/money.ts
type Pence = number                               // a safe integer
toPence(text: string): Pence                      // '12.40', '£1,234.56', '-5.00' -> 1240, 123456, -500; throws MoneyError on >2 dp, junk, unsafe size
formatPounds(p: Pence): string                    // 1240 -> '£12.40'; 123456 -> '£1,234.56'; -500 -> '−£5.00' (U+2212); 0 -> '£0.00'
sumPence(values: readonly Pence[]): Pence         // throws MoneyError on a non-integer or an unsafe total
vatFromGross(gross: Pence, rateBasisPoints: number): Pence   // half up, integer only: (1240, 2000) -> 207; (3, 2000) -> 1; (1050, 500) -> 50
class MoneyError extends Error { userMessage: string }

// ── Task 2 · packages/shared/src/receipts.ts
type ReceiptField = 'amount' | 'vat' | 'date' | 'merchant'
interface Scored<T> { value: T; confidence: number }     // 0..1
interface ReceiptProposal { amountPence: Scored<Pence> | null; vatPence: Scored<Pence | null> | null; date: Scored<string> | null; merchant: Scored<string> | null;
                            currency: 'GBP' | 'other' | 'unknown'; warnings: string[] }   // vatPence.value null = "no VAT shown"
CONFIDENT = 0.85
ConfirmReadingInput = z.strictObject({ amountPence: z.int().min(1).max(10_000_000), vatPence: z.int().min(0).nullable(), date: IsoDate, merchant: z.string().trim().min(1).max(120) })   // + refine vat <= amount: 'The VAT can't be more than the total.'
type ConfirmedReceipt = z.infer<typeof ConfirmReadingInput>
correctedFields(p: ReceiptProposal | null, c: ConfirmedReceipt): ReceiptField[]   // fields whose confirmed value differs from the proposal (a missing proposal counts as corrected), in the order amount, vat, date, merchant
ReadingView = { id; fileId; status: 'pending' | 'read' | 'unreadable' | 'confirmed'; engine: string | null; proposal: ReceiptProposal | null; problem: string | null;
                confirmed: ConfirmedReceipt | null; corrected: ReceiptField[]; ownerId; createdAt: string; confirmedAt: string | null }
// modules/ocr/src/extract.ts
interface OcrLine { text: string; confidence: number }    // 0..1
extractReceipt(lines: readonly OcrLine[], opts: { today: string /* YYYY-MM-DD, Europe/London */ }): ReceiptProposal

// ── Task 3 · modules/ocr/src
type OcrInputType = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'application/pdf'
interface EngineFields { amountPence?: Scored<Pence>; vatPence?: Scored<Pence | null>; date?: Scored<string>; merchant?: Scored<string> }
interface OcrResult { engine: string; lines: OcrLine[]; fields?: EngineFields; warnings: string[]; ms: number }
interface OcrEngine { readonly id: string; readonly kind: 'local' | 'cloud'; readonly outboundId: string | null;
                      read(input: { bytes: Buffer; type: OcrInputType }): Promise<OcrResult>; close(): Promise<void> }
class UnreadableError extends Error { userMessage: string }    // the sentence staff see
createLocalEngine(opts?: { workers?: number; timeoutMs?: number }): Promise<OcrEngine>   // id 'local-tesseract', kind 'local', outboundId null
localEngineOptions(): { langPath: string; gzip: true; cacheMethod: 'none' }               // absolute folder inside @tesseract.js-data/eng
readReceipt(result: OcrResult, today: string): ReceiptProposal                           // engine fields win where present, then extractReceipt; VAT cross-check
writeAccuracyReport(r: BenchReport, file: string): Promise<void>
benchCorpus(engine: OcrEngine, dir: string, today: string): Promise<BenchReport>         // BenchReport = { cases, perField: Record<ReceiptField,{ right, wrongFlagged, confidentlyWrong, missing }>, msMedian, msMax }

// ── Task 4 · modules/ocr/src
OUTBOUND_DESTINATIONS: readonly { id: 'azure-document-intelligence'; hosts: readonly string[]; carries: string }[]   // mirrors Conductor's OUTBOUND_SERVICES entry (Contract 7.4)
RESIDENCY_REGIONS: Record<Residency, readonly string[] | 'any'>
createAzureReceiptEngine(cfg: { endpoint: string; key: string; region: string; allowHttpLoopback?: boolean; fetchImpl?: typeof fetch; pollMs?: number; timeoutMs?: number }): OcrEngine
chooseEngine(profile: AppProfile, ocr: Config['ocr'], make: { local(): Promise<OcrEngine>; azure(c: NonNullable<Config['ocr']['azure']>): OcrEngine }): Promise<OcrEngine>   // throws OcrPolicyError(problems: string[])
withFallback(primary: OcrEngine, fallback: OcrEngine): OcrEngine      // cloud -> local only
class CloudEngineError extends Error { userMessage: string }          // any cloud failure; never carries the key, headers or bodies
class OcrPolicyError extends Error { problems: string[] }

// ── Task 5 · apps/server
PERMISSIONS += { 'readings:read': ['admin','manager','member'], 'readings:confirm': ['admin','manager','member'] }
AUDIT_ACTIONS += 'reading.requested', 'reading.confirmed'
buildApp deps += { ocrEngine?: OcrEngine }            // main.ts builds it with chooseEngine; tests pass a fake
startReadingQueue(deps: { db: Db; storage: Storage; engine: OcrEngine; concurrency: number; maxBytes: number; today: () => string; log: (m: string) => void }): ReadingQueue
interface ReadingQueue { enqueue(id: string): void; idle(): Promise<void>; stop(): Promise<void> }
POST /api/files/:id/reading [readings:read]  -> 202 { reading: ReadingView }
GET  /api/readings/:id      [readings:read]  -> 200 { reading: ReadingView }
POST /api/readings/:id/confirm [readings:confirm] body ConfirmReadingInput -> 200 { reading: ReadingView }

// ── Task 6 · apps/web/src/modules/ocr
prepareReceiptImage(file: File, opts?: { maxSide?: number /* 2000 */; quality?: number /* 0.9 */ }): Promise<File>   // PDFs and undecodable files come back unchanged
FileDropzone props += { prepare?: (f: File) => Promise<File> }
AppPath += { module?: ModuleName }

// ── Task 7 · packages/shared/src/report.ts
interface ReportColumn { key: string; label: string; kind: 'text' | 'date' | 'money' }
interface ReportInput { title: string; periodLabel: string; generatedAt: Date; columns: ReportColumn[]; rows: Record<string, string | number>[]; groupBy?: string }
interface MoneyReport { title: string; periodLabel: string; generatedAtText: string; columns: ReportColumn[];
                        groups: { label: string | null; rows: Record<string, string | number>[]; subtotals: Record<string, Pence> }[];
                        totals: Record<string, Pence>; rowCount: number }
buildMoneyReport(input: ReportInput): MoneyReport     // throws MoneyError for a money cell that is not integer pence
formatCell(col: ReportColumn, v: string | number): string    // money -> formatPounds; date 'YYYY-MM-DD' -> 'DD/MM/YYYY'
// modules/xlsx-export
renderXlsx(report: MoneyReport): Promise<Buffer>
// apps/server/src/modules/exports/reply.ts
sendReport(reply: FastifyReply, report: MoneyReport, format: 'pdf' | 'xlsx', baseName: string): Promise<void>

// ── Task 8 · modules/pdf-export
renderPdf(report: MoneyReport, opts?: { appName?: string }): Promise<Buffer>
toWinAnsi(text: string): string

// ── Task 9 · apps/server/src/jobs/registry.ts
interface AppJob { name: string /* kebab-case */; label: string /* plain English, used in alerts */; cron: string; catchUp: 'once' | 'skip';
                   run(ctx: { db: Db; dueAt: Date; now: () => Date; log: (m: string) => void }): Promise<string /* one-line summary */> }
registerAppJob(job: AppJob): void ; appJobs(): readonly AppJob[] ; clearAppJobs(): void   // clear: tests only
// ops/src/appJobs.ts
dueSince(cron: string, after: Date, now: Date): Date | null      // latest due time in (after, now], or null
claimRun(db: Db, job: string, dueAt: Date): Promise<boolean>     // insert into job_runs; false if that due time already ran
runAppJob(deps: OpsDeps, job: AppJob, dueAt: Date): Promise<'ran' | 'already-ran'>
catchUpAppJobs(deps: OpsDeps, jobs: readonly AppJob[]): Promise<string[]>   // names caught up

// ── Task 9a · scripts/release.ts, ops/src/update.ts (Contract 7.9 items 1–2)
FOUNDATION_PACKAGE = 'highland-foundation'      // foundation.json is checked and stamped only when package.json.name equals it
UPDATE_EXIT = { updated: 0, cancelled: 1, 'rolled-back': 1, 'rollback-failed': 3 }
updateExitCode(o: UpdateOutcome): 0 | 1 | 3
updateOutcomeJson(o: UpdateOutcome | { refused: string; exitCode: 2 }, to: string | null): string
//   -> {"schema":1,"outcome":"updated|cancelled|rolled-back|rollback-failed|refused","to","message","urgent","exitCode"}
// cli: updater update --to <v> [--image-file <f>] --json   (progress on stderr, one JSON line on stdout)

// ── Task 9b · ops/src (Contract 7.9 items 3–5)
collectStatus(d: { cfg; db; now; checks }): Promise<OpsStatus>; statusLines(s): string[]
OpsStatus = { schema: 1, client, at, ok, checks: { name, ok, critical, detail }[],
              runs: { backup, backupOk, restoreTest, restoreTestOk, update: { at, ok, detail } | null } | null,
              outstandingUpdate: { at, snapshotId } | null, problems: string[] }
SETTABLE_ENV_KEYS; GENERATED_ENV_KEYS; parseSettings(input); applySettings(envText, settings); setEnvFile(file, input, fs?)
sendTestAlert(d: { cfg, channel, now, log }): Promise<{ ok, message }>
// cli: ops status [--json] · updater set-env < KEY=value lines · ops test-alert

// ── Task 9c · deploy/smoke/run-smoke.sh (Contract 7.9 item 6)
// env HF_SMOKE_DIR (default /tmp/hf-smoke), HF_SMOKE_PROJECT (default hfsmoke, never "highland"); step 7a: SIGKILL db, app, ops

// ── Task 11 · spikes/acceptance/check-acceptance.mjs (Conductor)
CRITERIA; FOUNDATION_V020_ROUTES; checkAcceptance(projectDir, opts) -> { results, ok }; renderResults(project, results) -> string
// imports: loadProject, loadBrief, currentBriefInfo, briefPaths, acceptanceIds, testTag, writeFileAtomic (Plan 7);
//          loadDeployment, compareVersions (Plan 10)
```

## Hand-off to the operator

- **After Task 10:** tell the operator that `v0.2.0` is tagged (local, not pushed), with the smoke result (including the hard-kill step) and the modest-box result from `deploy/smoke/OCR-RESULT.md`, the crossing route count at v0.2.0, and that `factory.foundation.tag` must be set to `v0.2.0` in Conductor's config for the acceptance run (Plan 8's setting, Contract 7.2).
- **After Task 11:** the operator merges `plan12-acceptance` in `/root/conductor`.
- **Tasks 12–15 are run by the operator.** An implementer prepares nothing for them beyond Task 11, and never runs them.
