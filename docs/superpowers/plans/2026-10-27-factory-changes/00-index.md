# Conductor Plan 11 — Change requests on live apps (factory phase 8)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** Two operator commands connect the change path end to end. `conductor change <slug> --notes <file>` turns a client's change into a new brief version, builds the difference on the existing app, has the full council review the **whole** app, asks the operator, and ships the result as a safe update to every deployment of that project. `conductor foundation-upgrade <slug> --to <tag>` does the same for a newer foundation release: merge, resolve conflicts, council, gate, ship. `conductor foundation-upgrade --check` tells the operator which projects and deployments are behind on `[security]` fixes.

**Architecture:**
- **One pipeline, two ways in.** A *change run* is a small resumable state machine saved in `<project>/builds/<runId>/change.json` (Contract 1). Its stages are `brief` (change only) or `prepare` (upgrade only), then `build`, `approved`, `merged`, `released`, `shipping`, `done`. Each stage records enough to be re-entered after a crash or Ctrl-C without asking the operator twice, releasing twice or updating a box twice.
- **Change in.** Plan 7's revise flow produces and gets approval for a new brief version. Plan 11 diffs it against the brief version the app was last built from (`briefDelta`), refuses deltas that are not a change (empty, a different kind of software, moving hosting), and turns the rest into build items: added and changed features, plus plain "remove this" and "brief-wide" items.
- **Upgrade in.** In a scratch clone of the app, Plan 11 merges the foundation's release tag (read-only fetch from the local foundation repo). Version and changelog conflicts it knows are mechanical are settled by fixed rules; everything else is committed with its conflict markers on a new upgrade branch, and the build's single item tells the author/reviewer loop to resolve them. Delete-versus-edit and binary conflicts stop with a plain explanation. More than 20 conflicted files asks the operator before any money is spent.
- **Build, council and gate are Plans 8 and 9.** Plan 11 calls Plan 8's feature loop on the existing app repo, starting from a named branch (`main`, or the upgrade branch), with Plan 9's full council in whole-app scope. Plan 11 wraps the operator's gate: it adds what will happen next (new version, changelog lines, which deployments get updated), and it **refuses before asking** when the council did not run, was blocked without an operator override, or conflict markers are still in the code. The approval is written to `change.json` before the gate returns.
- **After the gate (Plan 11's own work).** Check the landed branch is exactly the approved commit, add the changelog lines in one commit that touches only `CHANGELOG.md`, move the app's `main` forward with a compare-and-swap (never if `main` moved meanwhile), then call Plan 10 to make the release (version, images, bundle) and check the release commit touched only release files. Then update each deployment, one at a time, through Plan 10's update, which drives the foundation's own `updater update` on the box (backup first, automatic undo). The first deployment that does not end `updated` stops the rest.
- **Seams.** Plans 7–10 are written in parallel to the roadmap contracts, so every call into them goes through **one file**, `src/factory/change/seams.js`, with the names this plan assumes. Every other module receives these as an injected `deps` object, so the tests stub models, ssh and docker without touching Plans 7–10's internals.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`, the `git` CLI. No new external tools. ssh and docker are reached only through Plan 10's functions.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §4.8: change requests become a change brief, then Build, Council, Operator approval and Ship as an **update**; the council reviews the whole app; backup first, automatic rollback;
- §5: the foundation is versioned; security and bug fixes reach live apps through the change path; the factory tells the operator which live apps are behind on a security fix;
- §4.3: whole-app council, bounce-back cap, report;
- §2: the quality bar (access control, numbers, look, "must not break", low friction with a human check).

**Binding contracts:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md`, Contracts 1–6 and the cross-cutting rules. Plan 11 owns the `change` and `foundation-upgrade` rows of Contract 5.

**Foundation references** (read, never edited): `/root/highland-foundation/CHANGELOG.md`, `scripts/changelog.ts` (`parseChangelog`, `securityFixesSince`), `scripts/release.ts`, `docs/BUILDING-ON.md` ("Taking foundation fixes"), `docs/RUNBOOK.md` ("Updating", "Recovering from a failed update").

**Depends on:** Plans 7, 8, 9 and 10 merged into `/root/conductor` master. Plans 4 and 5 (wake workers, council v1) are merged. Rebase on master before starting; Task 1 reconciles the seam names with what actually merged.

## Rulings made while scoping (decided, not open)

1. **The delta is taken from the brief the app was built from, not from the previous approved brief.** A change the operator rejected at the gate leaves the brief one version ahead of the app; the next change must build both. Plan 11 reads `project.json.builtFromBrief` (falling back to the approved version before the revise) and sets it when the change reaches `main`. Why: spec §4.8 "the brief is the contract the council checks against" only holds if the app matches it.
2. **What is not a change request is refused before anything is built:** an empty delta ("the new brief changes nothing the app does"), a change of `kind`, a change of `policy.hosting` (moving where the app runs is a new deployment), and `policy.operatorAccess` no longer `true`. Residency and outbound changes are allowed but shown at the gate as "data policy changes", because the Legal member checks them.
3. **Removing a feature never deletes client data.** The removal item says: take the feature out of the pages, menu and routes, keep its tables and stored files, and do not write a migration that drops or empties anything. Deleting old data is the client's decision, made separately. Why: spec §2.4 and the anti-goal "silent breakage"; the factory never touches real data (spec §7).
4. **One change run per project at a time,** guarded by a project lock file and by "an unfinished change run exists". `--resume` continues it and `--abandon` drops it; a new `change` or `foundation-upgrade` is refused until then.
5. **Upgrade merge rules (mechanical, everything else goes to the loop):**

   | File | Rule | Why |
   |---|---|---|
   | `foundation.json` | take the foundation's | it records the foundation release |
   | `CHANGELOG.md` | keep the app's; the foundation's notes for the versions brought in go into the app's `Unreleased` section as one line, plus each `[security]` line | the app's changelog is the app's history |
   | `package.json`, `package-lock.json` | a conflict hunk whose two sides are each only a `"version": "…"` line keeps the app's; any other hunk stays for the loop | the app has its own version number |
   | any file with both sides present and text conflict markers | committed with its markers on the upgrade branch; the build item names it | the author/reviewer loop resolves it, and the council and gate check |
   | delete-versus-edit, or a binary file | **stop**, plain English, nothing changed | there are no markers to resolve; a person must choose |

   More than `MAX_CONFLICT_FILES = 20` marker files asks the operator ("approve" to let Conductor try) before the build starts. Only release tags `vX.Y.Z` are accepted, and only newer than the project's recorded tag.
6. **Version bumps:** a change is a `minor` release; a foundation upgrade is a `patch` release. The gate shows the expected next version; if Plan 10's release produces a different one, Plan 11 stops before shipping.
7. **Ship guard, enforced in code at two points.** At the gate (before asking) and again before the first deployment is touched, Plan 11 refuses unless: the council report exists **and** (its verdict is not `blocked` **or** it was overridden by the operator through the council escalation); the approval record names the commit; that commit is an ancestor of the released commit; and the release commit changed only `CHANGELOG.md`, `package.json`, `package-lock.json` and `foundation.json`.
8. **Main moves only by compare-and-swap.** Plan 11 records `main` when the run starts. After the gate it moves `main` from exactly that commit to the new one (`git merge --ff-only` when the app folder has `main` checked out and clean; `git update-ref refs/heads/main <new> <old>` otherwise). If `main` moved, nothing is shipped and the operator is told where the approved work is (its branch).
9. **Every deployment update goes through Plan 10's `updateDeployment`,** which runs the foundation's `updater update --to <version>` on the box. Plan 11 never runs ssh or docker itself. Deployments are updated **one at a time, in name order**, and the first outcome other than `updated` or `already` stops the rest: a version that failed its health check on one box is not pushed to the next. Resume retries a stopped deployment only after asking the operator; without a terminal it does not.
10. **The security report fails closed.** A foundation repo that cannot be read, a missing tag or a changelog heading that is not understood gives that row "could not check: …", never "up to date". Code (`project.json.foundation.tag`) and each deployment (`deployments/<name>.json` `foundation`, via Plan 10's status) are reported separately, because an upgrade that is merged but not yet shipped leaves the boxes behind.
11. **Plan 11 does not trust the app's `foundation.json` for the security report.** The foundation's `scripts/release.ts`, run inside an app, stamps `foundation.json` with the **app's** version (see Operator Questions 6). The recorded tag in `project.json` is the source of truth.
12. **The changelog parser is ported, not imported.** Conductor has no dependencies and cannot load the foundation's TypeScript or its `semver`. `src/factory/foundationLog.js` is a small port of `parseChangelog` and `securityFixesSince` with the foundation's own error messages, pinned by parity tests built from the foundation's examples.
13. **Out of scope:** remote client previews; choosing a subset of deployments; automatic monthly patching; upgrading a project to an older foundation; editing the foundation repo (never); a change that adds a whole new kind of software.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. Tests run with `npm test` (`node --test`). Tests never touch the network beyond `127.0.0.1`, never use real models, real Proxmox, real client boxes, real ssh or a Docker daemon: models are `fakeParticipant`s, and every Plan 7–10 function is a stub in an injected `deps`. Git runs for real on temporary repositories, as in the existing tests.
- **Only `src/factory/change/seams.js` imports from Plans 7–10's modules.** Every other Plan 11 module takes `deps`.
- **The foundation repo is never written.** Plan 11 reads it with `git tag`, `git show` and `git fetch` *from* it into a scratch clone.
- **The app repo is written in exactly three ways:** create-only branches (the core's `land()` and the upgrade branch), the changelog commit's objects, and the compare-and-swap move of `main` (Ruling 8). Plan 10's release adds its own commit and tag.
- **Fail closed:**
  - only a gate answer of exactly `true`, after the ship guard passed, ships anything;
  - every question asked without a terminal is answered "no";
  - a missing seam, unreadable state file, unreadable changelog or unexpected outcome stops the run with a plain reason;
  - an unknown `updateDeployment` outcome counts as a failure and stops the rest.
- **Atomic writes** for `change.json`, `project.json` edits and the lock file: write a temp file, fsync, rename (Contract 1).
- **No client data** reaches a model or the project folder (spec §7). Box messages from `updateDeployment` go through `redact()` before they are saved or shown.
- **Plain UK English** for every operator-facing message: what happened, what it means, what to do. No stack traces, no raw JSON, no git jargon such as "fast-forward" or "ref" in messages (say "the app's main line", "the approved work").
- **Existing behaviour is unchanged** when the new commands are not used. The existing suite stays green at every commit. Task 4 is the only task that edits core files (`src/workspace.js`, `src/conductor.js`) and it only adds an option and a field.

## Review Focus

1. **The app moved while the change was in flight** (another change or a hand edit reached `main` after the run started, or the app folder has uncommitted edits on `main`): `main` is not moved, nothing is released or shipped, and the operator is told that the approved work is safe on its branch and what to do. Pinned in Task 7 and Task 9.
2. **A deployment fails part-way through a ship with more deployments left** (rolled back, cancelled, unreachable, or URGENT): the remaining deployments are not touched; the report lists each deployment and the version it is on; the URGENT case points at the runbook's "Recovering from a failed update"; resume asks before retrying, and says no without a terminal. Pinned in Task 8.
3. **A crash or Ctrl-C between stages** (after the gate but before `main` moved; after `main` moved but before the release; after the release but before shipping; part-way through shipping): `--resume` carries on from the recorded stage, never asks the gate again once the approved work has landed, never makes a second release (a release that happened but was not saved is adopted), and never updates a deployment that already reports `updated`. Pinned in Task 9.
4. **Something that must not ship reaches the gate** (no council report, a blocked report the operator did not override, conflict markers left in a file, a landed branch that is not the approved commit, a release commit that changed code): it is refused before the operator is asked or before any box is touched, with the reason in plain English. Pinned in Tasks 5, 7 and 9.
5. **The foundation side is not as expected** (foundation repo missing, tag missing or older, a changelog heading that is not understood, an app that was not cloned from the foundation): the upgrade refuses before changing anything, and the security report says "could not check" rather than "up to date". Pinned in Tasks 2, 6 and 10.

## Operator Questions (open; the plan builds the defaults shown)

1. **Version bumps.** Default built: a change is `minor`, a foundation upgrade is `patch`.
2. **Ship order and stopping.** Default built: name order, one at a time, stop at the first deployment that does not end updated. Alternative: operator-run boxes first as a canary.
3. **Removed features keep their data** (Ruling 3). Default built: yes, always; deleting data is a separate, manual decision.
4. **Too many conflicts.** Default built: more than 20 files asks before starting.
5. **A hosting change** is refused as a change request (Ruling 2). Default built: refuse and say to set up a new deployment instead.
6. **Foundation follow-up, not built here.** `scripts/release.ts` stamps `foundation.json` with the app's own version when an app makes a release, although `docs/BUILDING-ON.md` says to keep `foundation.json` untouched. So after an app's first release its `foundation.json` names the wrong foundation version, and `/api/version` reports it. Plan 11 does not rely on it (Ruling 11), but the foundation should be fixed (for example: only stamp `foundation.json` when `package.json` is `highland-foundation`), released, and taken into apps through `foundation-upgrade`.
7. **Release tags only.** Default built: `--to` accepts `vX.Y.Z` only, no pre-release tags.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/factory/change/seams.js` | the only imports from Plans 7–10; `realDeps`, `missingSeams` | 1 |
| `src/factory/change/run.js` | change-run state, run ids, atomic JSON, project lock | 1 |
| `test/helpers/changeFixtures.js` | temporary projects root, foundation repo with tags, app cloned from it, stub `deps` | 1 (used by all) |
| `src/factory/foundationLog.js` | version compare, changelog parse, `securityFixesSince`, `changesBetween`, foundation tags | 2 |
| `src/factory/change/delta.js` | `briefDelta`, `deltaProblem`, `buildItems`, `deltaText`, changelog lines | 3 |
| `src/workspace.js`, `src/conductor.js` (modify) | `baseRef` for new runs; the gate argument carries `sha` and `workspaceDir` | 4 |
| `src/factory/change/gate.js` | council check, conflict-marker check, the wrapped gate, approval record, `shipProblem` | 5 |
| `src/factory/change/upgradeMerge.js` | upgrade target checks, scratch merge, mechanical rules, upgrade branch, build item | 6 |
| `src/factory/change/mainline.js` | `main` checks, changelog commit, compare-and-swap move, release check, next version | 7 |
| `src/factory/change/ship.js` | one-at-a-time updates through Plan 10, stop rules, ship report | 8 |
| `src/factory/change/pipeline.js` | `runChange`, `runFoundationUpgrade`, `resumeChange` (the stage machine) | 9 |
| `src/factory/change/behind.js` | which projects and deployments are behind on `[security]` fixes | 10 |
| `src/cli/args.js`, `src/cli/main.js` (modify), `src/cli/change.js` | the commands, no-terminal refusals, exit codes | 11 |
| `README.md`, `spikes/change-smoke/` | docs and an operator-run smoke | 12 |

## Tasks

1. [Seams, change-run state and project lock](task-01-seams-state.md)
2. [Foundation changelog reader](task-02-foundation-log.md)
3. [Brief delta and build items](task-03-brief-delta.md)
4. [Core: start from a branch, gate knows the commit](task-04-core-baseref.md)
5. [The change gate and ship guard](task-05-gate-guard.md)
6. [Foundation upgrade merge](task-06-upgrade-merge.md)
7. [Main line, changelog and release check](task-07-mainline-release.md)
8. [Shipping the update to every deployment](task-08-ship.md)
9. [The change pipeline and resume](task-09-pipeline.md)
10. [Security-behind report](task-10-security-report.md)
11. [CLI commands](task-11-cli.md)
12. [Docs and operator change smoke](task-12-docs-smoke.md)

Order matters:
- 2, 3, 4 need nothing but 1's helpers;
- 5 needs 4 (`sha` in the gate argument);
- 6 needs 2;
- 7 needs 1;
- 8 needs 1, 2 (`compareVersions`) and 5 (`shipProblem`);
- 9 needs 1–8;
- 10 needs 2;
- 11 needs 9 and 10;
- 12 needs all.

## Shared Interfaces (all tasks)

```js
// Task 1 — src/factory/change/seams.js. ASSUMED names from Plans 7–10; Task 1 maps them to what merged.
realDeps() -> ChangeDeps
missingSeams(deps) -> string[]          // names in SEAM_NAMES whose value is not a function
SEAM_NAMES = ['loadProject','saveProject','projectDirFor','loadBrief','loadBriefVersion','currentBriefVersion','renderBrief',
  'reviseBrief','buildFeatures','resumeBuild','projectCouncilOptions','listDeployments','deploymentsStatus','releaseApp','updateDeployment']
ChangeDeps = {
  // Plan 7 (Contracts 1, 2)
  loadProject(projectDir) -> Project            // project.json; Project gains builtFromBrief?: number (Ruling 1)
  saveProject(projectDir, project) -> void      // atomic
  projectDirFor(config, slug) -> string         // <projectsRoot>/<slug>; throws plain-English if no such project
  loadBrief(projectDir) -> Brief                // current approved
  loadBriefVersion(projectDir, n) -> Brief      // brief-v<n>.json
  currentBriefVersion(projectDir) -> number     // the version current.json points at
  renderBrief(brief) -> string
  reviseBrief({ projectDir, notesFile, team, term, config }) -> Promise<{ status: 'approved', version: number } | { status: 'stopped'|'failed'|'paused', reason: string }>
  // Plan 8
  buildFeatures({ projectDir, runId, baseRef, features, team, hooks, options }) -> Promise<BuildOutcome>
  resumeBuild({ projectDir, runId, team, hooks, options }) -> Promise<BuildOutcome>
  //   BuildOutcome { status: 'landed'|'rejected'|'stopped'|'failed'|'paused', branch?: string, workspaceDir?: string, reason?: string, note?: string }
  //   hooks.approveResult is called once, after the council, with the core gate argument (Task 4: includes sha and council)
  // Plan 9
  projectCouncilOptions({ projectDir, brief }) -> object    // run options turning on the full council, whole-app scope (no "already there" capping)
  // Plan 10 (Contract 4)
  listDeployments(projectDir) -> Deployment[]
  deploymentsStatus({ projectsRoot }) -> [{ slug, name, currentVersion, foundation, problem: string | null }]
  releaseApp({ projectDir, bump, runId }) -> Promise<{ ok: true, version: string, sha: string } | { ok: false, reason: string }>
  //   from the app's main: the app's own `npm run release -- <bump>` commit and tag, then images and bundle
  updateDeployment({ projectDir, name, version, foundation, runId }) -> Promise<{ outcome: UpdateOutcome, message: string }>
  //   runs the foundation's `updater update --to <version>` on the box and records history and foundation in deployments/<name>.json
  now() -> Date
}
UPDATE_OUTCOMES = ['updated', 'already', 'cancelled', 'rolled-back', 'urgent', 'unreachable']

// Task 1 — src/factory/change/run.js
writeJsonAtomic(file, obj) -> void
newRunId(kind: 'change'|'upgrade', now: Date, projectDir) -> string        // 'change-20261027-143205', '-2' … if taken
createChangeRun(projectDir, fields) -> Run
loadChangeRun(projectDir, runId) -> Run        // throws plain-English if missing or unreadable
saveChangeRun(projectDir, run) -> void         // sets updatedAt
findUnfinishedRun(projectDir) -> Run | null    // newest run whose status is 'running' | 'paused' | 'failed'
acquireProjectLock(projectDir, { now, pid = process.pid, host = os.hostname() }) -> () => void   // throws PROJECT_BUSY(text)
Run = { schema: 1, kind: 'change'|'foundation-upgrade', runId, slug, stage, status: 'running'|'paused'|'failed'|'stopped'|'done',
        createdAt, updatedAt, mainAtStart, baseRef, notesFile?, brief?: { from, to }, delta?, items?,
        upgrade?: { fromTag, toTag, mergeSha, branch, conflicts, autoResolved, changes, security },
        build?: { status, branch, workspaceDir, reason }, refusal?: string,
        approval?: Approval, changelogSha?, release?: { version, sha },
        deployments?: { [name]: { outcome, message, at } }, reason? }
STAGES = ['brief', 'prepare', 'build', 'approved', 'merged', 'released', 'shipping', 'done']

// Task 2 — src/factory/foundationLog.js
parseVersion(s) -> { major, minor, patch, pre: Array<string|number> } | null
compareVersions(a, b) -> -1 | 0 | 1                 // throws on an invalid version
parseChangelog(text) -> [{ version, date, lines }]   // throws the foundation's own messages
securityFixesSince(text, version) -> [{ version, lines }]   // newest first, marker removed
changesBetween(text, from, to) -> [{ version, date, lines }]  // from < v <= to, oldest first
releaseTags(repoDir) -> Promise<string[]>            // 'vX.Y.Z' only, ascending; throws plain-English
readChangelogAt(repoDir, tag) -> Promise<string>

// Task 3 — src/factory/change/delta.js
briefDelta(prev, next) -> Delta
deltaProblem(delta, prev, next) -> string | null
buildItems(delta) -> Feature[]                       // each item carries change: 'added'|'changed'|'removed'|'brief-wide'
deltaText(delta) -> string
changeChangelogLines(delta, toVersion) -> string[]

// Task 4 — core
Workspace.create({ repoDir, baseDir, taskId, baseRef = null })
runTask({ …existing, baseRef = null })                // state.baseRef recorded
hooks.approveResult argument gains sha: string, workspaceDir: string   // exactly the commit land() will ship, and the clone holding it

// Task 5 — src/factory/change/gate.js
councilPassed(report) -> { ok: true, overridden: boolean } | { ok: false, reason: string }
conflictMarkers(dir, sha, files) -> Promise<string[]>
makeChangeGate({ approveResult, extraText, check, onApproved }) -> (arg) => Promise<true | { note: string }>
Approval = { sha, at, council: { verdict, overridden, round }, expectedVersion, changelogLines, deployments: string[] }
shipProblem(run, { appDir }) -> Promise<string | null>
COUNCIL_MISSING, COUNCIL_NOT_PASSED, MARKERS_LEFT(files)

// Task 6 — src/factory/change/upgradeMerge.js
MAX_CONFLICT_FILES = 20
upgradeTargetProblem({ fromTag, toTag, tags }) -> string | null
resolveVersionHunks(text) -> { text, remaining: number }
prepareUpgradeMerge({ appDir, foundationRepo, fromTag, toTag, runId, scratchDir })
  -> Promise<{ status: 'ready', mergeSha, branch, mainAtStart, conflicts: string[], autoResolved: string[] }
           | { status: 'stopped', reason: string }>
upgradeItem({ fromTag, toTag, conflicts, changes }) -> Feature
upgradeChangelogLines({ fromTag, toTag, security }) -> string[]

// Task 7 — src/factory/change/mainline.js
RELEASE_FILES = ['CHANGELOG.md', 'package.json', 'package-lock.json', 'foundation.json']
nextVersion(current, bump) -> string
appMain(appDir) -> Promise<string>                    // sha of refs/heads/main; throws plain-English
appCheckoutProblem(appDir) -> Promise<string | null>
appVersionAt(appDir, sha) -> Promise<string>
addChangelogLines(text, lines) -> string              // under ## [Unreleased]; idempotent
commitChangelog({ appDir, sha, lines, scratchDir, message }) -> Promise<string>
advanceMain({ appDir, from, to }) -> Promise<{ ok: true } | { ok: false, reason }>
releaseProblem({ appDir, from, release, expectedVersion }) -> Promise<string | null>

// Task 8 — src/factory/change/ship.js
shipUpdate({ projectDir, run, version, foundation, deps, ask, save }) -> Promise<{ status: 'done'|'stopped', reason: string | null }>
shipReport(run, deployments) -> string

// Task 9 — src/factory/change/pipeline.js
runChange({ projectDir, notesFile, team, term, config, deps }) -> Promise<ChangeOutcome>
runFoundationUpgrade({ projectDir, toTag, team, term, config, deps }) -> Promise<ChangeOutcome>
resumeChange({ projectDir, team, term, config, deps }) -> Promise<ChangeOutcome>
abandonChange({ projectDir, deps }) -> Promise<ChangeOutcome>
askOperator(term, { title, message }) -> Promise<boolean>     // true only for exactly 'approve'
// the gate argument Plan 11 passes to the terminal also carries approveLabel (Task 11 shows it)
ChangeOutcome = { status: 'done'|'stopped'|'rejected'|'failed'|'paused', runId: string | null, reason: string | null, report: string }
term = { say(text), escalate(esc) -> 'approve'|'reject', approveResult(arg) -> true | … }   // the existing terminal

// Task 10 — src/factory/change/behind.js
securityBehind({ projectsRoot, deps, read = { releaseTags, readChangelogAt } }) -> Promise<Row[]>
Row = { slug, where: 'code' | <deployment name>, on: string | null, latest: string | null, behind: [{ version, lines }], problem: string | null }
behindText(rows) -> string

// Task 11 — src/cli/args.js
parseCli: commands 'change' { slug, notesFile, resume, abandon } and 'foundation-upgrade' { slug, toTag, resume, abandon, check }
```
