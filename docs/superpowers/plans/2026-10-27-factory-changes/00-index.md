# Conductor Plan 11 — Change requests on live apps (factory phase 8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** Two operator commands connect the change path end to end.
- `conductor change <slug> --notes <file>` turns a client's change into a new brief version, builds the difference on the existing app, has the full council review the **whole** app, asks the operator, and ships the result as a safe update to every deployment of that project.
- `conductor foundation-upgrade <slug> --to <tag>` does the same for a newer foundation release: merge, resolve conflicts, council, gate, ship.
- `conductor foundation-upgrade --check` tells the operator which projects and deployments are behind on `[security]` fixes.

**Architecture:**
- **One pipeline, two ways in.** A *change run* is a small resumable state machine saved in `<project>/builds/<runId>/change.json` (Contract 7.5). The run id comes from Plan 8's `newRunId` (`RUN_ID_RE`, e.g. `20261027-143205-a1b2`); the kind (`change` or `foundation-upgrade`) lives in the record, not the id. Plan 8's `build.json` and Plan 9's `council-report.{md,json}` for the same run sit in the same folder. Stages: `brief` (change only) or `prepare` (upgrade only), then `build`, `approved`, `merged`, `released`, `shipping`, `done`. Each stage records enough to be re-entered after a crash or Ctrl-C without asking the operator twice, releasing twice or updating a box twice.
- **Change in.** Plan 7's brief session in `revise` mode produces and gets approval for a new brief version. Plan 11 diffs it against the version the app was built from (`project.json.builtFromBrief`), refuses deltas that are not a change (empty, a different kind of software, moving hosting), and turns the rest into Plan 8 `Unit`s: added and changed features (with their acceptance example ids), plus plain "remove this" and "brief-wide" fix units. Example ids are stable across brief revisions (Contract 7.4), so the delta works per example id, and tests tagged `[<featureId>#<n>]` keep proving the same example however the brief is reordered.
- **Upgrade in.** In a scratch clone of the app, Plan 11 merges the foundation's release tag (read-only fetch from the local foundation repo). Version and changelog conflicts it knows are mechanical are settled by fixed rules. Everything else is committed with its conflict markers on a new upgrade branch, and the build's single unit tells the author/reviewer loop to resolve them. Delete-versus-edit and binary conflicts stop with a plain explanation. More than 20 conflicted files asks the operator before any money is spent.
- **Build, council and gate are Plans 8 and 9.** Plan 11 calls Plan 8's single build entry point, `runBuild`, with a new **`options.change = { runId, baseRef, units, profile }`** that Plan 11 adds (Task 4): no app creation, no split, the build branch starts from `baseRef` (`main`, or the upgrade branch), and the `ready`/`shipped` refusal is lifted for this mode only. The council is `hooks.council = runProjectCouncil` (Plan 9), which always reviews the whole app. Plan 11 supplies the operator's gate (`hooks.approveBuild`): it adds what will happen next (new version, changelog lines, which deployments get updated), and it **refuses before asking** when the council did not run, was blocked without an operator override, or conflict markers are still in the code. The approval is written to `change.json` before the gate returns.
- **After the gate (Plan 11's own work, Contract 7.6).** In change mode `runBuild` never moves `main`. Plan 11 checks the build branch is exactly the approved commit, adds the changelog lines in one commit that touches only `CHANGELOG.md`, moves the app's `main` forward by compare-and-swap (never if `main` moved meanwhile), and records `project.json.approved` and `builtFromBrief` (or the new `foundation` tag). It then calls Plan 10's **`releaseApp`** (bump `minor` for a change, `patch` for an upgrade) and checks the release commit touched only release files. Then it updates each deployment, one at a time, through Plan 10's **`updateDeployment`**, which drives the foundation's own `updater update` on the box (backup first, automatic undo). The first deployment that does not end `updated` or `already-on` stops the rest.
- **Seams.** Contract 7 names every function Plan 11 uses from Plans 7–10. Plain file helpers (`fsAtomic`, `projects`, `projectLock`, `ids`, `acceptance`, `brief`, `foundationLog`) are imported directly. Everything that spends money, asks the operator or touches a machine (`reviseBrief`, `runBuild`, `runProjectCouncil`, `releaseApp`, `updateDeployment`, plus `listDeployments` so tests need no deployment files) is passed in a `deps` object built by `src/factory/change/seams.js`, so tests stub them.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`, the `git` CLI. No new external tools. ssh and docker are reached only through Plan 10's functions.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §4.8: change requests become a change brief, then Build, Council, Operator approval and Ship as an **update**; the council reviews the whole app; backup first, automatic rollback;
- §5: the foundation is versioned; security and bug fixes reach live apps through the change path; the factory tells the operator which live apps are behind on a security fix;
- §4.3: whole-app council, bounce-back cap, report;
- §2: the quality bar (access control, numbers, look, "must not break", low friction with a human check).

**Binding contracts:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md`, Contracts 1–7 and the cross-cutting rules. Contract 7 wins over anything older. Plan 11 owns the `change` and `foundation-upgrade` rows of Contract 5, `options.change` in `runBuild` (Contract 7.7), and the `changesBetween`, `releaseTags` and `readChangelogAt` additions to `foundationLog.js` (Contract 7.1).

**Foundation references** (read, never edited): `/root/highland-foundation/CHANGELOG.md`, `scripts/changelog.ts`, `scripts/release.ts`, `docs/BUILDING-ON.md` ("Taking foundation fixes"), `docs/RUNBOOK.md` ("Updating", "Recovering from a failed update").

**Depends on:** Plans 7, 8, 9 and 10 merged into `/root/conductor` master. Plans 4 and 5 (wake workers, council v1) are merged. Rebase on master before starting. Task 1 Step 0 checks that every Contract 7 name below exists as merged.

## Contract 7 mapping (what replaced the draft's assumed seams)

| Draft name | Now | Owner |
|---|---|---|
| `projectDirFor(config, slug)` | `projectDir(factory.projectsRoot, slug)` + `readProject` for the plain "no such project" error | Plan 7 `projects.js` |
| `loadProject`, `saveProject` | same names, imported directly | Plan 7 `projects.js` |
| `loadBriefVersion(dir, n)` | thin helper in `seams.js` over `briefPaths(dir).json(n)` + `validateBrief(…, { stage: 'approved' })` | Plan 7 `brief.js` |
| `currentBriefVersion(dir)` | thin helper in `seams.js` over `currentBriefInfo(dir).version` (throws on `null` or `{ broken }`) | Plan 7 `brief.js` |
| `reviseBrief` | wrapper in `seams.js` over Plan 7's session in `revise` mode (`importNotes`, `loadSession`/`newSession({ mode: 'revise', baseVersion })`, `runBriefSession`) | Plan 7 `briefSession.js`, `briefRun.js` |
| `buildFeatures`, `resumeBuild` | `runBuild({ …, options: { change } })`; resuming = calling `runBuild` again with the same `change.runId` | Plan 8 `build.js` (+ Plan 11 Task 4) |
| `projectCouncilOptions` | `hooks.council = runProjectCouncil` | Plan 9 `projectCouncil.js` |
| `releaseApp`, `updateDeployment`, `listDeployments` | Contract 7.6 names; `listDeployments(projectsRoot)` filtered by slug | Plan 10 |
| `deploymentsStatus` | not used: the security report reads each deployment's recorded `foundation` from `listDeployments` (Plan 10 writes it after every install or update). Plan 10's `deploymentStatus` probes boxes over ssh, which a report must not need | — |
| own `writeJsonAtomic` | `writeJsonAtomic`, `createFileExclusive` | Plan 7 `fsAtomic.js` |
| `newRunId(kind, …)` | `newRunId()`, `RUN_ID_RE`; kind in `change.json` | Plan 8 `ids.js` |
| `acquireProjectLock`, `PROJECT_BUSY` | `lockProject(projectDir, 'change')` and its busy message | Plan 7 `projectLock.js` |
| own port of `parseChangelog`, `securityFixesSince`, `compareVersions`, `parseVersion` | imported | Plan 10 `foundationLog.js` |
| core `baseRef` and gate `sha` (old Task 4) | dropped: Plan 8 checks out `build/<runId>` in the app itself, so `options.change.baseRef` is enough; the gate's `sha` comes from the build branch tip | — |

**Notes on Contract 7 (not deviations):**
- **One project lock.** Plan 7's `lockProject` is one lock per project. So while Plan 11 holds `lockProject(projectDir, 'change')`, `runBuild` in change mode does not take its own `'build'` lock (Task 4), and the `reviseBrief` wrapper calls Plan 7's session functions without the `'brief'` lock.
- **Gate refusals return `false`.** Plan 8 treats an `approveBuild` answer carrying a `note` as operator feedback and builds a fix unit from it. So the change gate's own refusals return `false` and save the reason as `run.refusal`. Only the operator's own feedback goes back as a note.
- **When `project.json.approved` is written.** The approval is saved in `change.json` the moment the operator says yes. `project.json.approved` is written straight after `main` has moved, because `approved.sha` must be the commit on `main` (the changelog commit on top of the approved build). That is what Plan 10's `conductor ship` checks for a release tag.

## Rulings made while scoping (decided, not open)

1. **The delta is taken from the brief the app was built from, not from the previous approved brief.** A change the operator rejected at the gate leaves the brief one version ahead of the app, so the next change must build both. Plan 11 reads `project.json.builtFromBrief` (Contract 7.5) and sets it when the change reaches `main`. A ready or shipped project whose `builtFromBrief` or `approved` is `null` is refused (fail closed). Why: spec §4.8 "the brief is the contract the council checks against" only holds if the app matches it.
2. **What is not a change request is refused before anything is built:**
   - an empty delta ("the new brief changes nothing the app does");
   - a change of `kind`;
   - a change of `policy.hosting` (moving where the app runs is a new deployment);
   - `policy.operatorAccess` no longer `true`;
   - an example that kept its id but changed its words (Plan 7 gives a changed example a new id, so this means a broken brief).

   Residency and outbound changes are allowed but shown at the gate as "data policy changes", because the Legal member checks them. A change to `modules` or to `policy.outbound`/`policy.residency` also rewrites the app's `app-profile.json` (Contract 7.5), committed by code on the build branch before any feature work.
3. **Removing a feature never deletes client data.** The removal unit says: take the feature out of the pages, menu and routes, keep its tables and stored files, and do not write a migration that drops or empties anything. Its acceptance tests (tagged with its example ids) are removed with it, and only those. Deleting old data is the client's decision, made separately. Why: spec §2.4 and the anti-goal "silent breakage"; the factory never touches real data (spec §7).
4. **One change run per project at a time,** guarded by Plan 7's `lockProject(projectDir, 'change')` and by "an unfinished change run exists". `--resume` continues it and `--abandon` drops it. A new `change` or `foundation-upgrade` is refused until then.
5. **Upgrade merge rules (mechanical, everything else goes to the loop):**

   | File | Rule | Why |
   |---|---|---|
   | `foundation.json` | take the foundation's | it records the foundation release |
   | `CHANGELOG.md` | keep the app's. The foundation's notes for the versions brought in go into the app's `Unreleased` section as one line, plus each `[security]` line | the app's changelog is the app's history |
   | `package.json`, `package-lock.json` | a conflict hunk whose two sides are each only a `"version": "…"` line keeps the app's; any other hunk stays for the loop | the app has its own version number |
   | any file with both sides present and text conflict markers | committed with its markers on the upgrade branch; the build unit names it | the author/reviewer loop resolves it, and the council and gate check |
   | delete-versus-edit, or a binary file | **stop**, plain English, nothing changed | there are no markers to resolve; a person must choose |

   More than `MAX_CONFLICT_FILES = 20` marker files asks the operator ("approve" to let Conductor try) before the build starts. Only release tags `vX.Y.Z` are accepted, and only newer than the project's recorded tag.
6. **Version bumps** (Contract 7.6): a change is a `minor` release; a foundation upgrade is a `patch` release. The gate shows the expected next version. If Plan 10's `releaseApp` produces a different one, Plan 11 stops before shipping.
7. **Ship guard, enforced in code at two points.** At the gate (before asking), and again before each deployment is touched, Plan 11 refuses unless:
   - the council ran on exactly the approved commit and `builds/<runId>/council-report.json` exists;
   - its status is not `blocked`, **or** the operator overrode it through Plan 8's council escalation (`build.council.overridden === true`);
   - the approval record names the commit;
   - that commit is an ancestor of the released commit;
   - the release commit changed only `CHANGELOG.md`, `package.json`, `package-lock.json` and `foundation.json`.
8. **Main moves only by compare-and-swap.** Plan 11 records `main` when the run starts. After the gate it moves `main` from exactly that commit to the new one: `git merge --ff-only` when the app folder has `main` checked out and clean, `git update-ref refs/heads/main <new> <old>` otherwise. If `main` moved, nothing is shipped, and the operator is told where the approved work is (`build/<runId>`). Plan 10's `releaseApp` then moves `main` once more, by its own compare-and-swap, to the release commit.
9. **Every deployment update goes through Plan 10's `updateDeployment`,** which runs the foundation's `updater update --to <version>` on the box. Plan 11 never runs ssh or docker itself.
   - Deployments are updated **one at a time, in name order**.
   - Plan 10's outcomes `updated` and `already-on` carry on. Every other outcome (`rolled-back`, `cancelled`, `busy`, `settings-error`, `urgent`, `lost-contact`, or anything unknown) stops the rest: a version that failed its health check on one box is not pushed to the next.
   - Resume retries a stopped deployment only after asking the operator. Without a terminal it does not.
   - A deployment whose setup is not finished (`setup.step !== 'done'`) is skipped and reported, not updated.
   - A deployment record that cannot be read stops the ship before any box is touched.
10. **The security report fails closed.** A foundation repo that cannot be read, a missing tag or a changelog heading that is not understood gives that row "could not check: …", never "up to date". Code (`project.json.foundation.tag`) and each deployment (`deployments/<name>.json` `foundation`, as recorded by Plan 10) are reported separately, because an upgrade that is merged but not yet shipped leaves the boxes behind.
11. **Plan 11 does not trust the app's `foundation.json` for the security report.** Before foundation v0.2.0, the foundation's `scripts/release.ts`, run inside an app, stamps `foundation.json` with the **app's** version (see Operator Question 6). The recorded tag in `project.json` is the source of truth. This stays true after v0.2.0, because apps on older foundations still exist.
12. **The changelog reader is Plan 10's.** `src/factory/foundationLog.js` (Contract 7.1) is Plan 10's zero-dependency port of the foundation's `parseChangelog` and `securityFixesSince`, with `parseVersion` and `compareVersions`. Plan 11 adds `changesBetween`, `releaseTags` and `readChangelogAt` to the same file and never redefines Plan 10's functions.
13. **Out of scope** (Contract 7.10): remote client previews; choosing a subset of deployments; automatic monthly patching; upgrading a project to an older foundation; editing the foundation repo (never); a change that adds a whole new kind of software.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. Tests run with `npm test` (`node --test`).
  - Tests never touch the network beyond `127.0.0.1`, and never use real models, real Proxmox, real client boxes, real ssh or a Docker daemon.
  - Models are `fakeParticipant`s. Every function in `deps` (`reviseBrief`, `runBuild`, `runProjectCouncil`, `releaseApp`, `updateDeployment`, `listDeployments`) is a stub.
  - Git runs for real on temporary repositories, as in the existing tests.
- **Imports from Plans 7–10:** plain file helpers named in Contract 7.1 are imported directly. The functions in `deps` are imported **only** in `src/factory/change/seams.js`. Every other Plan 11 module receives them through `deps`.
- **The foundation repo is never written.** Plan 11 reads it with `git tag`, `git show` and `git fetch` *from* it into a scratch clone.
- **The app repo is written in exactly these ways:**
  - create-only branches: Plan 8's `build/<runId>` in change mode, and the upgrade branch landed by the core's `land()`;
  - the `app-profile.json` commit on the build branch (Task 4);
  - the changelog commit's objects;
  - the compare-and-swap move of `main` (Ruling 8).

  Plan 10's `releaseApp` adds its own release commit and tag.
- **Fail closed:**
  - only a gate answer of exactly `true`, after the ship guard passed, ships anything;
  - every question asked without a terminal is answered "no";
  - a missing dep, unreadable state file, unreadable changelog or unexpected outcome stops the run with a plain reason;
  - an unknown `updateDeployment` outcome counts as a failure and stops the rest.
- **Atomic writes** for `change.json` and `project.json` edits: Plan 7's `writeJsonAtomic` and `saveProject`.
- **No client data** reaches a model or the project folder (spec §7). Box messages from `updateDeployment` go through `redact()` before they are saved or shown.
- **Plain UK English** for every operator-facing message: what happened, what it means, what to do. No stack traces, no raw JSON, and no git jargon such as "fast-forward" or "ref" in messages (say "the app's main line", "the approved work").
- **Existing behaviour is unchanged** when the new commands are not used. The existing suite stays green at every commit. No core files (`src/workspace.js`, `src/conductor.js`) are edited. Task 4 is the only task that edits Plan 8's files, and only behind `options.change` (plus passing extra keys to `approveBuild`, which the build command's gate ignores).

## Review Focus

1. **The app moved while the change was in flight.** Another change or a hand edit reached `main` after the run started, or the app folder has uncommitted edits on `main`. Then `main` is not moved, nothing is released or shipped, and the operator is told that the approved work is safe on `build/<runId>` and what to do. Pinned in Task 7 and Task 9.
2. **A deployment fails part-way through a ship with more deployments left** (rolled back, cancelled, busy, lost contact, or URGENT).
   - The remaining deployments are not touched.
   - The report lists each deployment and the version it is on.
   - The URGENT case points at the runbook's "Recovering from a failed update".
   - Resume asks before retrying, and says no without a terminal.

   Pinned in Task 8.
3. **A crash or Ctrl-C between stages**: after the gate but before `main` moved; after `main` moved but before the release; after the release but before shipping; part-way through shipping. `--resume` carries on from the recorded stage. It never asks the gate again once the approval is saved, never calls `runBuild` again after that, and never makes a second release (a release that happened but was not saved is adopted). It never updates a deployment that already reports `updated`. Pinned in Task 9.
4. **Something that must not ship reaches the gate**: no council report, a blocked council the operator did not override, a council that reviewed an older commit, conflict markers left in a file, a build branch that is not the approved commit, or a release commit that changed code. It is refused before the operator is asked or before any box is touched, with the reason in plain English. Pinned in Tasks 5, 7 and 9.
5. **The foundation side is not as expected**: foundation repo missing, tag missing or older, a changelog heading that is not understood, or an app that was not cloned from the foundation. The upgrade refuses before changing anything, and the security report says "could not check" rather than "up to date". Pinned in Tasks 2, 6 and 10.
6. **Change mode leaks into ordinary builds**: `conductor build` or `conductor resume` picks up a change run's `build.json`, a change build moves `main`, or the `ready`/`shipped` refusal is lifted without `options.change`. Pinned in Task 4.

## Operator Questions (open; the plan builds the defaults shown)

1. **Version bumps.** Default built (Contract 7.6): a change is `minor`, a foundation upgrade is `patch`.
2. **Ship order and stopping.** Default built: name order, one at a time, stop at the first deployment that does not end updated. Alternative: operator-run boxes first as a canary.
3. **Removed features keep their data** (Ruling 3). Default built: yes, always; deleting data is a separate, manual decision.
4. **Too many conflicts.** Default built: more than 20 files asks before starting.
5. **A hosting change** is refused as a change request (Ruling 2). Default built: refuse and say to set up a new deployment instead.
6. **The `foundation.json` stamping bug is fixed in foundation v0.2.0** (Contract 7.9 item 1, Plan 12 milestone 1). `scripts/release.ts` now stamps `foundation.json` only when `package.json.name` is `highland-foundation`.
   - Apps cloned from v0.1.0 that have made a release still carry a wrong `foundation.json`. `/api/version` reports it until they take v0.2.0 through `conductor foundation-upgrade <slug> --to v0.2.0`.
   - The merge rule "take the foundation's `foundation.json`" (Ruling 5) corrects it at that upgrade.
   - Plan 11 keeps Ruling 11 regardless.
   - Open: should Plan 11 suggest the v0.2.0 upgrade in `--check` even with no `[security]` line? Default built: no; `--check` reports security fixes only.
7. **Release tags only.** Default built: `--to` accepts `vX.Y.Z` only, no pre-release tags.

## Still open

1. **Plan 8 internals Task 4 relies on.** Task 4 edits Plan 8's `build.js`, `buildFinal.js`, `buildState.js`, `app.js` and the Foundation rules member. If Plan 8 merged with a different internal split, Task 1 Step 0 finds the equivalent spots. The behaviour required is fixed in Task 4; only the file names may move.
2. **The team helper for factory commands.** Task 11 reuses whatever helper Plan 8's `build` handler in `FACTORY_COMMANDS` uses to check the workers and build the team. If Plan 8 left that inline, Task 11 extracts it as `prepareTeam` in `src/cli/factory.js` and makes `build` call it, with no change in behaviour.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/factory/change/seams.js` | the only imports of `deps` functions from Plans 7–10; `realDeps`, `missingSeams`, `loadBriefVersion`, `currentBriefVersion`, the `reviseBrief` wrapper | 1 |
| `src/factory/change/run.js` | change-run state in `builds/<runId>/change.json` | 1 |
| `test/helpers/changeFixtures.js` | temporary projects root, foundation repo with tags, app cloned from it, stub `deps` | 1 (used by all) |
| `src/factory/foundationLog.js` (extend Plan 10's) | `changesBetween`, `releaseTags`, `readChangelogAt` | 2 |
| `src/factory/change/delta.js` | `briefDelta`, `deltaProblem`, `buildUnits`, `profileChanged`, `deltaText`, changelog lines | 3 |
| `src/factory/build.js`, `buildFinal.js`, `buildState.js`, `app.js`, `src/council/foundationRules.js` (modify Plan 8's) | `options.change` in `runBuild`; change builds kept out of `latestBuild`; `appProfileOf`; retired tags | 4 |
| `src/factory/change/gate.js` | council check, conflict-marker check, the change gate, approval record, `shipProblem` | 5 |
| `src/factory/change/upgradeMerge.js` | upgrade target checks, scratch merge, mechanical rules, upgrade branch, build unit | 6 |
| `src/factory/change/mainline.js` | `main` checks, changelog commit, compare-and-swap move, release check, next version | 7 |
| `src/factory/change/ship.js` | one-at-a-time updates through Plan 10, stop rules, ship report | 8 |
| `src/factory/change/pipeline.js` | `runChange`, `runFoundationUpgrade`, `resumeChange`, `abandonChange` (the stage machine) | 9 |
| `src/factory/change/behind.js` | which projects and deployments are behind on `[security]` fixes | 10 |
| `src/cli/args.js`, `src/cli/factory.js` (modify), `src/cli/change.js`, `src/ui/terminal.js` (gate label) | the commands as `FACTORY_COMMANDS` handlers, no-terminal refusals, exit codes | 11 |
| `README.md`, `spikes/change-smoke/` | docs and an operator-run smoke | 12 |

## Tasks

1. [Seams and change-run state](task-01-seams-state.md)
2. [Foundation changelog reader additions](task-02-foundation-log.md)
3. [Brief delta and build units](task-03-brief-delta.md)
4. [Plan 8's `runBuild` in change mode](task-04-core-baseref.md)
5. [The change gate and ship guard](task-05-gate-guard.md)
6. [Foundation upgrade merge](task-06-upgrade-merge.md)
7. [Main line, changelog and release check](task-07-mainline-release.md)
8. [Shipping the update to every deployment](task-08-ship.md)
9. [The change pipeline and resume](task-09-pipeline.md)
10. [Security-behind report](task-10-security-report.md)
11. [CLI commands](task-11-cli.md)
12. [Docs and operator change smoke](task-12-docs-smoke.md)

(Task 4's file keeps its old name, `task-04-core-baseref.md`, so links stay stable. It no longer edits the core.)

Order matters:
- 2, 3 and 4 need nothing but 1's helpers;
- 5 needs 1;
- 6 needs 2 and 3 (the `Unit` shape);
- 7 needs 1;
- 8 needs 1 and 5 (`shipProblem`);
- 9 needs 1–8;
- 10 needs 2;
- 11 needs 9 and 10;
- 12 needs all.

## Shared Interfaces (all tasks)

```js
// Imported directly (Contract 7.1; never redefined here)
// Plan 7: fsAtomic.js  writeJsonAtomic(file, obj), createFileExclusive(file, data)   // EEXIST when present
//         projects.js  projectDir(root, slug), readProject(root, slug) -> { dir, project }, loadProject(dir), saveProject(dir, project)
//         projectLock.js lockProject(projectDir, 'change') -> release()             // throws Plan 7's plain "busy" message
//         brief.js     loadBrief(dir), renderBrief(brief), validateBrief(obj, { stage }), briefPaths(dir).json(v), currentBriefInfo(dir)
//         acceptance.js acceptanceIds(brief) -> [{ id, featureId, n, example }], testTag(id) -> '[<id>]'
// Plan 8: ids.js       newRunId(now?) -> '20261027-143205-a1b2', RUN_ID_RE
//         split.js     Unit = { id, title, covers: string[], acceptance: string[], instructions, dependsOn: string[], kind: 'feature'|'fix' }
//                      MAX_INSTRUCTIONS = 2000
//         app.js       appProfileOf(brief) -> { schema: 1, modules, policy: { outbound, residency } }   // Task 4 exports it if inline
// Plan 10: foundationLog.js parseVersion, compareVersions, parseChangelog, securityFixesSince
// Contract 7.5: project.json = { schema: 1, slug, client, createdAt, status, foundation: { repo, tag, commit },
//                 approved: null | { sha, at, runId, briefVersion }, builtFromBrief: number | null }

// Task 1 — src/factory/change/seams.js
DEP_NAMES = ['reviseBrief', 'runBuild', 'runProjectCouncil', 'releaseApp', 'updateDeployment', 'listDeployments']
realDeps() -> ChangeDeps
missingSeams(deps) -> string[]                         // DEP_NAMES whose value is not a function, sorted
loadBriefVersion(projectDir, n) -> Brief               // briefPaths(dir).json(n); throws plain English if missing or invalid
currentBriefVersion(projectDir) -> number              // currentBriefInfo(dir).version; throws plain English on null / { broken }
makeReviseBrief({ importNotes, newSession, loadSession, runBriefSession }) -> reviseBrief   // realDeps passes Plan 7's; tests pass stubs
ChangeDeps = {
  reviseBrief({ projectDir, slug, notesFile, author, io, log, operatorName, cwd })
    -> Promise<{ status: 'approved', version: number } | { status: 'stopped'|'failed'|'paused', reason: string }>
    //   Plan 7's session in 'revise' mode; continues a saved revise session when notesFile is null; takes no lock
  runBuild({ factory, slug, team, hooks, options, baseDir, warnings, env }) -> Promise<BuildOutcome>     // Plan 8 + Task 4
  runProjectCouncil                                      // Plan 9; passed as hooks.council
  releaseApp({ projectDir, bump: 'minor'|'patch', runId }) -> Promise<{ ok: true, version, sha, tag } | { ok: false, reason }>
  updateDeployment({ projectDir, name, version, foundation, runId }) -> Promise<{ outcome, message }>
  listDeployments(projectsRoot) -> [{ slug, projectDir, name, deployment: Deployment | null, problem: string | null }]
  now() -> Date
}
CONTINUE_OUTCOMES = ['updated', 'already-on']          // Plan 10 OUTCOMES; everything else stops the ship

// Task 1 — src/factory/change/run.js
createChangeRun(projectDir, fields, { now, newId = newRunId }) -> Run    // builds/<runId>/change.json, created exclusively
loadChangeRun(projectDir, runId) -> Run                // throws RUN_UNREADABLE(runId)
saveChangeRun(projectDir, run) -> void                 // writeJsonAtomic; sets updatedAt
findUnfinishedRun(projectDir) -> Run | null            // newest change.json whose status is 'running' | 'paused' | 'failed'
Run = { schema: 1, kind: 'change'|'foundation-upgrade', runId, slug, stage, status: 'running'|'paused'|'failed'|'stopped'|'done',
        createdAt, updatedAt, mainAtStart, baseRef, notesFile?, brief?: { from, to }, delta?, units?, profile?,
        upgrade?: { fromTag, toTag, tagSha, mergeSha, branch, conflicts, autoResolved, changes, security },
        build?: { status, branch, sha, reason }, refusal?: string,
        approval?: Approval, changelogSha?, release?: { version, sha, tag },
        deployments?: { [name]: { outcome, message, at, from } }, reason? }
STAGES = ['brief', 'prepare', 'build', 'approved', 'merged', 'released', 'shipping', 'done']

// Task 2 — src/factory/foundationLog.js (added to Plan 10's file)
changesBetween(text, from, to) -> [{ version, date, lines }]  // from < v <= to, oldest first
releaseTags(repoDir) -> Promise<string[]>            // 'vX.Y.Z' only, ascending; throws plain English
readChangelogAt(repoDir, tag) -> Promise<string>

// Task 3 — src/factory/change/delta.js
briefDelta(prev, next) -> Delta
deltaProblem(delta, prev, next) -> string | null
buildUnits(delta, { toVersion }) -> ChangeUnit[]      // ChangeUnit = Unit & { change: 'added'|'changed'|'removed'|'brief-wide', retire: string[] }
profileChanged(delta) -> boolean                      // modules, policy.outbound or policy.residency changed
deltaText(delta) -> string
changeChangelogLines(delta, toVersion) -> string[]

// Task 4 — Plan 8's runBuild, change mode
runBuild({ …, options: { …, change: { runId, baseRef, units: ChangeUnit[], profile: object | null } } }) -> Promise<BuildOutcome>
BuildOutcome gains (change mode): status 'approved', sha, branch     // main NOT moved, project.json NOT touched
hooks.approveBuild argument (always): { summary, sha, branch, runId, council: build.council, checks: build.checks }
  //   build.council = { status, text, fix?, reason?, secretSeen?, sha, overridden? }  (Plan 8 adds sha and overridden)
Build gains kind: 'build' | 'change'; latestBuild(projectDir) ignores kind 'change'
factoryFeature gains retire: string[]                  // Foundation rules member allows removing tests tagged exactly these ids

// Task 5 — src/factory/change/gate.js
councilPassed(council, { sha, report }) -> { ok: true, overridden: boolean } | { ok: false, reason: string }
readCouncilReport(projectDir, runId) -> object | null  // builds/<runId>/council-report.json; null when missing or unreadable
conflictMarkers(dir, sha, files) -> Promise<string[]>
makeChangeGate({ projectDir, approveBuild, extraText, check, onApproved, onRefused, now }) -> (arg) => Promise<true | false | object>
Approval = { sha, branch, at, council: { status, overridden, verdict, round }, expectedVersion, changelogLines, deployments: string[] }
shipProblem(run, { appDir }) -> Promise<string | null>
COUNCIL_MISSING, COUNCIL_NOT_PASSED, COUNCIL_OLDER_COMMIT, MARKERS_LEFT(files), NOT_APPROVED_COMMIT, NO_APPROVAL

// Task 6 — src/factory/change/upgradeMerge.js
MAX_CONFLICT_FILES = 20
upgradeTargetProblem({ fromTag, toTag, tags }) -> string | null
resolveVersionHunks(text) -> { text, remaining: number }
prepareUpgradeMerge({ appDir, foundationRepo, fromTag, toTag, runId, scratchDir })
  -> Promise<{ status: 'ready', mergeSha, tagSha, branch, mainAtStart, conflicts: string[], autoResolved: string[] }
           | { status: 'stopped', reason: string }>
upgradeUnit({ fromTag, toTag, conflicts, changes }) -> ChangeUnit     // kind 'fix', change 'foundation-upgrade'
upgradeChangelogLines({ fromTag, toTag, security }) -> string[]

// Task 7 — src/factory/change/mainline.js
RELEASE_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'foundation.json']
nextVersion(current, bump) -> string
appMain(appDir) -> Promise<string>                    // sha of refs/heads/main; throws plain English
appCheckoutProblem(appDir) -> Promise<string | null>
appVersionAt(appDir, sha) -> Promise<string>
addChangelogLines(text, lines) -> string              // under ## [Unreleased]; idempotent
commitChangelog({ appDir, sha, lines, scratchDir, message }) -> Promise<string>
advanceMain({ appDir, from, to }) -> Promise<{ ok: true } | { ok: false, reason }>
releaseProblem({ appDir, from, release, expectedVersion }) -> Promise<string | null>   // release = { version, sha, tag }

// Task 8 — src/factory/change/ship.js
projectDeployments(deps, { projectsRoot, slug }) -> { list: [{ name, deployment }], problem: string | null }
shipUpdate({ projectDir, projectsRoot, slug, run, version, foundation, deps, ask, save }) -> Promise<{ status: 'done'|'stopped', reason: string | null }>
shipReport(run, list) -> string

// Task 9 — src/factory/change/pipeline.js
runChange({ ...ChangeCtx, notesFile }) -> Promise<ChangeOutcome>
runFoundationUpgrade({ ...ChangeCtx, toTag }) -> Promise<ChangeOutcome>
resumeChange(ChangeCtx) -> Promise<ChangeOutcome>
abandonChange({ factory, slug, deps }) -> Promise<ChangeOutcome>
askOperator(term, { title, message }) -> Promise<boolean>     // true only for exactly 'approve'
ChangeCtx = { factory, slug, team, author, term, options, baseDir, warnings, env, deps }
term = { say(text), onEvent?(event), escalate(esc) -> 'approve'|'reject', approveBuild(arg) -> true | false | { approved: false, note },
         briefIo: { say, ask, approve } }                       // briefIo is Plan 7's runBriefSession io
// the approveBuild argument Plan 11 passes on also carries approveLabel (Task 11 shows it)
ChangeOutcome = { status: 'done'|'stopped'|'rejected'|'failed'|'paused', runId: string | null, reason: string | null, report: string }

// Task 10 — src/factory/change/behind.js
securityBehind({ projectsRoot, deps, read = { releaseTags, readChangelogAt } }) -> Promise<Row[]>
Row = { slug, where: 'code' | <deployment name>, on: string | null, latest: string | null, behind: [{ version, lines }], problem: string | null }
behindText(rows) -> string

// Task 11 — src/cli/args.js and src/cli/factory.js
parseCli: { command: 'change', slug, notesFile, resume, abandon, flags }
        | { command: 'foundation-upgrade', slug, toTag, resume, abandon, check, flags }
FACTORY_COMMANDS.change = runChangeCommand; FACTORY_COMMANDS['foundation-upgrade'] = runUpgradeCommand   // src/cli/change.js
```
