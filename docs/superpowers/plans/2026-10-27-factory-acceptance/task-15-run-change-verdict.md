# Task 15: Real run, part 3 — one change request and the verdict

**Operator-run, with Conductor. The implementer does NOT run this task.**

Spec §4.8: a client change goes through the same factory as an **update**, with a full-app council and a backup first. This stage makes one such change on the shipped test box, then closes the acceptance test with a verdict. Criteria covered: C10, C14, C15, C16, C17 (status), and the verdict.

**Needs:** Task 14 passed; Plan 11 merged.

**The change** [call]. Use one the client actually asked for, if any. Otherwise use this one, which has a number rule to prove:

> **Mileage claims.** Staff can claim business miles driven in their own car at the HMRC approved rates: 45p a mile for the first 10,000 business miles in the tax year (6 April to 5 April), 25p a mile after that. A claim records the date, from, to, the purpose and the miles. Mileage appears in the monthly report under its own category, "Mileage", with no VAT.
>
> Worked examples:
> - 132 miles on 12 March 2026 → **£59.40**.
> - A member who has already claimed 9,950 miles this tax year claims 100 more → 50 at 45p + 50 at 25p = **£35.00**.
> - The first claim on 6 April 2026 starts a new tax year: 9,950 miles claimed before 6 April do not count, so 100 miles → **£45.00**.

Write these into `notes/change-mileage.md` in the project folder (they are not client data).

**Interfaces:**
- Consumes: `conductor change <slug> --notes <file>`, `conductor ship <slug> --to test-box` (as an update), `conductor deployments status` (Contract 5); `check-acceptance.mjs` (Task 11).
- Produces: the finished `RESULT.md` with the verdict.

- [ ] **Step 1: Change brief, build, council, gate**

```bash
conductor change <slug> --notes ~/highland-projects/<slug>/notes/change-mileage.md
```
Check the change brief carries the three worked examples exactly, each with a new id (the next unused `n` for its feature; unchanged examples keep theirs, Contract 7.4). At the gate, record the council rounds, any blocking items fixed, and the cost. The council must review the **whole app** (Contract 6); check the report says so. Approve only when C2's rule holds for this report (that is C14).

- [ ] **Step 2: Ship as an update**

```bash
conductor ship <slug> --to test-box
conductor deployments status
```
Expected: the update takes a backup first (visible in its output and in `ops` on the box), the health gate passes, and `deployments/test-box.json` ends with outcome `updated` at the new version (a `minor` release cut by `releaseApp` from the change gate's approved commit, delivered through `updateDeployment`; Contract 7.6). Confirm on a phone that a mileage claim of 132 miles shows £59.40, and that the month's PDF and spreadsheet show it under "Mileage" with the totals still matching the C4 worksheet plus £59.40.

- [ ] **Step 3: Full checker run**

```bash
node /root/conductor/spikes/acceptance/check-acceptance.mjs ~/highland-projects/<slug> \
  --build <buildRunId> --change <changeRunId> --deployment test-box \
  --out ~/highland-projects/<slug>/acceptance/checker-final.md
```
Expected: exit 0, every automated criterion passes, including C10, C14 and C17.

- [ ] **Step 4: The verdict**

In `RESULT.md`:
- [ ] every criterion C1–C17 is PASS, with its evidence filled in;
- [ ] C15: the list of hand edits to the app's code is empty;
- [ ] C16: total frontier cost per stage, and paid-API spend £0 unless opted in;
- [ ] a short plain-English summary for the operator: what was built, what it cost, what went wrong on the way and where each fix went, and anything to watch before the real client box (open warnings, slow steps, OCR accuracy on the photos).

Write the verdict line: **PASS** (the factory has built, shipped and changed its first real app to the quality bar) or **FAIL** (with the failing criteria and the plan each fix belongs to).

- [ ] **Step 5: Tidy up**

- Stop and remove the test box's deployment if the box is throwaway (`docker compose down -v` on it, or `provider.sweep` for `proxmox` machines). Keep `deployments/test-box.json` and `RESULT.md` as the record.
- Keep `RESULT.md` in the project folder only. It may name the client, so it goes into no repo.
- Update the Conductor memory notes with the verdict and the date.
- The real client deployment (on their own box) is a separate, ordinary `conductor ship` after the client's sign-off, outside this plan.
