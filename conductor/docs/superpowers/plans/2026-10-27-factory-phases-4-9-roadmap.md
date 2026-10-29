# Factory phases 4–9 — roadmap and cross-plan contracts

- **Date:** 2026-10-27
- **Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md` (approved 2026-10-25), §4–§8.
- **Built so far:**
  - Plan 4 (wake workers, phase 1) and Plan 5 (council v1, phase 2) are merged in `/root/conductor`.
  - Plan 6 (foundation, phase 3) is merged in `/root/highland-foundation` and tagged `v0.1.0`. Its docs are `docs/RUNBOOK.md` and `docs/BUILDING-ON.md`.
  - Earlier decisions: `docs/superpowers/plans/2026-10-25-highland-foundation/DECISIONS.md`.

This roadmap splits spec §8 items 4–9 into six plans. It fixes the **contracts between them** so they can be written in parallel and built in order. Each plan is its own folder in the Plan 3–6 format (`00-index.md` plus `task-NN-*.md`). **[call]** marks a decision made here, which the operator can overrule.

## Plans and order

| Plan | Spec phase | Folder | Depends on |
|---|---|---|---|
| 7 | 4 Brief intake | `2026-10-27-factory-brief` | — |
| 8 | 5 Building from nothing (+ previews, + machines) | `2026-10-27-factory-build` | 7 |
| 9 | 6 Full council | `2026-10-27-factory-council-full` | 8 (machines, project layout) |
| 10 | 7 Ship and run | `2026-10-27-factory-ship-run` | 8, 9 |
| 11 | 8 Change requests on live apps | `2026-10-27-factory-changes` | 7–10 |
| 12 | 9 Acceptance: optional modules + the expenses tracker | `2026-10-27-factory-acceptance` | 7–11 |

Each plan must deliver something usable on its own. For example, Plan 7 alone produces approved briefs, and Plan 8 alone builds and previews an app from a brief.

## Contract 1 — the client project folder [call]

Every client app is a **project**: one folder under `projectsRoot` (config `factory.projectsRoot`, default `~/highland-projects`), named by a slug of the client name.

```
<projectsRoot>/<slug>/
  project.json          # { schema: 1, slug, client, createdAt, foundation: { repo, tag }, status }
  brief/                # Contract 2; versioned: brief-v1.json, brief-v1.md, brief-v2.json …; current.json → latest approved
  notes/                # the operator's raw meeting notes, kept verbatim (input only; never shown to models beyond the brief step)
  app/                  # the client app's own git repo (Plan 8 creates it from the foundation tag)
  builds/               # one folder per build or change run: <runId>/ (Conductor's run log, council reports, summary)
  deployments/          # Contract 4, one JSON per deployment target
```

- `project.json.status` takes these values: `briefing` | `building` | `ready` | `shipped`.
- Writes are atomic: write a temp file, fsync, rename. This is the same rule the foundation uses.
- **No client data** (spec §7) ever goes into this folder or to any model. The factory works on code and demo data only.

## Contract 2 — the brief (Plan 7 produces; Plans 8, 9, 11, 12 consume)

The brief is a JSON document plus a rendered Markdown copy, which is what the operator reads and approves. It carries `schema: 1`. Plan 7 owns the exact validator and exports it as `src/factory/brief.js`:

```js
loadBrief(projectDir) -> Brief          // current approved version; throws plain-English if none approved
validateBrief(obj) -> { ok, problems: string[] }
renderBrief(brief) -> string            // Markdown, plain UK English
```

Brief fields (minimum; Plan 7 may add more):
- **Identity:** `client`, `purpose` (one paragraph), `kind: 'web-app'` (the only kind supported; others are refused, per spec §9).
- **Roles:** each with `name`, `whatTheyDo`, `mapsTo: 'admin'|'manager'|'member'`. The foundation's roles are fixed; client roles map onto them (foundation Ruling 3).
- **Features:** an ordered list. Each has an `id` (kebab-case), `title`, `story` (plain English), `roles` (who uses it), `data` (the records it reads or writes) and `acceptance` (an array of worked examples).
- **Acceptance examples:** each is `{ given, when, then }` in plain English and must be concrete, e.g. "a £12.40 receipt with £2.07 VAT appears in March's report under Travel". Plan 8 turns these into tests before any feature code is written.
- **Outputs:** reports, exports and emails, with their formats.
- **Integrations:** outside systems. Default empty.
- **modules:** the optional foundation modules needed (`ocr`, `pdf-export`, `xlsx-export`, `scheduled-jobs`). Plan 12 builds the modules.
- **policy:** the data policy profile (spec §6):
  - `hosting: 'client-box'|'operator-server'`;
  - `outbound: string[]` (allowed outside services, default `[]`);
  - `residency: 'uk'|'uk-eu'|'any'`;
  - `retention` (plain text plus `days` where known);
  - `backupDestination` (the kind, never credentials);
  - `operatorAccess: true` (required; spec §4.6).
- **openQuestions:** must be empty for approval.
- **approvedAt / approvedBy:** set only by the operator's approval.

## Contract 3 — machines for previews and council deploy tests (Plan 8 produces; Plans 9, 10 consume) [call]

`src/factory/machines/` provides `getMachineProvider(config)`:

```js
provider.acquire({ purpose: 'preview'|'council'|'smoke', projectSlug, runId }) -> Machine
//   Machine = { id, host, ssh: { user, keyPath }, labels, release(): Promise<void> }
provider.list() -> Machine[]; provider.sweep({ olderThanMs }) -> number
```

There are two providers, chosen by config `factory.machines.provider`.

**`static`** (the default, usable now):
- a fixed list of hosts the operator already runs, e.g. CT 111 `hf-build` at 192.168.1.111;
- `acquire` takes a host-level lock file on that machine, so only one use runs at a time;
- `release` runs `docker compose down -v` for that run's project name and removes the run's folder.

**`proxmox`** (spec §4.7, operator-approved):
- creates and destroys LXC containers from a Docker-ready template, inside one dedicated pool;
- only within a VMID range, under a resource cap, using an API token whose rights cover only that pool;
- every container is tagged with the project slug and run id;
- crashes are swept by tag.
- Plan 8 builds this provider against a stubbed API. Using it live needs operator follow-ups (create the pool, the token and the template), listed in Plan 8.

All Docker work on a machine goes through SSH from Conductor (no Docker socket locally). A run always uses its own Compose project name: `hf-<slug>-<runId>`.

## Contract 4 — deployments (Plan 10 produces; Plan 11 consumes)

`deployments/<name>.json`:
```json
{ "schema": 1, "name": "acme-office", "host": "…", "ssh": { "user": "…" }, "bundleDir": "/opt/highland/acme",
  "hosting": "client-box", "imageDelivery": "tar"|"registry", "registry": null,
  "currentVersion": "0.1.3", "foundation": "v0.1.0", "history": [ { "at": "…", "version": "…", "outcome": "updated|rolled-back|…" } ] }
```

- Secrets are **never** stored here. They live only in the box's own `.env`, made with `ops init --out`, and `BACKUP_PASSWORD` goes to the operator's password manager (foundation runbook).
- Shipping and updating always go through the foundation's own tools on the box: `ops init`, `docker compose up`, `ops update` and the rest (see `/root/highland-foundation/docs/RUNBOOK.md`). Conductor never re-implements them.

## Contract 5 — commands [call]

All commands live under the existing `conductor` CLI. Plain UK English. Every one of them fails closed without a terminal where a question is needed, as in Plan 3.

| Command | Plan |
|---|---|
| `conductor project new "<client>"` / `conductor project list` / `conductor project show <slug>` | 7 |
| `conductor brief <slug> --notes <file>` (draft → questions → approve) / `conductor brief <slug> --revise --notes <file>` | 7 |
| `conductor build <slug>` (all features from the approved brief → council → operator gate) / `conductor resume` works for builds | 8 (council hook from 9) |
| `conductor preview <slug> [--stop]` | 8 |
| `conductor ship <slug> --to <deployment>` / `conductor deployments [status]` | 10 |
| `conductor change <slug> --notes <file>` (change brief → build on the existing app → full council → gate → ship as update) | 11 |
| `conductor foundation-upgrade <slug> --to <tag>` | 11 |

## Contract 6 — council members for client apps (Plan 9)

Plan 9 adds the `design` and `reliability` members and extends `correctness` and `legal`, using the Plan 5 member contract (`{ member, label, alwaysInterpret, collect(input) }`, a deterministic tool plus an interpreter, grading, ceilings and locks).

- When the council runs on a **project** build, it gets `input.brief` and `input.policy`.
- When it runs on an ordinary repo, those are null, and the members cut down exactly as in Plan 5 Ruling 1/§8 item 2.

The full council always reviews the **whole app**, not just the diff (spec §4.3, §4.8).

## Contract 7 — library seams (added 2026-10-27 after the six drafts) [call]

The six plans were written in parallel against Contracts 1–6 and each reported gaps. This contract settles them. **Where a draft disagrees with this section, this section wins**, and each plan's reviser aligns its plan to it. A name listed here is built **once**, by the plan named as owner. Later plans import it and never redefine it.

### 7.1 Shared modules and their owners

| Module | Owner | Exports (exact names) | Replaces in drafts |
|---|---|---|---|
| `src/factory/fsAtomic.js` | 7 | `writeFileAtomic`, `writeJsonAtomic`, `createFileExclusive` | Plan 11's own `writeJsonAtomic` |
| `src/factory/config.js` | 7 creates, 8/10 extend | `factoryConfig(config, { env, home }) -> FactoryConfig`. `loadConfig` keeps `factory` (Plan 7 makes the change) | Plan 7's `settings.js`/`factorySettings`, Plan 10's `shipSettings` reading raw config |
| `src/factory/projects.js` | 7 | `slugify`, `validateSlug`, `projectDir(root, slug)`, `createProject`, `readProject(root, slug)`, `loadProject(dir)`, `saveProject(dir, project)`, `listProjects`, `PROJECT_STATUSES` | Plan 8's added `saveProject`, Plan 9's `project.js`/`loadProject`, Plan 11's `projectDirFor` |
| `src/factory/projectLock.js` | 7 | `lockProject(projectDir, kind) -> release()` (kinds `'brief'\|'build'\|'change'`). Throws a plain "busy: a <kind> is running (pid …, since …)" error. Stale-pid recovery as in Plan 7's brief lock | Plan 7's `acquireBriefLock`, Plan 8's `lockProject` in `buildState.js`, Plan 11's `acquireProjectLock` |
| `src/factory/ids.js` | 8 | `newRunId`, `RUN_ID_RE`, `SLUG_RE`, `composeProjectOf`, `COMPOSE_PROJECT_RE` | Plan 11's `newRunId(kind, …)`. The run kind lives in the run record, not the id |
| `src/factory/acceptance.js` | 7 | `exampleProblems`, `EXAMPLE_RULES_TEXT`, **`acceptanceIds(brief)`** (moved here from Plan 8's `split.js`), `testTag(id) -> '[<id>]'` | Plan 9's own `acceptanceIds` |
| `src/factory/outbound.js` | 7 | `OUTBOUND_SERVICES` (see 7.4), `outboundProblems(ids)` | free-text matching in Plans 9 and 10 |
| `src/factory/foundationLog.js` | 10 | `parseVersion`, `compareVersions`, `parseChangelog`, `securityFixesSince` | Plan 10's `ship/securityFixes.js`. **Plan 11** extends it with `changesBetween`, `releaseTags` and `readChangelogAt` |
| `src/factory/ssh.js`, `remote.js` | 8 | `createSsh`, `shQuote`, `assertSafe`, … | Plan 10's `ship/remote.js` stays for client boxes, but imports `shQuote`/`assertSafe` from `remote.js` instead of its own `shq` |
| `src/cli/factory.js` | 7 | `runFactoryCommand(cli, ctx)` and a `FACTORY_COMMANDS` table `{ [command]: handler }` | per-plan edits of `main.js` |

### 7.2 Config

`factoryConfig` returns one object. Each plan adds only its own section, with defaults, and throws plain English on bad values:

```js
FactoryConfig = {
  projectsRoot, operatorName,                                   // Plan 7 (CONDUCTOR_PROJECTS_ROOT > factory.projectsRoot > ~/highland-projects)
  foundation: { repo, tag },                                    // Plan 8; default { repo: '/root/highland-foundation', tag: 'v0.1.0' }.
                                                                //   Plan 12 sets tag 'v0.2.0' for the acceptance run. Plan 10 reads repo here (no foundationDir).
  build: { testCommand, browserGate, fixRounds, councilFixRounds },   // Plan 8; fixRounds 2 (red checks), councilFixRounds 3 (spec §4.3)
  machines: { … },                                              // Plan 8, as drafted
  alerts: { matrix: null | { homeserver, roomId } },            // Plan 10
  ship: { updateTimeoutMs, pollMs, startTimeoutMs, buildTimeoutMs }   // Plan 10
}
```

### 7.3 CLI dispatch

- Plan 7 changes `main()` so that `runFactoryCommand` runs **before** the "must be inside a git repo" check, for any command found in `FACTORY_COMMANDS`.
- Plans 8, 10 and 11 add their parser cases to `args.js` and their handlers to `FACTORY_COMMANDS`. They do not touch `main.js` again.
- Every factory command fails closed without a terminal wherever it would ask a question.

### 7.4 Brief additions (Plan 7 builds these; Plans 8–12 rely on them)

- **Example ids.**
  - Every acceptance example carries `id: '<featureId>#<n>'`. Plan 7 assigns them at approval.
  - On a revised brief, an unchanged example keeps its id, and a new example takes the next unused `n` for that feature. An `n` is never reused.
  - Tests prove an example by putting `[<featureId>#<n>]` in the test's title. Plan 8's tag format is kept and Plan 12's `[ex:…]` is dropped.
- **`policy.outbound`** is `string[]` of **ids** from `OUTBOUND_SERVICES = { [id]: { label, hosts: string[], carries } }`.
  - Plan 7 seeds `cloudflare-tunnel` (hosts `*.cloudflare.com`, `*.argotunnel.com`; carries the app's web traffic) and `azure-document-intelligence` (hosts `*.cognitiveservices.azure.com`; carries receipt images).
  - A plan that needs a new service adds its id there. Plan 7's validator rejects unknown ids.
  - Plans 9 and 10 match on ids and hosts, never on free text.
- **Shapes:** `policy.retention = { text, days: number|null }` and `policy.backupDestination = { kind, detail }`. `detail` is never a credential.

### 7.5 Project file (Contract 1, extended)

```js
project.json = { schema: 1, slug, client, createdAt, status,
  foundation: { repo, tag, commit } | { repo: null, tag: null },   // Plan 8 fills at the first build; tag is always 'vX.Y.Z'
  approved: null | { sha, at, runId, briefVersion },                // written at the operator's gate (Plan 8 first build, Plan 11 changes)
  builtFromBrief: number | null }                                   // brief version on main; Plan 8 sets it at the gate, Plan 11 at merge
```

- **Status values** stay `briefing | building | ready | shipped`:
  - `ready`: `main` holds an approved build.
  - `shipped`: at least one deployment has been installed.
  - Plan 7 does not add a "brief approved" status; `currentBriefInfo` reports it.
- **Other files** in the project folder:
  - `preview.json` (Plan 8);
  - `builds/<runId>/build.json` (Plan 8);
  - `builds/<runId>/change.json` (Plan 11; same run-id format);
  - `builds/<runId>/council-report.{md,json}` (Plan 9; Plan 5's `CouncilReport` shape plus Plan 9's additions). Plans 11 and 12 read the council result from here.
- **`app-profile.json`** sits at the app repo root: `{ schema: 1, modules, policy: { outbound, residency } }`, Plan 12's `AppProfileSchema`.
  - Plan 8's `createApp` writes it from the approved brief at the first build, and commits it with the BRAND line.
  - Plan 11 rewrites it when a change brief alters `modules` or `policy`.

### 7.6 Approval and release ownership

- **At the gate:**
  - The build gate (Plan 8) or change gate (Plan 11) records `project.json.approved` and moves `main` by compare-and-swap.
  - Neither one cuts a release.
- **Releases** are cut by Plan 10's `releaseApp({ projectDir, bump, runId }) -> { ok: true, version, sha, tag } | { ok: false, reason }` (`src/factory/ship/release.js`).
  - It runs the app's own `npm run release -- <bump>` on `main`, using a scratch clone, then moves `main` by compare-and-swap and tags `v<version>`.
  - Bumps:
    - `first` when the app has no tag;
    - `minor` for a change (Plan 11);
    - `patch` for a foundation upgrade (Plan 11).
  - `conductor ship` calls `releaseApp` when `approved.sha` has no release tag on or after it.
  - Plan 10's `approvedRelease` becomes "find or cut the release".
- **Updates** go through Plan 10's `updateDeployment({ projectDir, name, version, foundation, runId }) -> { outcome, message }`. It wraps `runLaterShip` for an existing deployment and is the only way Plan 11 touches a box.

### 7.7 Build and council seams

- **Builds.** Plan 8's `runBuild({ factory, slug, team, hooks, options })` is the single build entry point.
  - Plan 11 adds `options.change = { runId, baseRef, units }`, which skips app creation and the split.
  - Plan 11 lifts the `ready`/`shipped` refusal only for `options.change`.
  - Plan 11 maps its draft seams onto this: `buildFeatures`/`resumeBuild` become `runBuild`/`resume`, and `projectCouncilOptions` becomes `hooks.council = runProjectCouncil`.
- **The council hook is the Contract 6 entry point:**
  ```js
  hooks.council({ projectDir, appDir, sha, brief, policy, runId, slug, team, factory, onEvent, checks })
    -> { status: 'approved'|'approved-with-warnings'|'blocked'|'paused', text, fix?: { title, instructions }, reason?, secretSeen?: boolean }
  ```
  - **`checks`** is Plan 8's `AppChecks` for the same `sha`. Plan 8's `runAppChecks` adds the vitest and Playwright JSON reporters and lists their paths in `checks.reports`. Plan 9 reuses them for that `sha`, and runs its own gates only for the axe pass or when they are missing.
  - **`secretSeen: true`** makes Plan 8 squash the whole `build/<runId>` branch to one commit before the gate (Plan 5 Ruling 10).
  - **Council fix rounds** are capped by `factory.build.councilFixRounds` (3). Red whole-app checks keep their own `fixRounds` (2).
- **Legal** treats the app's own `licence-exceptions.json` entries as accepted licences, with their reasons shown.
- **Security** gets the role-crossing harness results as its tool evidence, and Correctness no longer reports them.

### 7.8 Machines (Contract 3, updated)

- **`Machine`** is Plan 8's shape: `{ id, host, ssh: { user, keyPath, knownHostsFile, hostKeyPolicy }, labels, provider, runDir, composeProject, previewPort, release() }`. Proxmox machines also carry `vmid`.
- **Purposes:** `'preview'|'council'|'smoke'|'ship'`. Plan 10 builds release images under `'ship'`.
- **Sweeps:** `sweep({ olderThanMs, keep })`, where `keep` is the live preview run ids.
- **Image clean-up:**
  - Plan 10's `cleanupBuild` must remove the `highland/app` and `highland/ops` images it built from the build machine. Otherwise the foundation smoke refuses to run there.
  - Previews already use `hf-preview/*` names and remove them.
- **Commands:** `conductor machines [list|sweep]` (Plan 8) joins Contract 5.

### 7.9 Foundation follow-ups (built in Plan 12 milestone 1, foundation v0.2.0)

The factory never edits the foundation repo during a client build. Foundation releases are ordinary foundation work, and Plan 12 milestone 1 is that work. It adds the following alongside the modules:

1. **`scripts/release.ts` fix:** it stamps `foundation.json` only when `package.json.name` is `highland-foundation`.
2. **`updater update --json`:** a single-line JSON outcome.
3. **`ops status --json`.**
4. **`ops set-env`:** reads `KEY=value` lines from stdin, accepts only the known keys, and writes the file atomically.
5. **`ops test-alert`.**
6. **Smoke settings and a hard-kill step:** the smoke reads `HF_SMOKE_PROJECT`/`HF_SMOKE_DIR` and gains a hard-kill step.

Plans 9 and 10 stay as drafted against v0.1.0, with text parsers pinned by fixtures. Switching them to the machine-readable routes is a follow-up once apps are on v0.2.0.

### 7.10 Deferred, with reasons

- **Efficiency council member** (spec §4.3, advisory): not in Plans 7–12. It never blocks, and the spec's acceptance (§8 item 9) doesn't need it. It is a follow-up after Plan 12.
- **Remote client previews, deployment subsets, automatic patching:** out of scope, as Plan 11 rules.

### 7.11 Amendments after the revisions (2026-10-27)

- **Locks.**
  - `lockProject(projectDir, kind)`: the kinds `brief`, `build` and `change` share one project lock. `preview` uses its own lock file, so a preview can run while a build is running.
  - **The CLI handler takes the project lock.** Library entry points (`runBriefSession`, `runBuild`, `runChange`, `runFoundationUpgrade`) never take it. They run under the lock their caller holds.
- **CLI.**
  - Plan 8 Task 15 edits `main.js` once more. It moves the inline team set-up (worker checks, waking, the local-down question) unchanged into `src/cli/prepareRun.js`, exporting `prepareTeam(...)`.
  - Plans 8 and 11 call `prepareTeam`.
  - A `FACTORY_COMMANDS` handler `(cli, ctx)` may return `null` to mean "not mine". `conductor resume` then falls through to the ordinary run.
- **`app-profile.json`.** Plan 8 writes it in `nameApp`, in the same commit as the BRAND line.
- **Approval record.** `project.json.approved` is written straight after `main` moves by compare-and-swap, so its `sha` is the commit actually on `main`.
- **Gates.** A gate that refuses returns `false`. A gate returns `{ note }` only when the operator asks for changes, because Plan 8 turns a note into a fix unit.
  The build's gate (`hooks.approveBuild`) may also return `{ stop: true }` when the operator stopped without deciding (end of input). Plan 8 then ends the build as `stopped`, not `rejected`, so `conductor build <slug>` asks again. A gate that wraps `approveBuild` passes it on unchanged.
- **Handler signature.** `handler(cli, ctx) -> Promise<number|null>`. The fields of `ctx`:
  - `{ cwd, env, stdin, stdout, isTTY, onSignal, exit }`;
  - `factory`, the result of `factoryConfig`;
  - `config`, the full loaded config, or `null` when it has no participants;
  - `deps`, for tests.
  A handler that needs participants calls `loadConfig` itself, and fails in plain English if they are missing.
- **First release.** `releaseApp` with bump `first` runs `npm run release -- major` and gives `1.0.0`. The foundation refuses `release -- first` in a clone made at a release tag.
- **Tags in the app repo.** Foundation tags are never kept as `refs/tags/*` in an app repo.
  - Plan 8's `createApp` deletes the tags it inherits from the clone, and sets the `foundation` remote to `--no-tags`.
  - Plan 11 fetches the tag it needs as `refs/foundation/vX.Y.Z`.
  - So every `v*` tag in an app repo is an app release.
  - `project.json.foundation.tag` is the only record of the foundation version. Plan 10 records each deployment's `foundation` from it, never from the box's `/api/version`, which is wrong on apps released under v0.1.0.
- **Update outcomes.** Plan 10's `OUTCOMES` are the only names. Plan 11 uses `updated`, `already-on`, `cancelled`, `rolled-back`, `urgent`, `lost-contact` and `refused`, and drops `already` and `unreachable`. On Ctrl-C, Plan 11 calls Plan 10's `interruptShip`.
- **Safe values.** Plan 8's `assertSafe('purpose', …)` accepts `'ship'`.
- **Security report.** It reads each deployment's recorded `foundation` through `listDeployments`. It never probes boxes over ssh.

## Cross-cutting rules (all plans)

- **Conductor stays as it is:** Node ESM, zero dependencies, `npm test`.
  - Optional external tools (Playwright, axe, ssh, docker on remote machines) are detected at run time with plain "not installed" notes, as in Plan 5's tools.
  - Tests never touch the network beyond 127.0.0.1, never use real Proxmox, real client boxes or real models, and never run a real Docker daemon (stub `ssh` and `docker`).
- **Frontier spend:** briefs and planning use the author seat; review and the interpreter use the reviewer seat. Paid API stays opt-in. Subscription fallback for local work still asks (Plan 4).
- **The foundation is used, not copied:**
  - client apps are created from a foundation **tag**, which is recorded in `project.json`;
  - the factory never edits the foundation repo;
  - foundation fixes reach apps only through `foundation-upgrade` (Plan 11).
- **Every client-app build must keep the foundation's gates green:** `npm run verify` (lint, typecheck, licences, tests including the role-crossing harness) and the browser gate. The factory treats a red gate as a blocking council finding.
- **Plain UK English** for every operator-facing message. No stack traces.

## Operator follow-ups to expect (each plan lists its own)

- Proxmox: a pool, a scoped API token and a Docker-ready LXC template, for the `proxmox` provider (Plan 8). Until then, `static` uses CT 111.
- Matrix bot account and alerts room, plus an outside heartbeat watcher (Uptime Kuma), for deployments (Plan 10).
- A real target box or rented server for the first ship (Plan 10).
- Real meeting notes for the expenses tracker (Plan 12).
