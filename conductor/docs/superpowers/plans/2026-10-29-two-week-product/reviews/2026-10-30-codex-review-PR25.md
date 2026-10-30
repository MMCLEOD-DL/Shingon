# Codex re-review: PR21-R1 upgrade conflict resolution

Date: 30 October 2026. Reviewer: Codex. Correction owner: Claude.
Correction: `f5673de` (PR25); integrated review baseline: `fc4f25b` (PR28 merged).

**Disposition: PR21-R1 resolved in the reviewed source.** The correction carries the merge's
recorded conflict paths through the pipeline and build into the Foundation member. A
protected file on that list receives a locked warning; other protected edits remain blocked.
This closes the specific automatic-refusal defect, not whole-factory or live acceptance.

## What was checked

The trusted path is `prepareUpgradeMerge` → `run.upgrade.conflicts` →
`change.foundation.conflicts` → `factoryFeature.upgradeConflicts` → `protectedFindings`.
The pipeline records merge results from Git, including its interrupted-merge recovery path;
the unit id and model-authored instructions do not supply the exception list.

The build validates the release tag, full commit and conflict paths before creating feature
options. The council validates the list again. The member matches exact protected paths;
it does not exempt the whole Foundation or every file in an upgrade. `app-profile.json`
is still blocking even if listed. Verify-script checks remain independent and blocking.
A locked warning is retained for reviewing whether a resolution keeps the release fix and
app behaviour; the list does not establish semantic correctness of the resolution.

Reviewed locations:

- `conductor/src/factory/change/upgradeMerge.js`: merge conflict collection and upgrade unit.
- `conductor/src/factory/change/pipeline.js`: recovered/prepared merge record and `stepBuild` bridge.
- `conductor/src/factory/build.js`: `change.foundation` validation and feature option bridge.
- `conductor/src/factory/change/gitSafe.js`: repository-path validation.
- `conductor/src/council/index.js`: council option validation.
- `conductor/src/council/foundationRules.js`: exact conflict exception and retained guards.

## Reproducer disposition

The original standalone script hand-built the old option shape. Its continued exit 1 after
PR25 was therefore expected: it exercised the no-authority control, not the corrected bridge.
The script now asserts both cases on the same synthetic post-merge repository:

1. An unchanged post-merge baseline produces no protected-file finding.
2. Resolving the protected file without conflict context remains a locked block, even though
   the feature id says `foundation-upgrade`.
3. Adding the recorded conflict field produces exactly one locked warning for that file.

The updated control exits 0 at the integrated baseline. Against pre-correction source
`89d44be` in a separate temporary source snapshot, the same control exits 1: the authorised
case still returns `blocking` where `warning` is required. This demonstrates regression
sensitivity without weakening the negative control. The script models the post-merge
baseline; the existing pipeline and build tests independently exercise the actual bridges.

## Validation

From `conductor/`:

```powershell
node --test --test-concurrency=4 test/council-foundation.test.js test/factory-build-change.test.js test/factory-change-pipeline.test.js
node docs/superpowers/plans/2026-10-29-two-week-product/reviews/repro-PR21-upgrade.mjs
```

Host: Windows, Node 24.12.0, Git. Local wrapper for the resumed test run only sets
`windowsHide: true` on child-process calls; repository runtime/source is unchanged.
The first run was interrupted after Malcolm reported repeatedly opening terminal windows;
it is not counted as a completed suite. Results from the resumed run are recorded below.

- Affected suites: **107 passed**, zero failures/skips/cancellations; exit 0, 340.1 seconds.
- Updated standalone control: exit 0 on current source; expected exit 1 on pre-correction `89d44be`.
- `git diff --check`: passed.

The affected suites cover clean merges, recorded conflict resolution, unlisted protected
files, profile and verify guards, malformed context, plain-change exclusion and both real
option bridges. The pipeline suite uses synthetic Git repositories and stubbed build,
release, deployment and model boundaries; the build suite uses its fake-provider harness.
No live model, subscription probe, real deployment, client box or private input was used.
Full Conductor/Foundation/UI suites were not rerun for this review-only change. Claude's
previous full-suite result remains owner evidence, not a new independent run.

## Handoff

No new blocking finding in this correction. PR21-R1 is closed at the reviewed baseline;
Foundation protections and warning review remain required. This review changes only the
standalone reproducer, review documentation and ledger. It does not grant new upgrade or
release authority. P02's merged picture-confidence correction (PR27) is awaiting a separate
re-review; P09 remains in the review backlog.

Windows follow-up for the Codex-owned process seam: `conductor/src/exec.js` launches detached
Git/tool processes without `windowsHide`, causing visible console churn in native runs.
The local hidden-process wrapper avoids that during this review. A persistent runtime fix
needs its own focused change and Windows process/cancellation checks; it is not bundled here.
