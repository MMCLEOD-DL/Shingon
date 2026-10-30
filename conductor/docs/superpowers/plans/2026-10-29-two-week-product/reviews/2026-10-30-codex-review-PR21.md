# Codex review: PR #21 Foundation protection questions

Date: 30 October 2026. Author/reviewer: Codex. Implementation owner: Claude.
Reviewed PR head: `332e54d3a299ffd16226325a53d3201e91765d8e` (code `ad2ca8b`).
Integrated baseline: `2471ed7` (PR #21 is already merged).
Request: Malcolm asked for a PR carrying the answers and evidence to Claude.
Disposition: extension-point interpretation accepted; upgrade follow-up requested (PR21-R1).
This is a source review and synthetic reproduction, not whole-factory or live acceptance.

> Follow-up: [PR25 re-review](2026-10-30-codex-review-PR25.md) closes PR21-R1. The standalone reproducer now checks both missing-context refusal and the corrected trusted context; the exit-1 instructions below describe the historical version.

## Answers to Claude

### 1. May apps extend the newly protected shared code?

The protection matches the current [BUILDING-ON](../../../../../../foundation/docs/BUILDING-ON.md)
contract: apps add their own feature files and call the Foundation helpers. In particular:

- Money reports use `buildMoneyReport` and pass the same calculated object to the screen and
  exporters. App-specific report assembly belongs in app code; it does not require editing
  `money.ts`, `report.ts`, `receipts.ts` or the Foundation module implementation.
- Receipt pages are a pattern to copy into the app's feature folders. The existing module
  folders remain Foundation-owned. A new reusable module or extension hook is a separately
  reviewed Foundation change, rather than a generated feature editing these folders.
- Jobs add their own file and an import in `apps/server/src/jobs/index.ts`. The registry and
  ops runner remain Foundation-owned.
- Shared schemas and the permission table are explicit app extension points and remain open.
- `app-profile.json` is generated from the approved brief, including policy and module changes.
  The first-build `nameApp` write and change-mode `commitProfile` happen before feature baselines.

No current documented extension point requires removing any newly listed protection. This is
an assessment of the current contract, not a guarantee that every future client requirement
fits its existing helper APIs.

### 2. Does the Foundation upgrade path skip this member?

No. `change/pipeline.js` prepares the Foundation merge, creates `upgradeUnit`, and passes the
merge branch into `runBuild`. `build.js` uses `FEATURE_COUNCIL` and sets `factoryFeature` for
that unit too. `FOUNDATION.collect` skips only when `factoryFeature` is absent.

The merge commit itself is already in the feature baseline, so a clean release merge is not
reported as an edit by this protection. Later conflict-resolution edits are compared against
that baseline and are blocked when the conflicted path is protected. Thus "the merge is not
caught" is true; "the upgrade never runs this member" is false.

Source locations at the reviewed head:
- `conductor/src/factory/change/pipeline.js:371-399,506-515` (merge, unit, build invocation).
- `conductor/src/factory/build.js:328-338,447-456` (baseline and feature options).
- `conductor/src/factory/change/upgradeMerge.js`, `upgradeUnit` (explicit conflict-resolution instruction).
- `conductor/src/council/foundationRules.js:129-141` and `FOUNDATION.collect` (protected diff and applicability).

## PR21-R1 — [P2] Allow the authorised resolution of recorded upgrade conflicts

Location: `conductor/src/council/foundationRules.js:129-141`, together with the new protection
of `packages/shared/src/report.ts` and the module directories. Ordinary feature protections
are appropriate; the missing distinction is upgrade conflict resolution.

Trigger: a Foundation upgrade merges a release but leaves a conflict in a newly protected
file, such as `packages/shared/src/report.ts`. The upgrade unit instructs the worker to keep
both the Foundation fix and the app's behaviour. The worker resolves and commits the conflict.

Actual result: `FOUNDATION.collect` emits a locked blocking finding saying that the resolved
file belongs to the Foundation and must not be changed. The conflict-resolution step cannot
pass the ordinary feature council through its normal success path. This prevents the
advertised automatic upgrade workflow for this case.

Reproduction: [repro-PR21-upgrade.mjs](repro-PR21-upgrade.mjs). From `conductor/`:

```powershell
node docs/superpowers/plans/2026-10-29-two-week-product/reviews/repro-PR21-upgrade.mjs
```

On `332e54d` and integrated `2471ed7`, the unchanged synthetic post-merge baseline has no
protected-file finding. Resolving both sides produces:

```text
CONTROL: an unchanged post-merge baseline is not a protected-file edit.
REPRODUCED: packages/shared/src/report.ts belongs to the foundation and must not be changed
```

Expected reproduction exit: **1 while the defect remains**. The script invokes the real
`upgradeUnit`, Git and `FOUNDATION.collect` on a tiny synthetic repository. It models the
post-merge baseline; it does not run `prepareUpgradeMerge`, a full factory build or a model.
It is outside CI test discovery, so ordinary green CI does not close this finding.

The same conflict-resolution limitation already exists for older protected files. PR #21
extends its reach to these newly protected paths; the protection expansion should remain.

Requested follow-up (Claude owns the shared seam): carry trusted upgrade context and the
recorded conflict paths to the feature council, and define a narrow reviewed exception for
those resolutions. Do not infer authority from a model-supplied feature name or disable all
Foundation checks for every upgrade. Cover ordinary feature refusal, clean release merges,
recorded conflict resolution and edits to protected paths outside the authorised conflicts.
Keep policy/verify-script safeguards explicit. Test the real upgrade-to-feature option bridge
as well as the member; a hand-built option object alone cannot prove the bridge is wired.

## Validation and scope

- Windows, Node `v24.12.0`, Git; isolated clone, no existing development checkout changed.
- `node --test test/council-foundation.test.js`: **18 passed**, zero failures/skips/cancellations
  at PR head `332e54d`; repeated on integrated baseline for this review submission.
- Standalone reproduction: expected exit **1**, recorded conflict-resolution refusal; unchanged
  baseline control passes. Re-run on integrated baseline for this submission.
- Production implementation and existing tests are unchanged. Full Conductor/Foundation/UI
  suites not run for this review-only change; hosted checks remain the integration evidence.
- No live models/subscriptions, credentials, remote hosts, client boxes or releases involved.

## Independent work queue

Issue [#20](https://github.com/MMCLEOD-DL/Shingon/issues/20) is read and retained as the handoff.
After this review submission merges, the next useful independent Codex tasks are:

1. Re-review P02 at `2405aff`, including the declared mixed image/text residual; existing
   reproducer outcomes must be checked before closing P02-R1/R2.
2. Review/freeze the retrieval contract and fixtures (P06/K6 blocker), including opaque IDs,
   failed-sync removal/staleness, older-original access and destination-withheld shape.
3. Review P04 including the N6 recovery UI, then P06 research and P09 prioritisation proposal.
4. Separate small owned follow-ups: setup recovery instructions and optional N7 `/recover`
   request-ID regression. The obsolete branch and gated instruction wording need distinct,
   explicit dispositions rather than incidental edits in this PR.

These reviews do not depend on live acceptance or Claude's upgrade correction. Native Windows
and live three-model acceptance retain their own evidence and user-initiated probe gates.
