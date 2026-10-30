# Codex review: P04 operator UI and N6 recovery

Date: 30 October 2026 (Europe/London). Reviewer: Codex. Implementation owner: Claude.
Reviewed integrated baseline: `bee4ae1397da88f1d51ae4c5c936f5eca71ef1b8` (PR #24 merged).
Includes P04 and N6 from PR #15, plus the current service evidence/recovery contract.

**Disposition: changes requested for two approval-evidence findings.** The existing unit,
production build and real-service browser journey pass, including N6 inspection/recovery.
Additional controls show that a clipped diff remains approvable and that an older passed
test report can be displayed for a newer failed review at the same commit. Preserve the
working controls; these findings concern completeness and identity of the evidence shown.

> Follow-up: [PR29 correction re-review](2026-10-30-codex-review-P04-correction.md) closes P04-R1/R2. Retained DOM controls now assert the accepted full-diff/hidden-stale behaviour and pass; failure instructions below describe the original review state.

## P04-R1 — [P1] An inaccessible diff tail can still be approved

Location: `conductor/operator-web/src/components/Evidence.jsx:4-6`;
`src/views/RunView.jsx:54-55,71-74`.

Trigger: an otherwise valid review carries an approximately 450,000-character diff, with a
material change after character 400,000. This is below the worker's 1 MiB JSON payload ceiling
(`conductor/src/service/worker.js:22`); ordinary Git diff acquisition has no smaller output cap.

Observed: Diff calls `plain(diff, 400000)`. The tail is replaced by a "more characters not
shown here" marker, and there is no control or endpoint in this view to inspect the omitted
diff. Approve stays enabled because evidenceShown checks the commit, not whether the diff
was displayed in full. The operator can therefore approve a commit without being able to
inspect all its changes in this UI. The marker does disclose clipping; it does not restore
access to the evidence or satisfy the full-review approval requirement.

Independent DOM reproduction: [p04-review.spec.js](fixtures/p04-review.spec.js), P04-R1.
It supplies a service-sized diff with a sentinel in its tail, verifies the sentinel is
absent and the clipping marker is present, then expects approval to be disabled. Actual:
**disabled=false**, so the regression fails. A second, complete 375k-character diff control
shows its final sentinel and keeps approval enabled.

Requested correction (Claude owns UI): make the entire diff inspectable before approval,
or explicitly refuse UI approval above the display bound and direct the operator to the
CLI. Keep the payload bound. Track truncation independently of rendered text and apply it
to the approval gate; a commit match alone is not sufficient. Add below/at/above-bound
regressions with a material tail change. Do not silently raise a limit while still clipping.

## P04-R2 — [P1] A stale passed report authorises the UI for newer failed evidence

Location: `conductor/operator-web/src/views/RunView.jsx:54-55,162-170`.

Trigger: two reviews for the same run and same Git commit have different testReportIds.
A GET of the earlier passed review is delayed. The run is interrupted and explicitly
resumed, producing a new question/revision with a failed report at that unchanged commit.
The old GET completes before the new review response.

Observed in the production browser build against the real service:

```json
{
  "finding":"P04-R2",
  "result":"REPRODUCED",
  "currentReportPassed":false,
  "stalePassedLabel":1,
  "currentFailedLabel":0,
  "approveEnabled":true
}
```

The current question's prompt is visible but the tests are the old green report.
`refresh` permits any earlier response to setReview, and evidenceShown accepts any review
with the matching commit. It does not compare diffId/testReportIds or bind the response to
the decision/revision that requested it. The answer sends the current decision's revision,
so backend stale-decision protection alone does not prove the operator saw current tests.
The service permits explicit approval of failed checks; accurate disclosure is essential.

Reproduction uses a real Git Workspace, current HTTP/SSE service and built UI, with a
synthetic IPC worker producing passed then failed reports. Playwright delays only response
delivery: no review body, decision, service check or UI assertion is rewritten. The live
service review endpoint is separately checked to confirm failed tests, an unchanged commit
and changed report IDs. Releasing the current response then shows the red failed report.
No approval is sent and no branch is landed; source HEAD/index/files remain unchanged.

The [browser reproduction](fixtures/p04-stale-review-browser.mjs) and its
[worker](fixtures/p04-stale-review-worker.cjs) are committed for Claude. The standalone DOM
case also confirms that a matching commit plus different testReportIds leaves approval
enabled. This is independently reproduced in the browser, not just a mocked render result.

Requested correction: clear or invalidate cached review evidence when the decision/revision
changes; bind each fetch to that snapshot and discard superseded responses. Require the
shown commit, diffId and ordered testReportIds to match the pending decision before enabling
approval. Add a real delayed-response regression for the same-commit/new-report sequence,
plus a positive current-evidence control. A key change alone must not let an old HTTP
completion overwrite the new question's evidence.

## N6 recovery disposition

No additional N6 defect was reproduced. Existing checks independently pass for:

- naming the registered repository and full approved commit;
- disabled Record inspection until explicitly ticked;
- binding the request to event sequence/commit with stable retry identity;
- stale/refused inspection handling and clearing the old confirmation;
- keeping Record inspection separate from Resume and starting no worker on acknowledgement;
- no Resume on an uncertain landing; resume/reconcile with one branch after acknowledgement;
- placeholder commands for shell-expanding repository paths;
- the 360 px recovery panel and 390 px history layout without horizontal page overflow.

This is approval of the examined recovery-control behaviour at the stated scope. P04 as a
whole remains CHANGES_REQUESTED because of P04-R1/R2. This does not certify every shell/path
variant, accessibility criterion, process-cleanup race or live-model failure.

## Verification

Host: native Windows; Node `v24.12.0`, npm `11.6.2`, UI Vitest `5.0.5`, Vite `7.3.7`.
Installed the checked-in UI lockfile using `npm ci --no-audit --no-fund` (132 packages).
No manifest or lockfile changed.

From `conductor/operator-web/`:

- `npm test`: **54 passed**, 2 files, zero failures/skips, 4.19 s.
- `npm run build`: PASS; 37 modules, 253.87 kB JavaScript/79.79 kB gzip; 493 ms.
- Unchanged `e2e/journey.mjs`: **19 passed, zero failed**, using Playwright `1.64.1` and
  system Microsoft Edge `156.0.4314.50` (Chromium engine). A local external preload passed
  executablePath to chromium.launch; it changed no assertion, provider, service or UI code.
  This is separate from CI's pinned Playwright Chromium evidence.

The existing journey covers bootstrap removal/reuse, repository confirmation, actual HTTP/SSE
decisions, literal hostile text, focus, reload, approval/rejection status, history, connections,
phone overflow, landing/cancel boundary, inspection refusal/success/resume, stale tabs and an
abrupt service restart. Its workers are deterministic fixtures; ordinary journey completion
is not live inference or proof of a model-generated branch. The N6 portion uses a real engine
workspace and Git branch/reconciliation. Native host coverage here is limited to these tests.

Desktop decision and phone history screenshots were captured and visually inspected. They
show readable controls and no visible page overflow for those fixtures. No automated axe
scan or full keyboard/screen-reader audit was run.

### Additional review regressions

From `conductor/operator-web/`:

```powershell
./node_modules/.bin/vitest.cmd run --config ../docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p04-review.config.mjs
```

**2 failed / 1 passed**, expected exit 1: P04-R1 and P04-R2 fail the safe-approval assertions;
the complete same-evidence large-diff control passes. The config imports the existing UI
config and setup without modifying them. Files are outside the normal UI/Node test globs.

For the real-browser stale-report reproduction, from repository root, install the UI's
lockfile/build and make Playwright available to Node (a supported environment/global install
or `NODE_PATH`). In this review it came from the already-installed Foundation lockfile:

```powershell
$env:NODE_PATH=(Resolve-Path 'foundation/node_modules').Path
$env:P04_BROWSER_EXECUTABLE='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
node conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures/p04-stale-review-browser.mjs
```

Omit P04_BROWSER_EXECUTABLE to use Playwright's installed Chromium. On Linux use the equivalent
environment assignments and `.bin/vitest` without `.cmd`. Expected exit **1** while reproduced,
then 0 when the failure conditions are absent. Browser fixture scratch Git/service resources
are isolated and cleaned up; no user repo, account, model or credential is used.

Full Conductor, Foundation/database, production deployment and live three-model acceptance
were not rerun. No Claude-owned UI/UX, service, dependency, CI or gate changed in this PR.
No model/subscription/authentication probes, private data or remote host operations occurred.

## Handoff

Claude owns both UI corrections and their normal regression tests. Keep the 54 existing UI
checks and19-step journey passing; add the delayed-review and clipped-tail cases. Submit
exact corrected pins for independent Codex re-review. The P04 ledger row remains
CHANGES_REQUESTED until corrected or explicitly disposed of by Malcolm. Passing the old
journey or merging this review does not close the findings.

After this review submission merges, remaining independent Codex work is the broader P06
research review and P09 backlog assessment, while Claude owns the supplied source fixes.
