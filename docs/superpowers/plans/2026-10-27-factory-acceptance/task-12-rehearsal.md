# Task 12: Dress rehearsal on fictional notes

**Operator-run, with Conductor. The implementer does NOT run this task.**

Before spending the real client's notes, run the factory once end to end on the fictional Glenmore Joinery notes (`spikes/acceptance/rehearsal-notes.md`), as far as the preview. It shakes out problems in Plans 7–9 and in the modules cheaply. Whatever goes wrong is fixed in the factory or the foundation (Ruling 9), then this rehearsal is repeated until it passes. Nothing from it ships.

**Needs:** Task 10 (`v0.2.0` tagged), Task 11 merged (which needs Plans 7 and 10 merged), Plans 7, 8 and 9 merged, `factory.foundation.tag` set to `v0.2.0` (Plan 8's setting, Contract 7.2), the `static` machine provider pointing at CT 111 (or the `proxmox` provider set up), the workers awake (Plan 4).

**Files (operator's machine only, not committed):**
- `<projectsRoot>/glenmore-joinery/acceptance/RESULT.md`, copied from `spikes/acceptance/RESULT-TEMPLATE.md`

**Interfaces:**
- Consumes: Contract 5 commands `conductor project new`, `conductor brief`, `conductor build`, `conductor preview`; `check-acceptance.mjs` (Task 11).
- Produces: a filled rehearsal `RESULT.md`, and a list of factory defects (each fixed and re-tested before Task 13).

- [ ] **Step 1: Check the foundation tag, start the project and the results file**

In Conductor's config file, `factory.foundation.tag` must be `"v0.2.0"` (the default is `v0.1.0`, which has no modules). Check that the tag exists: `git -C /root/highland-foundation tag --list v0.2.0` prints `v0.2.0`.

```bash
conductor project new "Glenmore Joinery (rehearsal)"
conductor project show glenmore-joinery
mkdir -p ~/highland-projects/glenmore-joinery/acceptance
cp /root/conductor/spikes/acceptance/RESULT-TEMPLATE.md ~/highland-projects/glenmore-joinery/acceptance/RESULT.md
```
Expected: the project folder exists with `project.json` status `briefing`. (Use the slug `project new` prints if it differs.) After the build, `project.json` must show `foundation.tag: "v0.2.0"`; if it shows `v0.1.0`, the setting was not picked up: stop and fix it before going on.

- [ ] **Step 2: Brief**

```bash
conductor brief glenmore-joinery --notes /root/conductor/spikes/acceptance/rehearsal-notes.md
```
Answer the follow-up questions as Moira would (make up consistent answers; note them in `RESULT.md`). Before approving, check the rendered brief has:
- [ ] roles mapped: director and workshop manager → `manager`, joiners → `member`, Jen → `admin` (or a manager with a finance permission, if Plan 7 offers it);
- [ ] both worked examples as acceptance examples, with the exact figures (£12.40 / £2.07 under Travel in March; Jamie's £53.75 / £8.96), each with its id (`<featureId>#<n>`);
- [ ] `modules` contains `ocr`, `xlsx-export` and `pdf-export` (and `scheduled-jobs` only if a reminder was asked for);
- [ ] `policy.outbound: []` (no `OUTBOUND_SERVICES` id), `residency: 'uk'`, `hosting: 'client-box'`, retention 6 years, `backupDestination` the NAS, `operatorAccess: true`;
- [ ] `openQuestions` empty.
Approve. Record in `RESULT.md`: number of questions asked, minutes taken, frontier cost shown.

- [ ] **Step 3: Build, council, gate**

```bash
conductor build glenmore-joinery
```
Watch it to the operator gate. At the gate, read the council report and the summary, and record in `RESULT.md`: features built, council rounds used (at most 4), blocking items found and fixed, warnings left, frontier cost. **Approve only if C2 holds** (no blocking items, no override needed).

- [ ] **Step 4: Preview and look**

```bash
conductor preview glenmore-joinery
```
Open it on the LAN in a desktop browser and on a phone, signed in as a demo member. Do one receipt from **Take a photo** and one from **Choose a file**, using the fictional printed receipts. Download the March report as PDF and spreadsheet. Then `conductor preview glenmore-joinery --stop`.

- [ ] **Step 5: Run the checker**

The checker reads the build's own evidence in `builds/<runId>/` (Plan 8's reports and Plan 9's `council-report.json`); nothing has to be run by hand first.

```bash
node /root/conductor/spikes/acceptance/check-acceptance.mjs ~/highland-projects/glenmore-joinery --build <runId> \
  --out ~/highland-projects/glenmore-joinery/acceptance/checker-build.md
```
Expected: C1, C2, C3, C6, C12, C13 pass (C10, C14 and C17's `shipped` part are not reached in a rehearsal and show as failing; ignore them here).

- [ ] **Step 6: Decide**

The rehearsal **passes** when Steps 2–5 needed no hand edit to the app (C15) and the checker's build criteria pass. Otherwise, list each defect in `RESULT.md` with the plan it belongs to, get it fixed there (a normal reviewed change in that repo), and repeat from the failing step with a fresh project slug (`glenmore-joinery-2`, …).

When it passes, write the verdict line in the rehearsal's `RESULT.md`: "Rehearsal passed on <date>; ready for the real notes." Delete the rehearsal's preview machines (`conductor preview … --stop`; for `proxmox`, check `provider.sweep`).
