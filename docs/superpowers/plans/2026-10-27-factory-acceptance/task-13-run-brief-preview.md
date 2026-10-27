# Task 13: Real run, part 1 — brief to preview

**Operator-run, with Conductor. The implementer does NOT run this task.**

The acceptance test proper (spec §8 item 9): the expenses tracker for the 40–50 person company, **from the real meeting notes**, through brief, build, council, the operator's gate and preview. Criteria covered here: C1, C2, C3, C4, C5, C6, C7 (on the preview), C11, C13, C15, C16.

**Needs:** Task 12 passed; the real meeting notes (operator follow-up).

**Client data rule (spec §7, Ruling 10):** the notes go only into the project's `notes/` folder and to the brief step (Contract 1). **No real receipt, staff name or figure from the client goes into a test, a fixture, a preview or a screenshot.** Phone tests use the fictional printed receipts.

**Files (operator's machine only):** `<projectsRoot>/<slug>/acceptance/RESULT.md`, copied from the template.

**Interfaces:**
- Consumes: `conductor project new|show`, `conductor brief`, `conductor build`, `conductor preview` (Contract 5); `check-acceptance.mjs` (Task 11).
- Produces: an approved brief, an approved build, preview evidence, and the first half of `RESULT.md`.

- [ ] **Step 1: Project and results file**

```bash
conductor project new "<client name>"
mkdir -p ~/highland-projects/<slug>/acceptance
cp /root/conductor/spikes/acceptance/RESULT-TEMPLATE.md ~/highland-projects/<slug>/acceptance/RESULT.md
```
Fill in the header: date, Conductor commit (`git -C /root/conductor rev-parse --short HEAD`), foundation tag `v0.2.0`.

- [ ] **Step 2: Brief**

```bash
conductor brief <slug> --notes <path to the real notes>
```
Answer the questions from what the client said; if the notes don't say, write "ask the client" and stop until you have asked (an `openQuestions` entry blocks approval, by design). Before approving, check:
- [ ] every role the client named is mapped to `admin`, `manager` or `member`, with who approves whose claims;
- [ ] every report the client wants is under `outputs`, with its format (PDF and/or spreadsheet);
- [ ] at least **three** worked examples with exact pounds and pence, including one report total across several receipts and one VAT figure; work each out by hand now and write them in the C4 worksheet;
- [ ] `modules` lists `ocr` and the export formats;
- [ ] the data policy matches what the client agreed (hosting, outbound — expected `[]`, residency, retention, backup destination, operator access).
Approve. Record questions asked, time and cost (C16).

- [ ] **Step 3: Build, council, gate**

```bash
conductor build <slug>
```
At the gate, record the council rounds, blocking items fixed, warnings left and the cost. **Approve only when C2 holds.** If the council is still blocked after its rounds, do not override for the acceptance test: record it as a factory defect, get it fixed, and rebuild (Ruling 9).

- [ ] **Step 4: Automated evidence**

```bash
cd ~/highland-projects/<slug>/app && npx vitest run --reporter=json --outputFile=reports/test-results.json
node /root/conductor/spikes/acceptance/check-acceptance.mjs ~/highland-projects/<slug> --build <runId> \
  --out ~/highland-projects/<slug>/acceptance/checker-build.md
```
Expected: C1, C2, C3, C6, C12, C13 pass. Paste the table into `RESULT.md`.

- [ ] **Step 5: Preview — the operator's own eyes**

```bash
conductor preview <slug>
```
On the LAN, with the demo data:
- [ ] **C4:** load the brief's worked-example receipts as a demo member (type them in, or confirm fictional receipts with those values). Download the month's report as PDF and as a spreadsheet. Write each total and VAT figure in the C4 worksheet next to the hand-worked figure. Every figure must match to the penny.
- [ ] **C7 (preview part):** on the iPhone and the Android phone, **Take a photo** and **Choose a file** (a photo, then a PDF e-receipt) both work; the reading appears; correct one field; confirm; no sideways scrolling. Save a screenshot of each phone's "Check the details" page with its file name in `RESULT.md`.
- [ ] **C5:** photograph the 10 fictional printed receipts through the app (5 per phone). For each, fill in the C5 table: field, proposed value, was "Please check" shown, was it right. **Any wrong value without "Please check" is a FAIL.**
- [ ] **C11:** time a member from the home screen to "Receipt confirmed." for three receipts; all under 60 s, with no help.
- [ ] Look at every page on the phone once: it must look finished enough to charge for (spec §2.3). Note anything clumsy as a warning.

`conductor preview <slug> --stop`.

- [ ] **Step 6: Record and decide**

`RESULT.md` now has C1–C7, C11–C13, C15 and C16 filled in for this stage. If any is FAIL: record the defect and the plan or repo it belongs to, get it fixed there, and repeat from the step that failed (a rebuild is a new `conductor build`; the brief stays approved unless the defect was in it). Go on to Task 14 only when everything here passes.
