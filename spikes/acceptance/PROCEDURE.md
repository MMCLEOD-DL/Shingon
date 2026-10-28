# The factory's acceptance test

The acceptance test (spec §8 item 9) proves that the factory can take one real client's meeting notes to a
finished app, ship it to a test box, and change it as an update, to the quality bar in spec §2. The operator
runs it over several sessions (Tasks 12 to 15 of Plan 12). This folder gives you:

- **the criteria** below, each tied to spec §2 and marked **auto** (the checker fills it in) or **operator**
  (you check it with your own eyes);
- **the checker**, `check-acceptance.mjs`, which reads the project folder and the app's own reports and fills in
  every automated criterion with its evidence. It never builds, deploys or calls a model: it only reads files;
- **the results template**, `RESULT-TEMPLATE.md`, for everything a person must see (real phones, alerts, a restore);
- **the rehearsal notes**, `rehearsal-notes.md`: fictional meeting notes for the dress rehearsal.

## The criteria

| Id | Spec | Criterion | How |
|---|---|---|---|
| C1 | §2.1 | The role-crossing harness ran on the finished build: the run's `crossing.json` has 0 failures and more routes than the foundation's own at v0.2.0 (`foundationRoutes`, 31), so at least one expenses route is checked. | auto |
| C2 | §2.1, §4.3 | The build's council report (`builds/<runId>/council-report.json`) has verdict `approved` or `approved-with-warnings`, no blocking items, and was **not** overridden (neither the report's `overridden` nor `build.json`'s `council.overridden`). | auto |
| C3 | §2.2 | Every acceptance example in the current approved brief is proven by a passing test: for each id from `acceptanceIds(brief)`, a test whose title contains `testTag(id)` (`[<featureId>#<n>]`, Contract 7.4) passed in the latest run's Vitest report (the change run when given, else the build). An example with no id, a tag with no test, or a tag whose only tests failed is a FAIL naming the id. | auto |
| C4 | §2.2 | The app's March report, downloaded from the preview as PDF and as a spreadsheet, shows exactly the totals worked out by hand from the brief's examples. | operator |
| C5 | §2.2, §2.5 | On the 10 fictional printed receipts, photographed through the app on a real phone, no field is ever filled in confidently wrong (no "Please check" missing on a wrong value). | operator |
| C6 | §2.3 | Every page has a screenshot at desktop width and phone width in Chromium and WebKit (`manifest.json`: every page has `desktop-chromium`, `mobile-chromium` and `mobile-webkit`). | auto |
| C7 | §2.3, §2.5 | On a real iPhone (Safari) and a real Android phone (Chrome): **Take a photo** opens the camera and uploads; **Choose a file** uploads a photo from the library and a PDF; the reading appears; correcting a field and confirming works; nothing scrolls sideways. | operator |
| C8 | §2.4 | On the test box: a manual backup, then `restore-test`, pass; then a real restore drill from the runbook returns a record count known beforehand. | operator |
| C9 | §2.4 | Stopping the app container sends a Matrix alert within 5 minutes, and starting it sends the recovery message. | operator |
| C10 | §2.4, §4.8 | The change request went out as an **update**: the deployment's `history` has an `installed` entry followed later by an `updated` or `confirmed` entry at the `currentVersion` (a trailing `already-on` is ignored), that version is newer than the installed one (`compareVersions`), and the last update that reached the box (outcomes that changed nothing are skipped) was not rolled back, urgent or lost contact. | auto |
| C11 | §2.5 | A member gets from "open the app" to a confirmed receipt in under 60 seconds on a phone, with no step that needs help. | operator |
| C12 | §3, §6 | The app's `app-profile.json` matches the approved brief: `policy.outbound` holds the same `OUTBOUND_SERVICES` ids (Contract 7.4), `residency` is equal, and `modules` contains every module the brief lists (here `ocr`). (Task 14 also checks `OCR_ENGINE=local` on the box by hand.) | auto |
| C13 | §5a | The latest council report has no blocking or warning item with `member: 'legal'` from the `licences` or `scancode` tool, and every entry in the app's `licence-exceptions.json` has a reason (Plan 9's Legal accepts those entries, Contract 7.7). | auto |
| C14 | §4.8 | The change run's own council report meets C2's rule, and every example id that is new in the current brief version (absent from `brief-v<N-1>.json`) is proven by a passing test in the change run's report. | auto |
| C15 | §1 | The operator never edited the app's code by hand (Ruling 9). Any hand edit is recorded with its reason, and counts as a FAIL for the factory. | operator |
| C16 | §3 | No paid-API spend unless opted in; frontier cost recorded per stage. | operator |
| C17 | Contract 7.5 | `project.json` records `foundation.tag` equal to the expected tag (`foundationTag`, `v0.2.0`, the value of `factory.foundation.tag` for this run) and status `shipped` at the end. | auto |

**Verdict:** the acceptance test **passes** only when every criterion passes. Any FAIL means fixing the factory
(Ruling 9) and re-running the stage it belongs to.

The checker checks C1, C6 and C13 on every run you name (the build and, when given, the change). C13 reads the
council reports of both runs.

It fails closed: a run counts only when its `build.json` is that run's own, of the kind the flag names (`--build` a
build, `--change` a change), approved, with its final checks on the approved commit and its reports in its own
`reports/` folder; the council report must pass Plan 11's own check for that commit. `app-profile.json` and
`licence-exceptions.json` are read from the app at the latest approved commit, and a hand edit to either in the app
folder is a FAIL (Ruling 9). Uncommitted changes anywhere in the app are noted under C15.

## The one rule: fix the factory, never the app

If a criterion fails, the fix goes into Conductor, a plan or the foundation (a normal reviewed change in that repo),
and the stage is run again. Never edit the client app's code by hand: a hand edit is itself a recorded failure (C15),
because the operator must never need to read or write code (spec §1).

## Where the results live

`<projectsRoot>/<slug>/acceptance/RESULT.md` (copied from `RESULT-TEMPLATE.md`), with the checker's tables beside
it (`checker-build.md`, `checker-ship.md`, `checker-final.md`). **Never in a repo**: it may name the client. The
meeting notes stay in the project's `notes/` folder. No real receipt, staff name or figure from the client goes into
a test, a fixture, a preview or a screenshot; phone tests use fictional printed receipts only.

## Running the checker

    node /root/conductor/spikes/acceptance/check-acceptance.mjs <projectDir> --build <runId> [--change <runId>] \
      [--deployment <name>] [--tests <file>] [--change-tests <file>] [--foundation-tag <vX.Y.Z>] \
      [--foundation-routes <n>] [--out <file>]

- `--build` is the approved build's run id (the folder name under `builds/`); `--change` the change run's.
- `--deployment` is the deployment name (for example `test-box`); it is needed for C10.
- The Vitest report comes from the run's own checks. If a run has none, make one by hand in the app with
  `npx vitest run --reporter=json --outputFile=<file>` and pass it with `--tests` (build) or `--change-tests`
  (change).
- `--foundation-tag` (default `v0.2.0`) and `--foundation-routes` (default 31, the foundation's own routes at
  v0.2.0) are only for a later foundation.
- It prints the criteria table (or writes it to `--out`) and exits 0 when every automated criterion passes,
  1 when one fails, and 2 when the arguments are wrong. Operator criteria show as "for the operator".

## Before you start (every stage)

- [ ] Plans 7 to 12 are merged; the foundation is tagged `v0.2.0`: `git -C /root/highland-foundation tag --list v0.2.0`
      prints `v0.2.0`.
- [ ] In Conductor's config, `factory.foundation.tag` is `"v0.2.0"` (the default `v0.1.0` has no modules, and the
      build refuses a brief that needs them).
- [ ] A factory machine is set up (the `static` provider pointing at CT 111, or the `proxmox` provider), and the
      models are awake (Conductor checks them before each run; see "Waking the local model" in the README).
- [ ] Note the Conductor commit for the results header: `git -C /root/conductor rev-parse --short HEAD`.

## Stage 1 (Task 12): dress rehearsal on fictional notes

Shakes out problems cheaply before the real notes are used. Nothing from it ships.

```bash
conductor project new "Glenmore Joinery (rehearsal)" --slug glenmore-joinery
conductor project show glenmore-joinery
mkdir -p ~/highland-projects/glenmore-joinery/acceptance
cp /root/conductor/spikes/acceptance/RESULT-TEMPLATE.md ~/highland-projects/glenmore-joinery/acceptance/RESULT.md
conductor brief glenmore-joinery --notes /root/conductor/spikes/acceptance/rehearsal-notes.md
```

- [ ] Answer the questions as Moira would (consistent made-up answers, noted in `RESULT.md`).
- [ ] Before approving, the brief has: director and workshop manager → `manager`, joiners → `member`, Jen → `admin`;
      both worked examples with their exact figures (£12.40 / £2.07 under Travel in March; Jamie's £53.75 / £8.96),
      each with an id `<featureId>#<n>`; `modules` with `ocr`, `xlsx-export` and `pdf-export`; `policy.outbound: []`,
      `residency: 'uk'`, `hosting: 'client-box'`, retention 6 years, backups to the NAS, `operatorAccess: true`;
      no open questions. Approve. Record the questions asked, minutes taken and frontier cost.

```bash
conductor build glenmore-joinery
```

- [ ] At the gate: record features built, council rounds (at most 4), blocking items fixed, warnings left, cost.
      Approve only if C2 holds (no blocking items, no override). `project.json` must show `foundation.tag: "v0.2.0"`.

```bash
conductor preview glenmore-joinery
```

- [ ] On a desktop browser and a phone, as a demo member: one receipt by **Take a photo**, one by **Choose a file**,
      with fictional printed receipts. Download the March report as PDF and spreadsheet.
      Then `conductor preview glenmore-joinery --stop`.

```bash
node /root/conductor/spikes/acceptance/check-acceptance.mjs ~/highland-projects/glenmore-joinery --build <runId> \
  --out ~/highland-projects/glenmore-joinery/acceptance/checker-build.md
```

- [ ] C1, C2, C3, C6, C12 and C13 pass. (C10, C14 and C17's `shipped` part are not reached in a rehearsal.)
- [ ] Passes when nothing needed a hand edit (C15) and those criteria pass. Otherwise list each defect with the plan
      it belongs to, get it fixed there, and repeat from the failing step with a fresh slug (`glenmore-joinery-2`, …).
- [ ] Verdict line: "Rehearsal passed on <date>; ready for the real notes." Stop the rehearsal's previews.

## Stage 2 (Task 13): the real notes, brief to preview

Criteria: C1, C2, C3, C4, C5, C6, C7 (on the preview), C11, C13, C15, C16.

```bash
conductor project new "<client name>"
mkdir -p ~/highland-projects/<slug>/acceptance
cp /root/conductor/spikes/acceptance/RESULT-TEMPLATE.md ~/highland-projects/<slug>/acceptance/RESULT.md
conductor brief <slug> --notes <path to the real notes>
```

- [ ] Answer from what the client said; where the notes don't say, stop and ask the client.
- [ ] Before approving: every role mapped to `admin`, `manager` or `member`; every report under `outputs` with its
      format; at least three worked examples with exact pounds and pence (one report total across several receipts,
      one VAT figure), each with its id, worked out by hand now into the C4 worksheet; `modules` with `ocr` and the
      export formats; the data policy as agreed (outbound expected `[]`). Approve; record questions, time, cost.

```bash
conductor build <slug>
```

- [ ] At the gate: record council rounds, blocking items fixed, warnings left, cost. Approve only when C2 holds. If the
      council is still blocked, do not override: record a factory defect, get it fixed, rebuild.

```bash
node /root/conductor/spikes/acceptance/check-acceptance.mjs ~/highland-projects/<slug> --build <runId> \
  --out ~/highland-projects/<slug>/acceptance/checker-build.md
conductor preview <slug>
```

- [ ] C1, C2, C3, C6, C12 and C13 pass; paste the table into `RESULT.md`.
- [ ] **C4:** enter the worked-example receipts as a demo member; download the month's report as PDF and spreadsheet;
      every total and VAT figure matches the hand-worked figure to the penny.
- [ ] **C7:** on the iPhone and the Android phone, **Take a photo** and **Choose a file** (a photo, then a PDF) work;
      the reading appears; correct a field; confirm; no sideways scrolling. Save a screenshot of each phone's
      "Check the details" page.
- [ ] **C5:** the 10 fictional printed receipts (5 per phone), each field recorded in the C5 table.
- [ ] **C11:** time three receipts from the home screen to "Receipt confirmed."; all under 60 s, with no help.
- [ ] Every page looks finished enough to charge for (spec §2.3); note anything clumsy as a warning.
- [ ] `conductor preview <slug> --stop`. Go on only when everything here passes.

## Stage 3 (Task 14): ship to a throwaway test box

Criteria: C7 (on the box), C8, C9, C12 (the box's part), C17 (tag). Never a client's box.

**The box.** A throwaway machine: CT 111 `hf-build`, or a container made by the `proxmox` machine provider. Set it up
once as in the README's "Before the first ship (once per box)": Docker with the Compose plugin, a deploy user in the
`docker` group, the folder `/opt/highland/test-box` owned by that user (this is the deployment's `<bundleDir>`),
`ssh-copy-id`, the host key checked into `known_hosts`, an alias in `~/.ssh/config`, the Matrix bot and alerts room,
and an Uptime Kuma push monitor. The first `conductor ship … --to test-box` asks for the rest and creates
`deployments/test-box.json`.

On the box, run every `docker compose` command below from the bundle folder: `cd <bundleDir>` first
(for example `cd /opt/highland/test-box`).

```bash
conductor ship <slug> --to test-box
conductor deployments status
```

- [ ] The app answers on the box; `deployments/test-box.json` starts with outcome `installed` (release `v1.0.0`) and
      records `foundation: "v0.2.0"`.
- [ ] **C12 on the box:** in `<bundleDir>`, `grep -E '^OCR_' .env` shows `OCR_ENGINE=local` and no `OCR_AZURE_KEY`;
      `docker compose exec app cat /app/app-profile.json` has `outbound: []`. Paste both.
- [ ] **C7 on the box:** both phones, signed in as an invited member, two fictional receipts each; record each
      reading's time from upload to fields shown (expected under 15 s).
- [ ] **C8:** run the three commands below on the box; both runs report success and `status --json` shows them as the
      latest `backup` and `restoreTest` with `ok: true`. Then the restore drill from the runbook ("Backups",
      "Restoring"): note the confirmed-readings count, confirm one more receipt, restore the earlier backup by its id
      with the runbook's steps, and check the original count is back. A step not in the runbook is a FAIL for the docs.

```bash
docker compose run --rm ops backup
docker compose run --rm ops restore-test
docker compose exec -T ops node ops/dist/cli.js status --json
```

- [ ] **C9:** `docker compose run --rm ops test-alert` arrives in the Matrix room; then `docker compose stop app`: an
      alert within 5 minutes; `docker compose start app`: a recovery message. Record both times. The Uptime Kuma
      heartbeat stays up while ops runs.

```bash
node /root/conductor/spikes/acceptance/check-acceptance.mjs ~/highland-projects/<slug> --build <runId> --deployment test-box \
  --out ~/highland-projects/<slug>/acceptance/checker-ship.md
```

- [ ] Go on only when C7, C8, C9 and C12 pass here.

## Stage 4 (Task 15): one change request and the verdict

Criteria: C10, C14, C15, C16, C17 (status), and the verdict. Use a change the client asked for, or the mileage change
in Task 15, written into `notes/change-mileage.md`.

```bash
conductor change <slug> --notes ~/highland-projects/<slug>/notes/change-mileage.md
```

- [ ] The change brief carries the worked examples exactly, each with a new id; unchanged examples keep theirs.
- [ ] At the gate: the council reviewed the **whole app**; record rounds, blocking items fixed, cost. Approve only
      when C2's rule holds for this report (C14).
- [ ] After the gate the same run releases (`minor`, `1.1.0`) and updates `test-box` itself, with a backup first. Do
      **not** run `conductor ship`. If it stopped part-way: `conductor change <slug> --resume`.

```bash
conductor deployments status
node /root/conductor/spikes/acceptance/check-acceptance.mjs ~/highland-projects/<slug> \
  --build <buildRunId> --change <changeRunId> --deployment test-box \
  --out ~/highland-projects/<slug>/acceptance/checker-final.md
```

- [ ] On a phone, a 132-mile claim shows £59.40, and the month's PDF and spreadsheet show it under "Mileage" with the
      totals still matching the C4 worksheet plus £59.40.
- [ ] The checker exits 0: every automated criterion passes, including C10, C14 and C17.
- [ ] In `RESULT.md`: every criterion C1–C17 PASS with its evidence; C15's list of hand edits empty; C16's cost per
      stage and paid-API spend £0 unless opted in; a short plain-English summary; the verdict line **PASS** or
      **FAIL** (with the failing criteria and where each fix belongs).
- [ ] Tidy up: on the throwaway box, `cd <bundleDir> && docker compose down -v`; if it was a `proxmox` machine, clear
      it with `conductor machines sweep` (or remove the container in Proxmox);
      keep `deployments/test-box.json` and `RESULT.md` in the project folder only.
