# Conductor Plan 8 — Building from nothing, previews and machines (factory phase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** `conductor build <slug>` turns an approved brief into a working client app: it creates the app from the pinned foundation tag, has the author split the brief into small ordered features, builds each one through the existing plan → chunk → review loop with its acceptance examples written as tests first, keeps the foundation's `npm run verify` green, survives crashes and Ctrl-C, and ends at a council hook (filled by Plan 9) and the operator's gate. `conductor preview <slug> [--stop]` runs the app with demo data on a factory machine and prints its address. The machines come from a `static` provider (CT 111 today) or a `proxmox` provider (built against a stubbed API), with locks, labels, clean-up and sweep.

**Architecture:**
- **One feature = one ordinary Conductor run.** The build orchestrator (`src/factory/build.js`) calls the existing `runTask`/`resume` once per feature, on the client's own app repo (`<project>/app`). Nothing in the run loop is forked. Each run gets a deterministic, size-checked request built from the brief, a fixed first step ("Acceptance tests"), and a small council made of a new deterministic **Foundation rules** member plus the existing Correctness member (the bounce-back loop from Plan 5 then fixes what they find). Its gate is answered by the orchestrator, not the operator: a feature is accepted only with passing checks and no unresolved blocking finding.
- **The app repo is the factory's own.** Features land on a `build/<runId>` branch, one squashed commit per feature, so every commit on it passes `verify`. `main` moves only when the operator approves the whole build.
- **Build state** is `builds/<runId>/build.json` (atomic writes), plus Plan 7's project lock (`lockProject(projectDir, 'build')`). Every phase is re-entrant: `conductor build <slug>` or `conductor resume` (inside the project folder) carries on from the last saved point.
- **Final phase:** whole-app checks in a throwaway clone (`verify` and the browser gate, with JSON reports), then `hooks.council` (Plan 9 fills it; until then the summary says so), then the operator's gate. Extra "fix" features come from three sources:
  - red checks, capped by `factory.build.fixRounds`;
  - blocking council findings, capped by `factory.build.councilFixRounds`;
  - the operator's feedback, which is not capped.
  
  Approval moves `main` and records `project.json.approved`. It does not cut a release.
- **Machines** (`src/factory/machines/`): `getMachineProvider(factoryConfig)` returns the provider. All remote work is a generated bash script sent over `ssh … bash -s` (no Docker socket locally). Previews use the foundation's own image Dockerfiles, `ops init --demo`, Compose and the demo seeder.

**Tech Stack:** Node ≥ 20 (ESM, `node --test`, zero dependencies), `git` CLI, `ssh`/`scp` clients and `node:https` at runtime. On the factory machines: Docker Engine + Compose v2. Tests stub `ssh`, `scp`, `docker`, git remotes and the Proxmox API, and never touch real infrastructure.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md` §2 (quality bar), §4.2 (build, previews), §4.7 (test machines), §5 (foundation), §7 (constraints), §8 item 5. **Binding contracts:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md` Contract 1 (project folder), Contract 2 (brief, consumed), Contract 3 (machines, produced here), Contract 5 (`build`, `preview`), and **Contract 7** (library seams; it wins over anything here that disagrees). **Foundation:** `/root/highland-foundation` at tag `v0.1.0`, especially `docs/BUILDING-ON.md` and `docs/RUNBOOK.md`.

Plans 1–6 are merged. Plan 7 (brief intake) lands first. This plan consumes what Contract 2 names and the Plan 7 modules Contract 7 §7.1 lists (see "What this plan imports from Plan 7" below).

## Rulings made while scoping (decided, not open)

1. **Reuse, don't fork, the run loop.** Each feature is `runTask({ repoDir: appDir, request, options })`. The only core changes are additive options: `firstChunk` (Task 3), `councilMembers` and `factoryFeature` (Task 5). With them unset, every existing behaviour and test is unchanged.
2. **Context size is enforced in code, not hoped for.**
   - `prompts.js` clips every request to 8000 characters (`TEXT_MAX`). A feature's request must therefore fit **7000 characters** (`REQUEST_BUDGET`), checked when the feature list is accepted; a split whose rendered request is too long goes back to the author as a failed round.
   - At most **6 acceptance examples** and at most **one new database table** per feature; **at most 30 features** per build; `maxChunks` stays 12, including the fixed first step.
   - A feature's request names the other features **by title only**. Each run starts from a fresh workspace; the codebase, not a conversation, carries what earlier features did.
   - The whole brief goes only to the frontier author during the split (once per build). Local-model prompts never carry the brief, only the feature's own slice of it.
3. **Acceptance examples become tests first.** Every example carries a stable `id: '<featureId>#<n>'`, assigned by Plan 7 at approval and never reused (Contract 7 §7.4). Its tag is `testTag(id)` = `[<id>]` (Plan 7's `src/factory/acceptance.js`). Examples are found by id, never by position. The fixed first step of every feature run is titled `Acceptance tests` and writes one test per example, with the tag in the test's name. The Foundation rules member then **blocks** a feature whose finished tree lacks any of its tags in a test file, or that skips (`.skip`, `.todo`) or focuses (`.only`) a tagged test, and **warns** (locked) when the first step's commit was not test-only.
4. **`verify` stays green at every commit the operator sees.** The test command of every feature run is `VERIFY_COMMAND` (install if needed, then `npm run verify`). Step 1's tests are expected to fail; the feature is accepted only when `verify` passes. On the build branch each feature is **one squashed commit**, so the foundation's "must pass at every commit" holds. The browser gate (`npm run test:e2e`) runs once per build, in the final checks, because it takes minutes and needs browsers.
5. **The foundation's mandatory checklist is applied twice.** It is written into every feature request (`BUILDING_ON_RULES`, a compact copy of BUILDING-ON "Adding a feature", plus "read docs/BUILDING-ON.md"). The parts a computer can check are checked by the Foundation rules member (Task 5): protected foundation files untouched; a new table comes with a migration, a demo seeder and a crossing resource seeder; a new `defineRoute` comes with a change to `apps/server/test/crossing/cases.ts`; a new `APP_PATHS` entry comes with a change to `apps/web/e2e/pages.ts`. The rest (`EXPECTED_ROLES` contents, `visibleTo`, cursors) is enforced by the foundation's own `verify` (the crossing harness's coverage gate) and the reviewers.
6. **Naming the app is done by code**, not a model.
   - The setup phase rewrites the single `BRAND` line of `apps/web/src/brand.ts` (appName = brief `client`, shortName = initials).
   - In the same commit on the build branch, it writes `app-profile.json` from the approved brief (`{ schema: 1, modules, policy: { outbound, residency } }`, Contract 7 §7.5).
   - The palette is left at the foundation default; Plan 9's design member may comment.
7. **A feature's gate is answered by the orchestrator, fail closed:** approve only when `tests.passed === true` and the feature council is not `blocked` (or the operator overrode it through the existing council escalation). A final-review BLOCK goes to the operator (`hooks.escalate`, approve/reject). Anything else rejects the feature run and stops the build (resumable).
8. **Workspaces live outside the project folder** (the default `~/.conductor/workspaces`). The project folder holds `notes/`, the client's raw meeting notes, which no model may read beyond the brief step (Contract 1). Feature runs use `keepWorkspace: true` so a crash after landing is recoverable from `state.json`; the orchestrator archives the transcript into `builds/<runId>/features/` and removes the workspace after the squash-merge.
9. **The app repo** is a clone of the foundation at the pinned tag, with `main` created at the tag and the remote renamed `foundation` (BUILDING-ON step 1).
   - Only local paths, `file://` and `https://` foundation repos are accepted; `ssh` URLs are refused.
   - The tag must match `^v\d+\.\d+\.\d+$`, and the clone must have `foundation.json` with `commit` equal to the tag.
   - `project.json.foundation` becomes `{ repo, tag, commit }`. A later build refuses if the tag now points at a different commit.
   - **At the gate:**
     - approval moves `main` by compare-and-swap;
     - it writes `project.json.approved = { sha, at, runId, briefVersion }` and `builtFromBrief`, and sets `status: 'ready'` (Contract 7 §7.5–§7.6);
     - no tag or release is made. Plan 10's `releaseApp` cuts the first release when the app ships.
10. **Refusals before any spend:**
    - no approved brief;
    - a brief with `modules` (the optional modules arrive in Plan 12);
    - a brief feature with no acceptance example, or an example with no id;
    - project status `ready` or `shipped` (changes go through Plan 11's `conductor change`, which lifts this refusal through `options.change`);
    - `TEST_DATABASE_URL` unset while the real `verify` is the test command;
    - a build, brief or change already running for this project (Plan 7's `lockProject`).
11. **Machines, fail closed.**
    - Every value placed in a remote script is validated against a strict pattern and single-quoted (`shQuote`).
    - SSH runs with `BatchMode=yes`. Static hosts need `StrictHostKeyChecking=yes` against the operator's own `known_hosts`; a fresh Proxmox container is trusted on first use into its own `known_hosts` file under `~/.conductor/machines/` (`accept-new`), deleted when the container is destroyed.
    - A static host is locked with an atomic `mkdir` on the host; only the lock's own run may release it.
    - The Proxmox provider never stops or deletes a container unless it is in the configured pool, inside the VMID range **and** tagged `hf-factory`. It checks this immediately before every destructive call. A failed `acquire` destroys what it created before throwing.
    - TLS to Proxmox is always verified (`caFile` or the system store); plain `http://` is accepted only for `127.0.0.1` (the test stub).
    - The token secret comes from an environment variable (default `CONDUCTOR_PROXMOX_TOKEN`), which is scrubbed from every child process and redacted.
12. **Previews run on the operator's network only** (spec §4.2): `HTTP_PORT` is bound to the machine's own LAN address, the origin is `http://<host>:<port>/` (so cookies work without HTTPS), `INSTANCE_MODE=demo`, mail goes to a Mailpit container, and the `ops` service is not started (a preview needs no backups or alerts). Compose still needs `BACKUP_REPOSITORY`, so it is set to the placeholder `/preview-has-no-backups`. One preview per project at a time; a new preview of a different commit replaces the old one.
13. **`conductor machines [list|sweep]`** (Contract 7 §7.8): list the factory's machines; tear down leftovers older than 6 hours, sparing live previews.
14. **Two fix caps, kept apart (Contract 7 §7.7):**
    - red whole-app checks use `factory.build.fixRounds` (default 2);
    - blocking whole-app council findings use `factory.build.councilFixRounds` (default 3, spec §4.3);
    - each has its own counter in `build.json`;
    - Plan 5's per-run `options.councilFixRounds` still caps the bounce-back inside one feature run.
15. **A secret seen by the council** (`secretSeen: true`, sticky for the build) makes the whole `build/<runId>` branch one commit before the gate. The tree is identical, and the old commits are pruned from the app repo (Plan 5 Ruling 10).
16. **Whole-app checks write JSON reports** (vitest and Playwright) straight into `builds/<runId>/reports/`, by adding reporters on the command line; no app file changes. `checks.reports` lists them, and `runFinal` hands `checks` to `hooks.council` for the same `sha`.

## What this plan imports from Plan 7 (Contract 7 §7.1)

This plan builds none of these. It imports them, and Task 1 Step 1 checks every name before any code is written:
- `src/factory/config.js`: `factoryConfig(config, { env, home })`. Plan 7 creates it, including `projectsRoot` and `operatorName`; **Task 1 extends it** with `foundation`, `build` and `machines` (Contract 7 §7.2). `loadConfig` keeping `factory` is Plan 7's change.
- `src/factory/projects.js`: `projectDir(root, slug)`, `readProject(root, slug) -> { dir, project }`, `loadProject(dir)`, `saveProject(dir, project)` (atomic).
- `src/factory/projectLock.js`: `lockProject(projectDir, kind) -> release()`. Kind `'build'` is used by `runBuild`; kind `'preview'` by previews (see "Contract 7 deviations").
- `src/factory/acceptance.js`: `acceptanceIds(brief)` and `testTag(id) -> '[<id>]'`. This plan reads only `.id`, `.featureId` and `.example` of each `acceptanceIds` entry.
- `src/factory/outbound.js`: `OUTBOUND_SERVICES`, used to show `policy.outbound` ids with their labels in feature requests.
- `src/factory/fsAtomic.js`: `writeJsonAtomic`.
- `src/factory/brief.js`: `loadBrief`, `renderBrief`, `validateBrief`, `currentBriefInfo` (its `version` becomes `build.briefVersion`).
- `src/plan.js`: `extractJson` (exported by Plan 7).
- `src/cli/factory.js`: `FACTORY_COMMANDS` and `runFactoryCommand`. This plan adds the `build`, `preview`, `machines` and `resume` handlers to the table (Task 15).
- A new `project.json` has `foundation: { repo: null, tag: null }`, `approved: null` and `builtFromBrief: null`. This plan fills `foundation` at the first build, and `approved` and `builtFromBrief` at the gate.

If Plan 7 merged any of these under another name, stop and report it; do not add a local copy.

## Contract 7 deviations and open points

- **[deviation from Contract 7 §7.3: `main.js` is touched once more, in Task 15.]** `conductor build` needs `main()`'s inline team preparation:
  - worker checks, waking and `buildTeam`;
  - the local-down question;
  - usage memory and the Ctrl-C handler;
  - the hooks and overrides.
  
  A `FACTORY_COMMANDS` handler cannot reach that code without copying it. Task 15 moves the block unchanged into `src/cli/prepareRun.js`, which both `main()` and the build handler call. It also lets a handler return `null` for "not mine here", which `conductor resume` needs inside a project folder (Contract 5). No behaviour changes, and the existing CLI tests pass unedited. The alternative is for Plan 7 to export the same `prepareRun` and the `null` fall-through from its own `main.js` change; then Task 15 only imports them.
- **[deviation from Contract 7 §7.1: `lockProject` needs a fourth kind, `'preview'`.]** The contract lists `'brief'|'build'|'change'`.
  - A preview must not run twice at once for one project, or a machine leaks and `preview.json` is overwritten.
  - It also must **not** be blocked by a running build, because previewing the build in progress is its main use.
  - So Task 14 calls `lockProject(projectDir, 'preview')`, and Plan 7 is asked to accept `'preview'` as a kind whose lock is separate from the brief/build/change lock (for example `.preview.lock`).
  - If Plan 7 declines, Task 14 needs another small lock, which would duplicate Plan 7's stale-pid logic.
- **Note (not a deviation):** Contract 7 §7.5 says "`createApp` writes `app-profile.json`". In this plan, `app.js`'s `nameApp` writes it, in the first build's BRAND commit (Task 2). `createApp` only clones onto `main`, which must stay at the foundation tag until approval.
- **Still open:**
  - Plan 7's exact `FACTORY_COMMANDS` handler signature. Task 15 assumes `handler(cli, ctx)` with `runFactoryCommand`'s `ctx`; only its four thin wrappers change if it differs.
  - The exact entry shape of `acceptanceIds`. Task 1 Step 1 records it.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. `npm test` (`node --test`) stays green at every commit.
- **Tests never touch real infrastructure:** no network beyond `127.0.0.1`, no real `ssh`/`scp`/`docker`, no real Proxmox, no real client box, no real model. Remote scripts are tested by running them locally under `bash` with stub `docker`/`curl` on `PATH` and a temporary work root.
- **The foundation is used, never edited.** Conductor never writes to `/root/highland-foundation` (tests use a tiny fake foundation repo made in a temp dir).
- **No client data** reaches a model or the project folder; previews and checks use demo data only.
- **Fail closed** everywhere: only exact `true` approves, only the lock owner releases, only tagged in-range in-pool containers are destroyed, unknown config keys are errors.
- **Plain UK English** for every operator-facing message; no stack traces, no raw JSON. Credentials never appear in prompts, state, events, terminal output or test output.
- **Atomic writes** (temp file, fsync, rename, through Plan 7's `fsAtomic.js` and `saveProject`) for `project.json`, `build.json` and `preview.json`.
- Existing assertions change in exactly two places: Task 5 (`MEMBER_LABEL` gains `foundation`) and Task 15 (the two `parseCli` flag `deepEqual`s gain `stop: false, newBuild: false`). Task 15's `prepareRun` extraction must pass every existing CLI test unedited.

## Review Focus

1. **A crash or Ctrl-C at every seam of a build:**
   - mid-feature;
   - after a feature run landed but before its squash-merge;
   - after the merge but before `build.json` was saved;
   - in the final checks;
   - at the gate.
   
   Running `conductor build <slug>` again finishes the build without repeating a merged feature or merging one twice. An approval that already moved `main` is not asked again, and it still writes `project.json.approved`. Pinned in Tasks 7, 8 and 9.
2. **An agent that games the gates**: edits the crossing harness or `foundation.json`, adds `.only`/`.skip` to an acceptance test, drops a tag, or changes `scripts.verify` in `package.json`. The Foundation rules member blocks with a locked finding the interpreter cannot clear. Pinned in Task 5.
3. **A brief too big for the local model** (a feature with 15 examples, a 20 000-character story): the split is refused with a reason the author can act on, and no feature request over 7000 characters ever reaches a run. Pinned in Tasks 3 and 4.
4. **Hostile or odd values reaching a remote shell** (a client called `Acme'; rm -rf /`, a slug with spaces, a run id with `$()`): nothing unquoted reaches `bash`. Pinned in Tasks 10 and 14.
5. **A machine that is busy, unreachable or half-made** (lock held by another preview, SSH refused, Proxmox clone succeeds but start fails, VMID outside the range offered for deletion): plain message, nothing leaked, nothing outside the factory's area touched. Pinned in Tasks 11 and 13.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/factory/config.js` (Plan 7's; extended) | `factoryConfig` gains the `foundation`, `build` and `machines` sections | 1 |
| `src/factory/ids.js` | `newRunId`, `composeProjectOf`, `SLUG_RE`, `RUN_ID_RE` | 1 |
| `test/helpers/factoryFixtures.js` | fake foundation repo, sample brief, project folder | 1 (used by 2–9, 14, 15) |
| `src/factory/app.js` | `createApp`, `nameApp` (BRAND line + `app-profile.json`), `appProfileOf` | 2 |
| `src/factory/featureRequest.js` | `featureRequest`, `acceptanceStep`, `BUILDING_ON_RULES`, `REQUEST_BUDGET` | 3 |
| `src/planPhase.js`, `src/prompts.js`, `src/options.js`, `src/conductor.js` (modify) | `firstChunk` option | 3 |
| `src/factory/split.js` | `briefProblems`, `parseSplit`, `validateSplit`, `runSplit` (ids from Plan 7's `acceptanceIds`) | 4 |
| `src/council/foundationRules.js` | `FOUNDATION` member, `PROTECTED_PATHS`, `isTestPath` | 5 |
| `src/council/index.js`, `src/council/findings.js`, `src/council/tools.js`, `src/prompts.js`, `src/options.js`, `src/conductor.js` (modify) | member registry, `councilMembers`, `factoryFeature` | 5 |
| `src/factory/checks.js` | `runAppChecks` (with vitest/Playwright JSON reports), `VERIFY_COMMAND`, `verifyWithReports`, `browsersInstalled` | 6 |
| `src/factory/buildState.js` | `build.json` store, `mergeFeature`, `archiveFeatureRun` (the lock is Plan 7's) | 7 |
| `src/factory/build.js` | `runBuild`: setup, split, feature loop | 8 |
| `src/factory/buildFinal.js` | final checks, council hook, secret squash, operator gate (`project.json.approved`), fix features, `buildSummaryText` | 9 |
| `test/helpers/buildHarness.js` | shared fake team and project set-up for build tests | 9 |
| `src/factory/remote.js` | `shQuote`, `assertSafe`, remote script builders (lock, unlock, teardown, list, sweep) | 10 |
| `src/factory/ssh.js` | `createSsh({ sshBin, scpBin, run })` → `exec`, `upload` | 10 |
| `test/helpers/stubDocker.js` | fake `docker` (and later `curl`) for running remote scripts locally | 10 (extended in 14) |
| `src/factory/machines/index.js` | `getMachineProvider` | 11 |
| `src/factory/machines/static.js` | `StaticProvider` | 11 |
| `src/factory/machines/pveApi.js` | `createPveClient` | 12 |
| `test/helpers/pveStub.js` | in-memory Proxmox API on 127.0.0.1 | 12 |
| `src/factory/machines/proxmox.js` | `ProxmoxProvider` | 13 |
| `src/factory/deploy.js` | `bringUpDemo`, `demoUpScript` (shared with Plan 9) | 14 |
| `src/factory/preview.js` | `startPreview`, `stopPreview`, `preview.json` | 14 |
| `src/cli/factoryBuild.js` (create), `src/cli/factory.js` (Plan 7's; register handlers), `src/cli/args.js`, `src/ui/terminal.js`, `src/ui/status.js` | `build`, `preview`, `machines`, resume routing, build gate prompt, progress lines | 15 |
| `src/cli/prepareRun.js` (create), `src/cli/main.js` (move only) | `main()`'s team preparation, reusable by `build` (deviation, see above) | 15 |
| `README.md`, `config.example.json`, `spikes/factory-build-smoke/` | docs, operator smoke, follow-ups | 16 |

## Tasks

1. [Factory config sections, ids and the Contract 7 imports](task-01-config-ids.md)
2. [The app from the foundation tag](task-02-app.md)
3. [Feature requests and the fixed first step](task-03-feature-request.md)
4. [Splitting the brief into features](task-04-split.md)
5. [The Foundation rules council member](task-05-foundation-rules.md)
6. [Whole-app checks](task-06-checks.md)
7. [Build state and squash-merge](task-07-build-state.md)
8. [The build loop](task-08-build-loop.md)
9. [Final checks, council hook and the operator's gate](task-09-build-final.md)
10. [Remote scripts and SSH](task-10-remote-ssh.md)
11. [The static machine provider](task-11-static.md)
12. [Proxmox API client and stub](task-12-pve-api.md)
13. [The Proxmox machine provider](task-13-proxmox.md)
14. [Demo deploy and previews](task-14-preview.md)
15. [Commands: build, preview, machines](task-15-cli.md)
16. [Docs, operator smoke and follow-ups](task-16-docs-smoke.md)

Order: 2–6 need 1; 4 also needs 3; 6 also needs 10 (`shQuote`); 7 needs 1; 8 needs 2–7; 9 needs 8; 10 needs 1; 11 needs 10; 12 needs 1; 13 needs 10–12; 14 needs 10 and 11; 15 needs 9 and 14; 16 needs all. Tasks 10–13 can run alongside 2–9 (do 10 before 6).

## Shared Interfaces (all tasks)

```js
// Task 1 — src/factory/ids.js
SLUG_RE = /^(?=.{1,40}$)[a-z0-9]+(?:-[a-z0-9]+)*$/          // Plan 7's slug rule
RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/
newRunId(now = new Date(), rand = () => randomBytes(2).toString('hex')) -> '20261027-143005-a1b2'   // UTC
composeProjectOf(slug, runId) -> `hf-${slug}-${runId}`                                              // throws on a bad slug/runId
COMPOSE_PROJECT_RE = /^hf-[a-z0-9-]+-\d{8}-\d{6}-[0-9a-f]{4}$/

// src/factory/config.js — Plan 7's factoryConfig; Task 1 adds foundation, build, machines (Contract 7 §7.2)
factoryConfig(config, { env = process.env, home = homedir() } = {}) -> FactoryConfig   // throws plain English
FactoryConfig = {
  projectsRoot, operatorName,                          // Plan 7
  foundation: { repo, tag },                           // default { repo: '/root/highland-foundation', tag: 'v0.1.0' }
  build: { testCommand: string|null, browserGate: boolean, fixRounds: number, councilFixRounds: number },
                                                       // null → verifyWithReports; defaults true, 2 (red checks), 3 (council)
  machines: { provider: 'static'|'proxmox', sshBin, scpBin, sweepAfterMs,          // defaults 'static','ssh','scp', 6 h
    static: { hosts: [{ id, name, host, user, keyPath, previewPort, workRoot }] },
    proxmox: null | { apiUrl, node, tokenId, tokenEnv, caFile, pool, template, vmidRange: [lo, hi], maxContainers,
                      maxMemoryMb, cores, memoryMb, fullClone, user, keyPath, previewPort, workRoot } },
  alerts, ship }                                       // Plan 10

// Imported from Plan 7 (Contract 7 §7.1; Task 1 checks)
projectDir(root, slug); readProject(root, slug) -> { dir, project }; loadProject(dir); saveProject(dir, project)   // projects.js
lockProject(projectDir, kind) -> release()          // projectLock.js; kinds used here: 'build', 'preview' (see deviations)
acceptanceIds(brief) -> [{ id, featureId, example, … }]; testTag(id) -> '[<id>]'   // acceptance.js; id = example.id, stable
OUTBOUND_SERVICES = { [id]: { label, hosts, carries } }                          // outbound.js
writeJsonAtomic(file, obj)                                                       // fsAtomic.js
loadBrief(projectDir); renderBrief(brief); validateBrief(obj, { stage }); currentBriefInfo(projectDir) -> { version, … }   // brief.js
FACTORY_COMMANDS = { [command]: handler(cli, ctx) }; runFactoryCommand(cli, ctx)  // src/cli/factory.js
project.json = { schema: 1, slug, client, createdAt, status, foundation: { repo, tag, commit } | { repo: null, tag: null },
                 approved: null | { sha, at, runId, briefVersion }, builtFromBrief: number | null }   // Contract 7 §7.5

// Task 2 — src/factory/app.js
createApp({ projectDir, foundation: { repo, tag }, expectCommit = null, git = gitFn }) -> Promise<{ appDir, commit, created: boolean }>
initialsOf(client) -> string
nameApp({ appDir, brief, git = gitFn }) -> Promise<string|null>          // BRAND line + app-profile.json in one commit; null when already done
appProfileOf(brief) -> { schema: 1, modules, policy: { outbound, residency } }   // <app>/app-profile.json (Contract 7 §7.5)
FOUNDATION_REMOTE = 'foundation'

// Task 4 — src/factory/split.js
parseSplit(text) -> { ok: true, units } | { ok: false, error }
validateSplit(units, brief) -> { ok: true, units } | { ok: false, problems: string[] }
briefProblems(brief) -> string[]
runSplit(sctx, brief) -> Promise<{ status: 'ok', units, note } | { status: 'failed'|'paused'|'stopped', reason }>
Unit = { id, title, covers: string[], acceptance: string[] /* example ids */, instructions, dependsOn: string[], kind: 'feature'|'fix' }
MAX_UNITS = 30; MAX_EXAMPLES_PER_UNIT = 6; MAX_INSTRUCTIONS = 2000

// Task 3 — src/factory/featureRequest.js
REQUEST_BUDGET = 7000
featureRequest({ brief, units, index }) -> string            // throws if over budget (validateSplit calls it first)
acceptanceStep({ brief, unit }) -> { title: 'Acceptance tests', instructions } | null   // null for a unit with no examples (fix units)
BUILDING_ON_RULES: string
// options: firstChunk: null | { title, instructions } — planPhase puts it first; author plans the rest (maxChunks - 1)

// Task 5 — src/council/foundationRules.js
FOUNDATION = { member: 'foundation', label: 'Foundation rules', alwaysInterpret: false, collect(input) }
PROTECTED_PATHS: string[]; isTestPath(path) -> boolean
// options: councilMembers: null | string[] (names from MEMBERS); factoryFeature: null | { id, tags: string[] }
MEMBERS = { security, legal, correctness, foundation }; membersFor(names) -> Member[]
FEATURE_COUNCIL = ['foundation', 'correctness']

// Task 6 — src/factory/checks.js
VERIFY_COMMAND = '{ [ node_modules/.package-lock.json -nt package-lock.json ] || npm ci --no-audit --no-fund --loglevel=error; } && npm run verify'
browsersInstalled({ env, home }) -> { ok: boolean, why: string }
verifyWithReports(reportsDir) -> VERIFY_COMMAND + ' -- -- --reporter=default --reporter=json --outputFile.json=<reportsDir>/vitest.json'
runAppChecks({ appDir, sha, workDir, reportsDir, testCommand = null, browser, env, run = runCommand }) -> Promise<AppChecks>
AppChecks = { verify: Check, browser: Check, reports: string[] }   // build.checks adds sha
// reports: absolute paths in reportsDir, whichever exist, with these fixed names (Plans 9 and 12 look them up by name):
//   vitest.json, playwright.json (PLAYWRIGHT_JSON_OUTPUT_FILE + --reporter=list,json), crossing.md, crossing.json, screenshots
Check = { status: 'passed'|'failed'|'missing'|'skipped', summary: string, output: string }

// Task 7 — src/factory/buildState.js
buildDirOf(projectDir, runId); loadBuild(buildDir) -> Build|null; saveBuild(buildDir, build); latestBuild(projectDir) -> Build|null
mergeFeature({ appDir, buildBranch, landedBranch, landedSha, expectedBase, message, git }) -> Promise<sha>   // idempotent, see task
newBuild({ runId, slug, client, briefHash, briefVersion, foundation, now }) -> Build; hashBrief(brief); appendBuildLog(buildDir, type, data); readRunState(workspaceDir)
archiveFeatureRun({ workspaceDir, buildDir, index, id }) -> string|null   // transcript copy path; removes the workspace
Build = { schema: 1, kind: 'build', runId, slug, client, startedAt, briefHash, briefVersion, foundation, branch, baseSha,
          phase: 'setup'|'split'|'features'|'final'|'gate'|'done', status: 'running'|'paused'|'failed'|'stopped'|'ready'|'rejected',
          units: Unit[], features: FeatureRecord[], fixRounds: 0, councilFixRounds: 0, secretSeen: false, squashedSha: null,
          usage: { costUsd, apiCostUsd, apiCalls },
          checks: AppChecks|null, council: object|null, notes: string[], warnings: string[], reason: string|null }
FeatureRecord = { id, title, status: 'pending'|'running'|'landed'|'merged'|'stopped'|'failed'|'paused',
                  attempts, workspaceDir, branch, landedSha, baseSha, mergedSha, transcript, notes: string[], councilText, gateReason }

// Task 8 — src/factory/build.js
runBuild({ factory, slug, team, hooks, options = {}, baseDir, warnings = [], env = process.env, deps = {} }) -> Promise<BuildOutcome>
BuildOutcome = { status: 'ready'|'rejected'|'stopped'|'failed'|'paused', runId, buildDir, reason?, note? }
options.newBuild?: true                       // --new; stripped before runTask
options.change                                // RESERVED for Plan 11 (Contract 7 §7.7): { runId, baseRef, units }; skips setup and split,
                                              //   lifts the ready/shipped refusal. Not read or built here; stripped before runTask.
hooks = { escalate, approveBuild, onEvent?, confirmLocalFallback?, approvePlan?, council?, onProgress? }
deps = { runTask, resume, runAppChecks, loadBrief, renderBrief, currentBriefInfo, mergeFeature, runFinal, now }
events (hooks.onEvent and builds/<runId>/build-log.jsonl):
  'build-start' { runId, slug, resumed }        'build-split' { units: [{ id, title }] }
  'build-feature' { index, total, id, title, attempt }   'build-feature-done' { index, id, status, sha }
  'build-checks' { verify, browser }   'build-council' { status }   'build-finish' { status, reason }

// Task 9 — src/factory/buildFinal.js
runFinal(bctx) -> Promise<{ next: 'features' } | BuildOutcome>
buildSummaryText({ build, project, checks, councilText, slug }) -> string; fixUnit({ build, title, instructions, prefix }) -> Unit; NO_COUNCIL_YET
squashBuild({ appDir, branch, sha, onto, message, git }) -> Promise<sha>     // secretSeen: one commit, same tree, CAS
hooks.council (Plan 9, Contract 7 §7.7) -> ({ projectDir, appDir, sha, brief, policy: brief.policy, runId, slug, team, factory, onEvent, checks })
  -> Promise<{ status: 'approved'|'approved-with-warnings'|'blocked'|'paused', text: string, fix?: { title, instructions }, reason?: string, secretSeen?: boolean }>
// at approval: main moves by CAS; project.json gets approved { sha, at, runId, briefVersion }, builtFromBrief, status 'ready'; no release
hooks.approveBuild({ summary }) -> true | false | { approved: false, note }

// Task 10 — src/factory/remote.js, src/factory/ssh.js
shQuote(s) -> string; assertSafe(kind, value) -> value   // kinds: slug, runId, project, path, host, user, port, client, purpose, image
lockScript({ root, owner }) / unlockScript({ root, runId }) / readLockScript({ root })
teardownScript({ root, project, images }) / sweepScript({ root, olderThanSec, keepRuns })
createSsh({ sshBin = 'ssh', scpBin = 'scp', run = runCommand }) -> { exec(machine, script, { timeoutMs }), upload(machine, localFile, remotePath, { timeoutMs }) }
  // exec resolves { code, stdout, stderr }; ssh failure (255) -> code 255 and stderr; throws only on an unsafe host/user/path
parseMarker(stdout) -> { marker, rest }; ownerJson(labels) -> string; unreachable(r) -> boolean

// Task 11 — src/factory/machines/{index,static}.js
getMachineProvider(factory, { ssh, pve, now, env } = {}) -> Provider
runImages(slug, runId) -> ['hf-preview/<slug>-app:<runId>', 'hf-preview/<slug>-ops:<runId>']; whenText(iso) -> '14:30 27 Oct'
Provider = { kind, acquire({ purpose: 'preview'|'council'|'smoke'|'ship', projectSlug, runId }) -> Machine, list() -> Machine[], sweep({ olderThanMs, keep = [] }) -> number }
Machine = { id, host, ssh: { user, keyPath, knownHostsFile: string|null, hostKeyPolicy: 'yes'|'accept-new' },
            labels: { factory: 'hf', project, run, purpose, createdAt }, provider, runDir, composeProject, previewPort,
            release(): Promise<void> }
MachineError (plain message; .code 'busy'|'unreachable'|'cap'|'config'|'failed')
provider.notes: string[]   // plain notes from the last list()/sweep(); Proxmox machines also carry vmid, and the provider has destroy(vmid) (guarded)

// Task 12 — src/factory/machines/pveApi.js
createPveClient({ apiUrl, tokenId, secret, caFile = null, request = defaultRequest, sleep, now }) ->
  { get(path), post(path, form), put(path, form), del(path), waitTask(node, upid, { timeoutMs }) }

// Task 13 — src/factory/machines/proxmox.js
ProxmoxProvider; tagsFor(labels) -> 'hf-factory;hf-p-<slug>;hf-r-<runId>;hf-u-<purpose>;hf-t-<unixSeconds>'; labelsFromTags(str) -> labels|null

// Task 14 — src/factory/deploy.js, src/factory/preview.js
demoUpScript({ root, project, slug, runId, client, origin, bindHost, port, version, commit }) -> string
bringUpDemo({ machine, appDir, sha, slug, runId, client, ssh, git, tmpDir }) -> Promise<{ url, seedText }>
startPreview({ factory, slug, deps }) -> Promise<{ status: 'started'|'already', url, seedText, sha, from }>
stopPreview({ factory, slug, deps }) -> Promise<{ status: 'stopped'|'none'|'gone' }>
previewRuns(projectsRoot) -> string[]   // run ids of every live preview (a sweep spares them)
<project>/preview.json = { schema: 1, runId, machineId, provider, host, url, sha, from: 'main'|'build', startedAt }   // Contract 7 §7.5

// Task 15 — src/cli/factoryBuild.js, src/cli/prepareRun.js
FACTORY_COMMANDS += { build: buildCommand, preview: previewCommand, machines: machinesCommand, resume: resumeBuildCommand }
handler(cli, ctx) -> Promise<number | null>    // null (resume only): not a build here; main carries on
prepareRun({ cli, config, term, env, baseDir, workspaceDir, wakeDeps, onSignal, exit, interruptedText }) -> { code } | { built, hooks, overrides, remember }
BUILD_EXIT = { ready: 0, rejected: 1, stopped: 1, failed: 2, paused: 3 }
```

## Notes for the plans that build on this one

- **Plan 9 (full council)** fills `hooks.council` with the Contract 7 §7.7 signature above.
  - It gets the build branch's tip `sha`, the app folder, the brief and its policy, the build's `team`, and `checks`: the `AppChecks` for that same `sha`. `checks.reports` holds `vitest.json`, `playwright.json`, `crossing.md`, `crossing.json` and `screenshots` (fixed names) under `builds/<runId>/reports/`.
  - A `blocked` result with a `fix` becomes a fix feature, capped by `factory.build.councilFixRounds` (its own counter, separate from red checks).
  - `secretSeen: true` squashes the build branch before the gate.
  - For its deploy tests it should call `getMachineProvider(factory).acquire({ purpose: 'council', … })` and `bringUpDemo` (Task 14), then `machine.release()` in a `finally`.
  - With the `static` provider and one host, a running preview makes the machine busy (`MachineError` code `busy`). Plan 9 must report that plainly rather than fail the build.
- **Plan 10 (ship)** ships the app's `main` branch, which moves only on the operator's approval.
  - `project.json.status` is then `ready`, and `approved.sha` names the approved commit. No release exists yet: `releaseApp` cuts the first one.
  - It reads the foundation repo from `factory.foundation.repo`.
  - It builds release images on a machine acquired with `purpose: 'ship'`, and its `cleanupBuild` must remove the `highland/app` and `highland/ops` images it built (Contract 7 §7.8).
- **Plan 11 (changes)** adds `options.change = { runId, baseRef, units }` to `runBuild`. Task 8 reserves the name and keeps the phases as separate functions. That option skips setup and the split, and lifts the `ready`/`shipped` refusal for that call only. Acceptance tags use the brief's stable example ids, so a revised brief keeps the tags of unchanged examples. At merge, Plan 11 writes `approved` and `builtFromBrief` the same way this plan's gate does.
- **Plan 12 (modules)** must lift the `modules` refusal in `briefProblems`. `appProfileOf` already copies `brief.modules` into `app-profile.json`.
- `PROTECTED_PATHS` (Task 5), `demoUpScript` (Task 14) and the reporter arguments (Task 6) follow the foundation v0.1.0 layout and scripts. A foundation release that moves those files, or changes the end of `verify` / `test:e2e`, needs them updated.

## Operator follow-ups

Listed in full in [Task 16](task-16-docs-smoke.md): CT 111 SSH key, host key and `/srv/hf-factory`; a PostgreSQL role and `TEST_DATABASE_URL`; the `factory` config block; and for the `proxmox` provider the `hf-factory` pool, a VMID range, a Docker-ready unprivileged LXC template with nesting in the pool, a scoped role, user and privilege-separated token (secret in `CONDUCTOR_PROXMOX_TOKEN`), and the Proxmox CA file.
