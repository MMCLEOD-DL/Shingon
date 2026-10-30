# Codex re-review: P04 approval-evidence corrections (PR29)

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Correction owner: Claude.
Correction: `70db662e722d0881437813a8f88772164b7f713a` (PR29).
Reviewed integrated baseline: `7e4ce8320339f7c4af6051ad8024925642f1566a` (PR33/34 merged).

**Disposition: P04-R1 and P04-R2 resolved in the reviewed source.** No new blocking finding
in this correction. The entire supported diff is inspectable before approval; the displayed
review must name the current question's commit, diff and ordered test reports. Older review
responses cannot replace newer evidence. Existing N6 recovery review remains accepted.
This closes the examined UI findings, not P05/P07/P08 or live-model acceptance.

## P04-R1: full diff before approval

`components/Evidence.jsx` now uses a 1 MiB diff-display bound. `diffShownInFull` derives
completeness from the same cleaned text as the renderer, not from a DOM marker or commit
match. `RunView.jsx` requires completeness before enabling approval and explains why an
oversized diff cannot be approved on this page.

The independent 450k-character case now shows its final material-change sentinel, has no
clipping marker and remains approvable. The smaller complete 375k case also passes. The
normal UI suite exercises exactly-at-bound and above-bound cases: the former is complete
and approvable, the latter clipped and disabled. The bound is defensive; a fabricated
above-bound DOM fixture is not a claim that the real worker accepts that payload.

This accepts the full-inspection option from the original review. The alternative suggestion
to direct service-question approval to a CLI was unsuitable: that route does not exist.
No new CLI approval flow or increased service payload limit is required or claimed here.

Reviewed locations: `conductor/operator-web/src/components/Evidence.jsx:4–14`,
`src/text.js:7–16`, `src/views/RunView.jsx:66–88`.

## P04-R2: current question, current evidence

`sameEvidence` compares the commit, diffId and ordered testReportIds. Mismatched evidence
is hidden and approval remains disabled. A question id/revision change clears cached review
state. The review request counter allows only the latest review request to set evidence.
The same-commit/new-report case no longer treats a commit match alone as sufficient.

The standalone browser control runs the built UI against the real HTTP/SSE service, a real
synthetic Git workspace and a deterministic IPC worker. It holds an earlier passed-review
response, interrupts and resumes the run at the same commit with new failed-test evidence,
and separately verifies the server's current failed report and changed report IDs.

After releasing the old response while the current response is still held:

```json
{"currentReportPassed":false,"stalePassedLabel":0,"currentFailedLabel":0,"approveEnabled":false}
```

Once current evidence arrives, the failed report is visible, the passed label remains absent
and approval becomes enabled. That is intentional: the service permits explicit approval
of failed checks, so truthful disclosure is the requirement. The strengthened browser
control now asserts this positive state as well as the absence of the unsafe state. It sends
no approval, creates no result branch, and verifies source HEAD/index/files remain unchanged.

Reviewed locations: `conductor/operator-web/src/views/RunView.jsx:24–35,173–199`.
The normal suite additionally releases an older response after the current failed review
is already displayed, confirming it cannot overwrite the current evidence.

## Reproducer disposition and regression sensitivity

The old DOM fixture expected the old clipped-tail and visible-stale-report states as
preconditions. Those are no longer correct expectations after the accepted correction.
The retained [DOM controls](fixtures/p04-review.spec.js) now assert full visibility of the
450k tail, hidden mismatched evidence, disabled approval while mismatched, and a complete
same-evidence positive case. **3/3 pass** on current source.

The same updated controls against an external archived pre-PR29 UI (`33c0dd2`), sharing
only the installed lockfile dependencies, yield **2 failures / 1 pass**, expected exit 1.
The two correction assertions fail; the complete-diff positive control passes. No existing
checkout was reset and no product source was changed for the comparison.

The [real-service browser fixture](fixtures/p04-stale-review-browser.mjs) exits **0** on the
current build with `NOT_REPRODUCED` and its new current-failed-evidence control passing.
Its worker and service evidence are unchanged; only assertions were strengthened. Historical
pre-fix browser reproduction remains in the initial review; it was not rerun here.

## Validation and limits

Host: native Windows, Node 24.12.0; existing UI lockfile dependencies (Vitest 5.0.5,
Vite 7.3.7); Playwright 1.64.1 with system Microsoft Edge, headless Chromium engine.
A local preload selects Edge for the journey; another only sets child `windowsHide`.
Neither changes provider behaviour, service checks, test assertions or production source.
This is separate from hosted pinned-Chromium evidence.

From `conductor/operator-web/`:

- `npm test`: **59 passed**, zero failures/skips, two files, 4.46 s.
- `npm run build`: **passed**, 37 modules, 254.60 kB JS / 80.06 kB gzip, 486 ms.
- `node e2e/journey.mjs`: **19 passed, 0 failed** against the real service with fixture workers.
- Standalone review config: **3 passed**, zero failures/skips, 2.35 s.

For the standalone config, from `conductor/operator-web/`:

```powershell
./node_modules/.bin/vitest.cmd run --config ../docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p04-review.config.mjs
```

For the browser race control, from repository root (after building the UI):

```powershell
$env:NODE_PATH=(Resolve-Path 'foundation/node_modules').Path
$env:P04_BROWSER_EXECUTABLE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p04-stale-review-browser.mjs
```

Omit the browser override where Playwright Chromium is installed. Expected current exit 0.
The journey checks actual HTTP/SSE decisions, bootstrap reuse, literal hostile content,
focus/reload, approval/rejection, phone overflow, recovery, stale tabs and service restart.
Workers are synthetic; ordinary journey approval is not model-generated branch acceptance.
No fresh visual, axe or screen-reader audit was performed. Full Conductor/Foundation/DB
suites, live model/subscription probes, private input, deployment and remote hosts were unrun.
`git diff --check` passes before submission. Only review artifacts and the ledger changed.

## Handoff

P04-R1/R2 are closed at the reviewed baseline, retaining the earlier N6 disposition.
P04's examined UI work is DONE; broader integration and live acceptance remain separate
P05/P07/P08 work. Next peer reviews are the KB retrieval-contract corrections in PR31/34;
P09 and the recorded Windows console follow-up remain backlog. P02-R3 stays with Claude.
