# Acceptance test result

Copy this file to `<projectsRoot>/<slug>/acceptance/RESULT.md` and fill it in as you go. Keep it in the project
folder only: it may name the client, so it never goes into a repo. The criteria and the steps are in
`spikes/acceptance/PROCEDURE.md`.

## Header

| | |
|---|---|
| Client (slug) | |
| Rehearsal or real run | |
| Dates (each session) | |
| Foundation tag (`factory.foundation.tag`) | v0.2.0 |
| Conductor commit (`git -C /root/conductor rev-parse --short HEAD`) | |
| Build run id | |
| Change run id | |
| Deployment name | test-box |
| Run by | |

## Stage 1 or 2: brief

- Questions asked: 
- Minutes taken: 
- Frontier cost shown (C16): 
- Answers made up (rehearsal only) or "ask the client" items, and what the client said:

## Stage 1 or 2: build, council and gate

- Features built: 
- Council rounds used (at most 4): 
- Blocking items found and fixed: 
- Warnings left: 
- Overridden at the gate? (must be no for C2): 
- Frontier cost (C16): 
- `project.json` `foundation.tag` after the build: 

Checker table (`checker-build.md`), pasted:

```
```

### C4 worksheet: the March report against the hand-worked figures

| Brief example (id) | Receipts in it | Hand-worked total | Hand-worked VAT | PDF total | PDF VAT | Spreadsheet total | Spreadsheet VAT | Match to the penny? |
|---|---|---|---|---|---|---|---|---|
| | | | | | | | | |
| | | | | | | | | |
| | | | | | | | | |
| After the change: + mileage (£59.40, no VAT) | | | | | | | | |

### C5: the 10 fictional printed receipts

A wrong value with no "Please check" is a FAIL.

| Receipt | Phone | Field | Proposed value | "Please check" shown? | Right? |
|---|---|---|---|---|---|
| 1 | | merchant | | | |
| 1 | | date | | | |
| 1 | | total | | | |
| 1 | | VAT | | | |
| 2 | | | | | |

### C7: real phones (preview, then the box)

| Check | iPhone (Safari) | Android (Chrome) |
|---|---|---|
| **Take a photo** opens the camera and uploads | | |
| **Choose a file**: a photo from the library | | |
| **Choose a file**: a PDF | | |
| The reading appears (time from upload to fields shown) | | |
| Correcting a field and confirming works | | |
| Nothing scrolls sideways | | |
| Screenshot file of "Check the details" | | |

### C11: from "open the app" to "Receipt confirmed."

| Try | Phone | Seconds | Any step that needed help? |
|---|---|---|---|
| 1 | | | |
| 2 | | | |
| 3 | | | |

Pages that look clumsy (warnings, spec §2.3):

## Stage 3: ship to the test box

- `conductor ship <slug> --to test-box` output (first lines and the result):

```
```

- Version shipped (expected v1.0.0) and the first `history` outcome (expected `installed`): 
- **C12 on the box:** `grep -E '^OCR_' <bundleDir>/.env` and `docker compose exec app cat /app/app-profile.json`:

```
```

### C8: backup, restore-test and the restore drill

```
docker compose run --rm ops backup
docker compose run --rm ops restore-test
docker compose exec -T ops node ops/dist/cli.js status --json
```

Output, pasted:

```
```

- Count before (confirmed readings): 
- Count after confirming one more: 
- Backup id restored: 
- Count after the restore (must equal the count before): 
- Any step not in the runbook (a FAIL for the docs): 

### C9: alerts

- `ops test-alert` arrived in the Matrix room at: 
- `docker compose stop app` at: ; alert arrived at: (within 5 minutes?)
- `docker compose start app` at: ; recovery message at: 
- Uptime Kuma heartbeat stayed up while ops ran: 

Checker table (`checker-ship.md`), pasted:

```
```

## Stage 4: the change request

- The change (client's own, or the mileage change): 
- New example ids in the change brief: 
- Council rounds, blocking items fixed, whole app reviewed? (C14): 
- Frontier cost (C16): 
- `conductor deployments status` after the update (expected: updated to 1.1.0, with a backup taken first):

```
```

- On a phone, 132 miles shows £59.40: 
- The month's PDF and spreadsheet show it under "Mileage", totals still match the C4 worksheet plus £59.40: 

Checker table (`checker-final.md`), pasted (exit code must be 0):

```
```

## C15: hand edits to the app's code

Expected: none. Any entry here is a FAIL for the factory.

| When | File | What was changed | Why | Where the factory fix went |
|---|---|---|---|---|
| | | | | |

## C16: cost

| Stage | Frontier cost | Paid-API spend (must be £0 unless opted in) |
|---|---|---|
| Brief | | |
| Build and council | | |
| Ship | | |
| Change | | |
| Total | | |

## Defects found and where each fix went

| Criterion | What went wrong | Plan or repo of the fix | Fixed in (commit) | Stage repeated? |
|---|---|---|---|---|
| | | | | |

## Summary for the operator

What was built, what it cost, what went wrong on the way and where each fix went, and anything to watch before the
real client box (open warnings, slow steps, OCR accuracy on the photos):

## Verdict

Every criterion C1–C17 PASS? 

**Verdict:** PASS / FAIL (with the failing criteria and the plan each fix belongs to) — date:
