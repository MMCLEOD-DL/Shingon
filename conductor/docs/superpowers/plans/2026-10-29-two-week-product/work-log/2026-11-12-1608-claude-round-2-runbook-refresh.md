# Claude: Windows acceptance round 2 runbook, reference counts and a missing folder step

```
Packet/subpacket: P07/P08 (Codex coordinates; Claude reviews). Correction to Claude's own runbook,
  work-log/2026-11-05-1933-claude-windows-acceptance-round-2.md.
Owner and reviewer: Claude; Codex reviews with the rest of the runbook.
Status: IN_REVIEW. Packet rows in 04-work-log.md are unchanged.
Baseline SHA: 038289d (PR113 merge). Branch: claude/kind-galileo-sxl3dv.
Files: conductor/docs/operator-app/windows-acceptance-round-2.md. No code, test, service or workflow change.
```

## Why

Malcolm is about to run the runbook, and its first rule is "stop at the first surprise". Two of its reference
numbers dated from `6f636ac` and changed when K8 slice 4 (PR112) added four view tests and a journey step. A
correct Windows run would therefore not have matched them.

## What changed

- Part A, `npm test`: 74 becomes **78** (Linux, `038289d`).
- Part A, browser journeys: 21, 6 and 4 become **22, 6 and 4**.
- Part A, native engine checks: there was no reference before. It now gives the Linux result: 9 tests, 8 passed,
  1 skipped. The skipped test is the Windows-only fixture-timeout test, so all 9 should run on Windows.
- Part B: `mkdir C:\conductor-trial-2` before step 3. The checklist's step 3 writes `ask.json` into the trial folder,
  which in a new folder does not exist until step 4.

## Checks

These are the Linux reference numbers, run in the cloud container on Linux with Node 22.23.4 at `038289d`. They are
synthetic, using fixture and stand-in workers with no models:

- `conductor/operator-web`:
  - `npm ci`: ok.
  - `npx vitest run`: 78 passed (3 files).
  - `npm run build`: ok.
  - `node e2e/journey.mjs`: 22 + 6 + 4 passed, exit 0.
- `conductor`: `node --test test/stub-cli.test.js test/service/engine.test.js` gave 9 tests, 8 passed, 0 failed and
  1 skipped ("native Windows fixture timeout ends the launcher and its Node child").

Nothing was run on Windows.

## State of the runbook's dependencies at `038289d`

- **Part E is still blocked.** Codex's start-of-run test check (PR71 R1, decided on 5 November) has not been
  implemented. No branch or PR exists for it, and `work-log/2026-11-05-1930-claude-pr71-r1-decision.md` still says
  NOT_STARTED.
- Parts A, B, C, D and F depend on nothing unmerged.
- Codex has not yet reviewed the runbook, as the 5 November entry asked. The review is not a precondition for running
  it.
