# Conductor Plan 8 — Building from nothing, previews and machines (factory phase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** `conductor build <slug>` turns an approved brief into a working client app: it creates the app from the pinned foundation tag, has the author split the brief into small ordered features, builds each one through the existing plan → chunk → review loop with its acceptance examples written as tests first, keeps the foundation's `npm run verify` green, survives crashes and Ctrl-C, and ends at a council hook (filled by Plan 9) and the operator's gate. `conductor preview <slug> [--stop]` runs the app with demo data on a factory machine and prints its address. The machines come from a `static` provider (CT 111 today) or a `proxmox` provider (built against a stubbed API), with locks, labels, clean-up and sweep.

**Architecture:**
- **One feature = one ordinary Conductor run.** The build orchestrator (`src/factory/build.js`) calls the existing `runTask`/`resume` once per feature, on the client's own app repo (`<project>/app`). Nothing in the run loop is forked. Each run gets a deterministic, size-checked request built from the brief, a fixed first step ("Acceptance tests"), and a small council made of a new deterministic **Foundation rules** member plus the existing Correctness member (the bounce-back loop from Plan 5 then fixes what they find). Its gate is answered by the orchestrator, not the operator: a feature is accepted only with passing checks and no unresolved blocking finding.
- **The app repo is the factory's own.** Features land on a `build/<runId>` branch, one squashed commit per feature, so every commit on it passes `verify`. `main` moves only when the operator approves the whole build.
- **Build state** is `builds/<runId>/build.json` (atomic writes), plus a project-level lock. Every phase is re-entrant: `conductor build <slug>` or `conductor resume` (inside the project folder) carries on from the last saved point.
- **Final phase:** whole-app checks in a throwaway clone (`verify` and the browser gate), then `hooks.council` (Plan 9 fills it; until then the summary says so), then the operator's gate. Feedback from the operator or blocking council findings become extra "fix" features, capped.
- **Machines** (`src/factory/machines/`): `getMachineProvider(factoryConfig)` returns the provider. All remote work is a generated bash script sent over `ssh … bash -s` (no Docker socket locally). Previews use the foundation's own image Dockerfiles, `ops init --demo`, Compose and the demo seeder.

**Tech Stack:** Node ≥ 20 (ESM, `node --test`, zero dependencies), `git` CLI, `ssh`/`scp` clients and `node:https` at runtime. On the factory machines: Docker Engine + Compose v2. Tests stub `ssh`, `scp`, `docker`, git remotes and the Proxmox API, and never touch real infrastructure.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md` §2 (quality bar), §4.2 (build, previews), §4.7 (test machines), §5 (foundation), §7 (constraints), §8 item 5. **Binding contracts:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md` Contract 1 (project folder), Contract 2 (brief, consumed), Contract 3 (machines, produced here), Contract 5 (`build`, `preview`). **Foundation:** `/root/highland-foundation` at tag `v0.1.0`, especially `docs/BUILDING-ON.md` and `docs/RUNBOOK.md`.

Plans 1–6 are merged. Plan 7 (brief intake) is written in parallel against Contract 2 and lands first; this plan consumes only what Contract 2 names plus the small seam listed under "Plan 7 seam" below.

## Rulings made while scoping (decided, not open)

1. **Reuse, don't fork, the run loop.** Each feature is `runTask({ repoDir: appDir, request, options })`. The only core changes are additive options: `firstChunk` (Task 4), `councilMembers` and `factoryFeature` (Task 5). With them unset, every existing behaviour and test is unchanged.
2. **Context size is enforced in code, not hoped for.**
   - `prompts.js` clips every request to 8000 characters (`TEXT_MAX`). A feature's request must therefore fit **7000 characters** (`REQUEST_BUDGET`), checked when the feature list is accepted; a split whose rendered request is too long goes back to the author as a failed round.
   - At most **6 acceptance examples** and at most **one new database table** per feature; **at most 30 features** per build; `maxChunks` stays 12, including the fixed first step.
   - A feature's request names the other features **by title only**. Each run starts from a fresh workspace; the codebase, not a conversation, carries what earlier features did.
   - The whole brief goes only to the frontier author during the split (once per build). Local-model prompts never carry the brief, only the feature's own slice of it.
3. **Acceptance examples become tests first.** Every example gets a tag `[<briefFeatureId>#<n>]` (1-based position in that brief feature's `acceptance` list). The fixed first step of every feature run is titled `Acceptance tests` and writes one test per example, with the tag in the test's name. The Foundation rules member then **blocks** a feature whose finished tree lacks any of its tags in a test file, or that skips (`.skip`, `.todo`) or focuses (`.only`) a tagged test, and **warns** (locked) when the first step's commit was not test-only.
4. **`verify` stays green at every commit the operator sees.** The test command of every feature run is `VERIFY_COMMAND` (install if needed, then `npm run verify`). Step 1's tests are expected to fail; the feature is accepted only when `verify` passes. On the build branch each feature is **one squashed commit**, so the foundation's "must pass at every commit" holds. The browser gate (`npm run test:e2e`) runs once per build, in the final checks, because it takes minutes and needs browsers.
5. **The foundation's mandatory checklist is applied twice.** It is written into every feature request (`BUILDING_ON_RULES`, a compact copy of BUILDING-ON "Adding a feature", plus "read docs/BUILDING-ON.md"). The parts a computer can check are checked by the Foundation rules member (Task 5): protected foundation files untouched; a new table comes with a migration, a demo seeder and a crossing resource seeder; a new `defineRoute` comes with a change to `apps/server/test/crossing/cases.ts`; a new `APP_PATHS` entry comes with a change to `apps/web/e2e/pages.ts`. The rest (`EXPECTED_ROLES` contents, `visibleTo`, cursors) is enforced by the foundation's own `verify` (the crossing harness's coverage gate) and the reviewers.
6. **Naming the app is done by code**, not a model: the setup phase rewrites the single `BRAND` line of `apps/web/src/brand.ts` (appName = brief `client`, shortName = initials) and commits it on the build branch. The palette is left at the foundation default; Plan 9's design member may comment.
7. **A feature's gate is answered by the orchestrator, fail closed:** approve only when `tests.passed === true` and the feature council is not `blocked` (or the operator overrode it through the existing council escalation). A final-review BLOCK goes to the operator (`hooks.escalate`, approve/reject). Anything else rejects the feature run and stops the build (resumable).
8. **Workspaces live outside the project folder** (the default `~/.conductor/workspaces`). The project folder holds `notes/`, the client's raw meeting notes, which no model may read beyond the brief step (Contract 1). Feature runs use `keepWorkspace: true` so a crash after landing is recoverable from `state.json`; the orchestrator archives the transcript into `builds/<runId>/features/` and removes the workspace after the squash-merge.
9. **The app repo** is a clone of the foundation at the pinned tag, with `main` created at the tag and the remote renamed `foundation` (BUILDING-ON step 1). Only local paths, `file://` and `https://` foundation repos are accepted; `ssh` URLs are refused. The tag must match `^v\d+\.\d+\.\d+$`, and the clone must have `foundation.json` with `commit` equal to the tag. `project.json.foundation` becomes `{ repo, tag, commit }`; a later build refuses if the tag now points at a different commit.
10. **Refusals before any spend:** no approved brief; a brief with `modules` (the optional modules arrive in Plan 12); a brief feature with no acceptance example; project status `ready` or `shipped` (changes go through Plan 11's `conductor change`); `TEST_DATABASE_URL` unset while the real `verify` is the test command; a build already running for this project.
11. **Machines, fail closed.**
    - Every value placed in a remote script is validated against a strict pattern and single-quoted (`shQuote`).
    - SSH runs with `BatchMode=yes`. Static hosts need `StrictHostKeyChecking=yes` against the operator's own `known_hosts`; a fresh Proxmox container is trusted on first use into its own `known_hosts` file under `~/.conductor/machines/` (`accept-new`), deleted when the container is destroyed.
    - A static host is locked with an atomic `mkdir` on the host; only the lock's own run may release it.
    - The Proxmox provider never stops or deletes a container unless it is in the configured pool, inside the VMID range **and** tagged `hf-factory`. It checks this immediately before every destructive call. A failed `acquire` destroys what it created before throwing.
    - TLS to Proxmox is always verified (`caFile` or the system store); plain `http://` is accepted only for `127.0.0.1` (the test stub).
    - The token secret comes from an environment variable (default `CONDUCTOR_PROXMOX_TOKEN`), which is scrubbed from every child process and redacted.
12. **Previews run on the operator's network only** (spec §4.2): `HTTP_PORT` is bound to the machine's own LAN address, the origin is `http://<host>:<port>/` (so cookies work without HTTPS), `INSTANCE_MODE=demo`, mail goes to a Mailpit container, and the `ops` service is not started (a preview needs no backups or alerts). Compose still needs `BACKUP_REPOSITORY`, so it is set to the placeholder `/preview-has-no-backups`. One preview per project at a time; a new preview of a different commit replaces the old one.
13. **Commands added beyond Contract 5:** `conductor machines [list|sweep]` (list the factory's machines; tear down leftovers older than 6 hours, sparing live previews). Reported to the roadmap owner as a contract gap.

## Plan 7 seam (what this plan expects from Plan 7)

Checked against Plan 7's draft index (`2026-10-27-factory-brief/00-index.md`, same day):
- `src/factory/projects.js`: `projectDir(root, slug) -> string`, `readProject(root, slug) -> { dir, project }` (plain errors). Plan 7 has no writer for an existing `project.json`, so **Task 1 adds `saveProject(dir, project)`** there (atomic, through `writeJsonAtomic`).
- `src/factory/fsAtomic.js`: `writeJsonAtomic(file, obj, { mode })`.
- `src/factory/brief.js`: `loadBrief(projectDir) -> Brief` and `renderBrief(brief) -> string` (Contract 2).
- `src/plan.js` exports `extractJson` (Plan 7 Task 5).
- A new `project.json` has `foundation: { repo: null, tag: null }`; this plan treats a null `tag` as "not chosen yet" and fills in `{ repo, tag, commit }` at the first build.
- `projectsRoot` follows Plan 7's rule (`CONDUCTOR_PROJECTS_ROOT`, then `factory.projectsRoot`, then `~/highland-projects`). Plan 7 reads the config file itself, so **Task 1 makes `loadConfig` return `factory`** for this plan's settings. `factory.operatorName` is Plan 7's key; `factoryConfig` accepts it and leaves it to Plan 7.

Task 1 Step 1 checks each name. If Plan 7 merged any of them under another name, change only the import lines in this plan's files.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. `npm test` (`node --test`) stays green at every commit.
- **Tests never touch real infrastructure:** no network beyond `127.0.0.1`, no real `ssh`/`scp`/`docker`, no real Proxmox, no real client box, no real model. Remote scripts are tested by running them locally under `bash` with stub `docker`/`curl` on `PATH` and a temporary work root.
- **The foundation is used, never edited.** Conductor never writes to `/root/highland-foundation` (tests use a tiny fake foundation repo made in a temp dir).
- **No client data** reaches a model or the project folder; previews and checks use demo data only.
- **Fail closed** everywhere: only exact `true` approves, only the lock owner releases, only tagged in-range in-pool containers are destroyed, unknown config keys are errors.
- **Plain UK English** for every operator-facing message; no stack traces, no raw JSON. Credentials never appear in prompts, state, events, terminal output or test output.
- **Atomic writes** (temp file, fsync, rename) for `project.json`, `build.json` and `preview.json`.
- Existing assertions change in exactly two places: Task 5 (`MEMBER_LABEL` gains `foundation`) and Task 15 (the two `parseCli` flag `deepEqual`s gain `stop: false, newBuild: false`).

## Review Focus

1. **A crash or Ctrl-C at every seam of a build** (mid-feature, after a feature run landed but before its squash-merge, after the merge but before `build.json` was saved, in the final checks, at the gate): `conductor build <slug>` again finishes the build without repeating a merged feature or merging one twice, and an approval that already moved `main` is not asked again. Pinned in Tasks 7, 8 and 9.
2. **An agent that games the gates**: edits the crossing harness or `foundation.json`, adds `.only`/`.skip` to an acceptance test, drops a tag, or changes `scripts.verify` in `package.json`. The Foundation rules member blocks with a locked finding the interpreter cannot clear. Pinned in Task 5.
3. **A brief too big for the local model** (a feature with 15 examples, a 20 000-character story): the split is refused with a reason the author can act on, and no feature request over 7000 characters ever reaches a run. Pinned in Tasks 3 and 4.
4. **Hostile or odd values reaching a remote shell** (a client called `Acme'; rm -rf /`, a slug with spaces, a run id with `$()`): nothing unquoted reaches `bash`. Pinned in Tasks 10 and 14.
5. **A machine that is busy, unreachable or half-made** (lock held by another preview, SSH refused, Proxmox clone succeeds but start fails, VMID outside the range offered for deletion): plain message, nothing leaked, nothing outside the factory's area touched. Pinned in Tasks 11 and 13.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/factory/config.js` | `factoryConfig(config, { env, home })`: validated factory settings | 1 |
| `src/factory/ids.js` | `newRunId`, `composeProjectOf`, `SLUG_RE`, `RUN_ID_RE` | 1 |
| `src/factory/projects.js` (Plan 7; gains `saveProject`) | project folder helpers | 1 |
| `src/config.js` (modify, if Plan 7 did not) | `loadConfig` returns `factory` | 1 |
| `test/helpers/factoryFixtures.js` | fake foundation repo, sample brief, project folder | 1 (used by 2–9, 14, 15) |
| `src/factory/app.js` | `createApp`, `nameApp` | 2 |
| `src/factory/featureRequest.js` | `featureRequest`, `acceptanceStep`, `BUILDING_ON_RULES`, `REQUEST_BUDGET` | 3 |
| `src/planPhase.js`, `src/prompts.js`, `src/options.js`, `src/conductor.js` (modify) | `firstChunk` option | 3 |
| `src/factory/split.js`, `src/plan.js` (export `extractJson`) | `acceptanceIds`, `briefProblems`, `parseSplit`, `validateSplit`, `runSplit` | 4 |
| `src/council/foundationRules.js` | `FOUNDATION` member, `PROTECTED_PATHS`, `isTestPath` | 5 |
| `src/council/index.js`, `src/council/findings.js`, `src/council/tools.js`, `src/prompts.js`, `src/options.js`, `src/conductor.js` (modify) | member registry, `councilMembers`, `factoryFeature` | 5 |
| `src/factory/checks.js` | `runAppChecks`, `VERIFY_COMMAND`, `browsersInstalled` | 6 |
| `src/factory/buildState.js` | `build.json` store, project lock, `mergeFeature`, `archiveFeatureRun` | 7 |
| `src/factory/build.js` | `runBuild`: setup, split, feature loop | 8 |
| `src/factory/buildFinal.js` | final checks, council hook, operator gate, fix features, `buildSummaryText` | 9 |
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
| `src/cli/args.js`, `src/cli/main.js`, `src/cli/factory.js`, `src/ui/terminal.js`, `src/ui/status.js` (modify/create) | `build`, `preview`, `machines`, resume routing, build gate prompt, progress lines | 15 |
| `README.md`, `config.example.json`, `spikes/factory-build-smoke/` | docs, operator smoke, follow-ups | 16 |

## Tasks

1. [Factory config, ids and the Plan 7 seam](task-01-config-ids.md)
2. [The app from the foundation tag](task-02-app.md)
3. [Feature requests and the fixed first step](task-03-feature-request.md)
4. [Splitting the brief into features](task-04-split.md)
5. [The Foundation rules council member](task-05-foundation-rules.md)
6. [Whole-app checks](task-06-checks.md)
7. [Build state, lock and squash-merge](task-07-build-state.md)
8. [The build loop](task-08-build-loop.md)
9. [Final checks, council hook and the operator's gate](task-09-build-final.md)
10. [Remote scripts and SSH](task-10-remote-ssh.md)
11. [The static machine provider](task-11-static.md)
12. [Proxmox API client and stub](task-12-pve-api.md)
13. [The Proxmox machine provider](task-13-proxmox.md)
14. [Demo deploy and previews](task-14-preview.md)
15. [Commands: build, preview, machines](task-15-cli.md)
16. [Docs, operator smoke and follow-ups](task-16-docs-smoke.md)

Order: 2–6 need 1; 4 also needs 3; 7 needs 1; 8 needs 2–7; 9 needs 8; 10 needs 1; 11 needs 10; 12 needs 1; 13 needs 10–12; 14 needs 10 and 11; 15 needs 9 and 14; 16 needs all. Tasks 10–13 can run alongside 2–9.

## Shared Interfaces (all tasks)

```js
// Task 1 — src/factory/ids.js
SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/
RUN_ID_RE = /^\d{8}-\d{6}-[0-9a-f]{4}$/
newRunId(now = new Date(), rand = () => randomBytes(2).toString('hex')) -> '20261027-143005-a1b2'   // UTC
composeProjectOf(slug, runId) -> `hf-${slug}-${runId}`                                              // throws on a bad slug/runId
COMPOSE_PROJECT_RE = /^hf-[a-z0-9-]+-\d{8}-\d{6}-[0-9a-f]{4}$/

// Task 1 — src/factory/config.js
factoryConfig(config, { env = process.env, home = homedir() } = {}) -> FactoryConfig   // throws plain English
FactoryConfig = {
  projectsRoot,                                        // absolute
  foundation: { repo, tag },                           // default { repo: '/root/highland-foundation', tag: 'v0.1.0' }
  build: { testCommand: string|null, browserGate: boolean, fixRounds: number },   // null → VERIFY_COMMAND; defaults true, 2
  machines: { provider: 'static'|'proxmox', sshBin, scpBin, sweepAfterMs,          // defaults 'static','ssh','scp', 6 h
    static: { hosts: [{ id, name, host, user, keyPath, previewPort, workRoot }] },
    proxmox: null | { apiUrl, node, tokenId, tokenEnv, caFile, pool, template, vmidRange: [lo, hi], maxContainers,
                      maxMemoryMb, cores, memoryMb, fullClone, user, keyPath, previewPort, workRoot } } }

// Plan 7 seam (Task 1 checks) — src/factory/projects.js, src/factory/fsAtomic.js, src/factory/brief.js
projectDir(root, slug) -> string; readProject(root, slug) -> { dir, project }; saveProject(dir, project) /* added by Task 1 */; writeJsonAtomic(file, obj)
loadBrief(projectDir) -> Brief; renderBrief(brief) -> string

// Task 2 — src/factory/app.js
createApp({ projectDir, foundation: { repo, tag }, expectCommit = null, git = gitFn }) -> Promise<{ appDir, commit, created: boolean }>
initialsOf(client) -> string
nameApp({ appDir, client, git = gitFn }) -> Promise<string|null>          // commit sha, or null when already named
FOUNDATION_REMOTE = 'foundation'

// Task 4 — src/factory/split.js
acceptanceIds(brief) -> [{ id: 'submit-expense#1', featureId, n, example }]
parseSplit(text) -> { ok: true, units } | { ok: false, error }
validateSplit(units, brief) -> { ok: true, units } | { ok: false, problems: string[] }
briefProblems(brief) -> string[]
runSplit(sctx, brief) -> Promise<{ status: 'ok', units, note } | { status: 'failed'|'paused'|'stopped', reason }>
Unit = { id, title, covers: string[], acceptance: string[], instructions, dependsOn: string[], kind: 'feature'|'fix' }
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
runAppChecks({ appDir, sha, workDir, reportsDir, testCommand, browser, env, run = runCommand }) -> Promise<AppChecks>
AppChecks = { verify: Check, browser: Check, reports: string[] }
Check = { status: 'passed'|'failed'|'missing'|'skipped', summary: string, output: string }

// Task 7 — src/factory/buildState.js
buildDirOf(projectDir, runId); loadBuild(buildDir) -> Build|null; saveBuild(buildDir, build); latestBuild(projectDir) -> Build|null
lockProject(projectDir, kind = 'build') -> release()          // throws BUSY plain English
mergeFeature({ appDir, buildBranch, landedBranch, landedSha, expectedBase, message, git }) -> Promise<sha>   // idempotent, see task
newBuild({ runId, slug, client, briefHash, foundation, now }) -> Build; hashBrief(brief); appendBuildLog(buildDir, type, data); readRunState(workspaceDir)
archiveFeatureRun({ workspaceDir, buildDir, index, id }) -> string|null   // transcript copy path; removes the workspace
Build = { schema: 1, runId, slug, client, startedAt, briefHash, foundation, branch, baseSha,
          phase: 'setup'|'split'|'features'|'final'|'gate'|'done', status: 'running'|'paused'|'failed'|'stopped'|'ready'|'rejected',
          units: Unit[], features: FeatureRecord[], fixRounds: 0, usage: { costUsd, apiCostUsd, apiCalls },
          checks: AppChecks|null, council: object|null, notes: string[], warnings: string[], reason: string|null }
FeatureRecord = { id, title, status: 'pending'|'running'|'landed'|'merged'|'stopped'|'failed'|'paused',
                  attempts, workspaceDir, branch, landedSha, baseSha, mergedSha, transcript, notes: string[], councilText, gateReason }

// Task 8 — src/factory/build.js
runBuild({ factory, slug, team, hooks, options = {}, baseDir, warnings = [], env = process.env, deps = {} }) -> Promise<BuildOutcome>
BuildOutcome = { status: 'ready'|'rejected'|'stopped'|'failed'|'paused', runId, buildDir, reason?, note? }
hooks = { escalate, approveBuild, onEvent?, confirmLocalFallback?, approvePlan?, council?, onProgress? }
deps = { runTask, resume, runAppChecks, loadBrief, renderBrief, mergeFeature, runFinal, now }
events (hooks.onEvent and builds/<runId>/build-log.jsonl):
  'build-start' { runId, slug, resumed }        'build-split' { units: [{ id, title }] }
  'build-feature' { index, total, id, title, attempt }   'build-feature-done' { index, id, status, sha }
  'build-checks' { verify, browser }   'build-council' { status }   'build-finish' { status, reason }

// Task 9 — src/factory/buildFinal.js
runFinal(bctx) -> Promise<{ next: 'features' } | BuildOutcome>
buildSummaryText({ build, project, checks, councilText, slug }) -> string; fixUnit({ build, title, instructions, prefix }) -> Unit; NO_COUNCIL_YET
hooks.council (Plan 9) -> ({ projectDir, appDir, sha, brief, policy: brief.policy, runId, slug, team, factory, onEvent })
  -> Promise<{ status: 'approved'|'approved-with-warnings'|'blocked'|'paused', text: string, fix?: { title, instructions }, reason?: string }>
hooks.approveBuild({ summary }) -> true | false | { approved: false, note }

// Task 10 — src/factory/remote.js, src/factory/ssh.js
shQuote(s) -> string; assertSafe(kind, value) -> value   // kinds: slug, runId, project, path, host, user, port, client, purpose
lockScript({ root, owner }) / unlockScript({ root, runId }) / readLockScript({ root })
teardownScript({ root, project, images }) / sweepScript({ root, olderThanSec, keepRuns })
createSsh({ sshBin = 'ssh', scpBin = 'scp', run = runCommand }) -> { exec(machine, script, { timeoutMs }), upload(machine, localFile, remotePath, { timeoutMs }) }
  // exec resolves { code, stdout, stderr }; ssh failure (255) -> code 255 and stderr; throws only on an unsafe host/user/path
parseMarker(stdout) -> { marker, rest }; ownerJson(labels) -> string; unreachable(r) -> boolean

// Task 11 — src/factory/machines/{index,static}.js
getMachineProvider(factory, { ssh, pve, now, env } = {}) -> Provider
runImages(slug, runId) -> ['hf-preview/<slug>-app:<runId>', 'hf-preview/<slug>-ops:<runId>']; whenText(iso) -> '14:30 27 Oct'
Provider = { kind, acquire({ purpose, projectSlug, runId }) -> Machine, list() -> Machine[], sweep({ olderThanMs, keep = [] }) -> number }
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
<project>/preview.json = { schema: 1, runId, machineId, provider, host, url, sha, from: 'main'|'build', startedAt }
```

## Notes for the plans that build on this one

- **Plan 9 (full council)** fills `hooks.council` with the contract above. It gets the build branch's tip `sha`, the app folder, the brief and its policy, and the build's `team`. A `blocked` result with a `fix` becomes a fix feature (capped by `factory.build.fixRounds`, shared with red whole-app checks). The whole-app check evidence is already in `builds/<runId>/reports/` (`crossing.md`, `crossing.json`, `screenshots/`). For its deploy tests it should call `getMachineProvider(factory).acquire({ purpose: 'council', … })` and `bringUpDemo` (Task 14), then `machine.release()` in a `finally`. With the `static` provider and one host, a running preview makes the machine busy (`MachineError` code `busy`); Plan 9 must report that plainly rather than fail the build.
- **Plan 10 (ship)** ships the app's `main` branch, which moves only on the operator's approval; `project.json.status` is then `ready`.
- **Plan 11 (changes)** must lift the `ready`/`shipped` refusal in `runBuild`, and note that acceptance tags are positional (`<feature>#<n>`): a revised brief that reorders examples changes their tags.
- **Plan 12 (modules)** must lift the `modules` refusal in `briefProblems`.
- `PROTECTED_PATHS` (Task 5) and `demoUpScript` (Task 14) follow the foundation v0.1.0 layout; a foundation release that moves those files needs them updated.

## Operator follow-ups

Listed in full in [Task 16](task-16-docs-smoke.md): CT 111 SSH key, host key and `/srv/hf-factory`; a PostgreSQL role and `TEST_DATABASE_URL`; the `factory` config block; and for the `proxmox` provider the `hf-factory` pool, a VMID range, a Docker-ready unprivileged LXC template with nesting in the pool, a scoped role, user and privilege-separated token (secret in `CONDUCTOR_PROXMOX_TOKEN`), and the Proxmox CA file.
