# Conductor Plan 10 — Ship and run (factory phase 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** `conductor ship <slug> --to <deployment>` takes an approved client app from its project folder to a running, backed-up, monitored box, and later ships move it on through the foundation's own safe update. `conductor deployments [status]` tells the operator, in plain English, what every box is running, whether it is healthy, whether its backups and restore tests are working, and whether it is missing foundation security fixes.

**Architecture:**
- **Conductor orchestrates; the box does the work.** Every step on a box is one of the foundation's own tools, run over SSH: `ops init --out`, `docker load`, `docker compose up -d`, `ops backup`, `ops restore-test`, `ops check`, and `updater update --to` (safe update with automatic rollback). Conductor never re-implements them (Contract 4). The few things the foundation has no command for (writing the operator's answers into `.env`, reading the last backup times) are small, read-only or append-only shell snippets, listed under "Contract gaps".
- **Build on a factory machine, deliver to the box.** Images and the bundle are built from the project's app repo at the approved release tag on a Contract 3 machine (`npm ci`, `npm run images`, `npm run bundle`), then streamed box-ward through Conductor (SSH to SSH, checked with SHA-256) as a `docker save` file, or pushed to the operator's registry. No Docker daemon or socket is used locally.
- **First ship vs later ships.** A deployment record (Contract 4) carries `setup.step`. Until it is `done`, `ship` runs the resumable first-time setup (deliver → `ops init` → show `BACKUP_PASSWORD` once → write the operator's answers → start → backup + restore test + checks → record). Once `done`, `ship` runs `updater update --to <version>` **detached on the box** (so a dropped SSH session or Ctrl-C can never kill an update half-way), polls it, and maps its exit code and message to a plain-English outcome recorded in `history`.
- **Secrets never touch Conductor's disk.** `DB_PASSWORD`, `HEALTH_TOKEN` and `BACKUP_PASSWORD` are generated on the box by `ops init`. Everything the operator types (mail password, Matrix token, tunnel token, backup credentials, heartbeat address) is held in memory, registered for redaction, and sent to the box **on SSH standard input**, never in argv. The health token is used **on the box** (a short probe runs inside the ops container, which already has it), so it never leaves the box at all.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`. External tools detected at run time and never installed by Conductor: `ssh` (OpenSSH client) and `git` locally; `docker` with the Compose plugin, `setsid`, `sha256sum`, `tar`, `awk` on the box; `docker`, `node`/`npm`, `git` on the build machine.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §4.5 Ship: a Compose bundle on any ordinary Linux machine; hosting per the data policy; "copy the bundle, start it, verify health"; the operator gives only address, access and secrets, asked in plain English;
- §4.6 Run: operator remote access (outbound tunnel by default), alerts to the operator (Matrix by default), scheduled backups and tested restores, backup destination per policy, security updates surfaced and shipped through the safe-update path;
- §6 data policy profile; §2 item 4 (backups with a tested restore, health monitoring, safe updates: "an app without these is not finished").

**Binding contracts:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md`. This plan **produces** Contract 4 (deployments) and the `ship` / `deployments` rows of Contract 5. It **consumes** Contract 1 (project folder), Contract 2 (`loadBrief`, `brief.policy`, `brief.client`) and Contract 3 (`getMachineProvider(config).acquire(...)`).

**The foundation is used, not copied.** Read `/root/highland-foundation/docs/RUNBOOK.md` before any task that touches a box. The exact `ops update` messages Task 3 maps come from `/root/highland-foundation/ops/src/update.ts` (v0.1.0).

## Rulings made while scoping (decided, not open)

1. **The approved release is a tag.** `ship` ships the newest `v<x.y.z>` tag in `<project>/app/` whose commit equals `project.json.approved.sha`, and refuses (plain English, nothing touched) if there is none. Cutting the release (`npm run release`, with its CHANGELOG entry) belongs to the build/change gate (Plans 8 and 11), which knows what changed. See Contract gap 1.
2. **Build on a Contract 3 machine with purpose `'smoke'`** (spec §4.7 "pre-ship test deploys"; Contract 3 has no `'ship'` purpose, gap 2). The build folder is Plan 10's own, `~/hf-ship/<slug>-<runId>`, removed in `finally` together with the built images, before `machine.release()`.
3. **Image names.** Tar delivery keeps the foundation's local-only names `highland/app:<v>` / `highland/ops:<v>` (one client per box, so no clash there). Registry delivery pushes `<registry.host>/<registry.namespace>/app:<v>` and `/ops:<v>` (namespace default `highland-<slug>`), and the box gets `APP_IMAGE`, `OPS_IMAGE` and `IMAGE_PULL_POLICY=missing`. The build machine's Docker is signed in to the registry once by the operator; the box signs in through `docker --config <bundle>/.docker login --password-stdin`, so the password goes on stdin.
4. **Box-to-box transfer streams through Conductor** (`ssh build cat file | ssh box 'cat > file.part'`), then both ends' `sha256sum` must match before `mv file.part file`. A mismatch or a broken pipe stops the ship with nothing loaded.
5. **The health token never leaves the box.** The version/readiness probe runs as `docker compose run --rm --no-deps -T --entrypoint node ops --input-type=module -` with the script on stdin; it reads `HEALTH_TOKEN` and `APP_INTERNAL_URL` from the ops container's own environment. This is stricter than "fetched over SSH, never stored locally" and avoids `SITE_ADDRESS`/TLS/tunnel differences between boxes.
6. **Updates run detached.** `setsid nohup sh -c '<compose> run --rm -T updater update --to <v> [--image-file images-<v>.tar] > .conductor/update-<runId>.log 2>&1; echo $? > .conductor/update-<runId>.exit'`. Conductor polls the exit file (`pollMs` 5 s, `updateTimeoutMs` 45 min). Losing contact or timing out records `pendingCheck` on the deployment, and every later `ship` refuses until `conductor deployments status` has seen the box and resolved it.
7. **First-time setup is resumable and never repeats `ops init`.** If `.env` exists while `setup.step` is before `initialised`, the folder holds settings Conductor did not make, and the ship refuses. `BACKUP_PASSWORD` is shown once per run, on a terminal only, until the operator types `saved`; then `setup.step` becomes `password-saved` and it is never shown again by Conductor.
8. **Policy drives setup, and fails closed** (spec §6, Contract 2 `policy`):
   - `operatorAccess` must be `true`; `policy.hosting` must equal the deployment's `hosting`;
   - remote access is one of `cloudflare-tunnel` (`ops init --tunnel`, `COMPOSE_PROFILES=tunnel`, `TUNNEL_ENABLED=true`), `ssh` (direct; allowed for `operator-server`, and for `client-box` only after the operator confirms the client has agreed to an inbound SSH opening) or `tailscale` (set up by hand per the runbook; Conductor sets nothing for it);
   - the Cloudflare tunnel is refused unless some `policy.outbound` entry matches `/cloudflare/i`, because Cloudflare sees the traffic (runbook "Where data goes"); the refusal suggests Tailscale or revising the brief;
   - the backup destination is shown without credentials next to `policy.backupDestination` and `policy.residency`, and the operator must confirm they match; local folders, `localhost`/`127.*`/`::1` and unknown schemes are refused before the box is touched.
9. **Alerts default to Matrix** with `factory.alerts.matrix.homeserver` and `.roomId` from Conductor's config as the suggested answers; the bot token is typed per deployment. A webhook is optional. The heartbeat address (Uptime Kuma push monitor) is required unless the operator types `skip`, which is recorded as `alerts.heartbeat: false` and shown by `deployments status` as a standing warning.
10. **Exit codes for `ship`:** `0` shipped or updated; `1` not done and nothing changed (refused, cancelled, rolled back, already on, busy); `2` stopped part-way through first-time setup or lost contact (run `ship` again, or `deployments status`); `3` urgent (the box may be down); `64` usage; `130` interrupted. `deployments status` exits `0` when every box is healthy and current, `1` otherwise.
11. **No models are used.** `ship` and `deployments` are deterministic. Nothing is sent to an AI model and no subscription is spent.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. `npm test` (`node --test`). The existing suite stays green at every commit.
- **Tests never touch real boxes, real registries or a real Docker daemon, and never run real `ssh`.** Every test that reaches a box puts the `test/helpers/fakeSsh.js` stub first on `PATH`; machine providers are injected stubs. Local `git` may run for real on temporary repos.
- **No secrets in Conductor's files, logs or argv.** No secret value may appear in: deployment records, ship logs, run logs, terminal output (except `BACKUP_PASSWORD` shown once, and the first-admin link shown once), any process argv (local or remote command string), or test output. Every value the operator types as a secret, and every value read from the box's `.env`, goes through `rememberSecret()` before anything else.
- **Fail closed.** No terminal where a question is needed → refuse before touching the box. Unknown `ops update` output → treated as lost contact. Unparseable CHANGELOG → "could not tell", never "up to date". Unreadable deployment record → that deployment is reported as a problem, never silently skipped.
- **Plain UK English** for every operator-facing message; no stack traces, no raw JSON, no Docker output dumps (at most one redacted line of a tool's error).
- **Atomic writes** for every file under the project folder (temp file, fsync, rename), as Contract 1 requires.
- **SSH options, always:** `-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4`. Conductor never accepts a new host key and never prompts for a password.

## Review Focus

1. **SSH drops, or the operator presses Ctrl-C, while an update is running.** The update carries on to its own end on the box (detached); Conductor says so, records `pendingCheck`, exits 2, and the next `ship` refuses until `deployments status` has resolved what the box is running. Pinned in Task 9 (`lost contact while polling`) and Task 10 (`a pending check blocks the next ship`).
2. **First ship run without a terminal** (cron, CI, piped). It refuses before any SSH call to the box or any machine is acquired. Pinned in Task 10.
3. **The operator walks away half-way through first-time setup** (closes the terminal after the password is shown but before typing `saved`, or the start fails). Re-running `ship` resumes from `setup.step`, never re-runs `ops init` over the existing `.env`, and shows the password again only if it was never confirmed. Pinned in Task 8.
4. **Secret values with awkward characters** (`$`, `#`, spaces, quotes, backslashes in an SMTP password; a newline pasted by accident). The `.env` line reads back exactly in Compose; a newline is refused with a plain message before anything is sent. Pinned in Task 8 (`dotenvLine`).
5. **A box that answers SSH but is broken** (ops image missing, database down, `HEALTH_TOKEN` mismatch, garbage on stdout). `deployments status` reports each part plainly, carries on to the next deployment, and exits 1. Pinned in Tasks 5 and 11.

## Contract gaps found (reported, not edited into the roadmap)

1. **Approved commit and release.** No contract says where the operator's approval is recorded or who cuts the release version. Plan 10 reads `project.json.approved = { sha, at }` and needs a `v<version>` tag on that commit. Plans 8/11 should write `approved` and run `npm run release -- patch|minor` (with a CHANGELOG entry) at the gate.
2. **Contract 3 purposes** have no `'ship'`; Plan 10 uses `'smoke'`. Contract 3 also does not name the run folder `release()` removes, so Plan 10 uses and cleans its own. The static provider's host lock must cover image builds: two clients building `highland/app:0.1.3` on one machine at once would clash.
3. **Config.** `loadConfig` drops everything except `participants`, `options`, `routing`. No plan owns parsing `factory.*`. Task 10 adds `factory: parsed.factory ?? {}` to its return if Plan 7 has not.
4. **CLI dispatch.** `main()` refuses outside a git repo before any command runs; factory commands must be dispatched before that check. Plans 7–10 all edit `args.js`/`main.js`; there is no shared dispatch contract.
5. **`policy.outbound` vocabulary** is free text. Plan 10 matches `/cloudflare/i` to allow the Cloudflare tunnel.
6. **Contract 4 is extended additively** (fields in Task 1). Plan 11 should treat `setup.step !== 'done'` and `pendingCheck` as "not updatable", and reuse `runLaterShip` for "ship as update".
7. **`foundation` format.** Contract 4's example is `"v0.1.0"`; `/api/version` reports `"0.1.0"`. Plan 10 stores `v` + the reported version.
8. **Foundation-side gaps (no contract owns them):** `ops update` has no machine-readable outcome, so Task 3 parses the v0.1.0 message text (pinned by fixtures copied from `update.ts`); there is no `ops` command to set `.env` values from stdin, so Task 8 uses a small `awk` replace-or-append; there is no `ops status --json`, so Task 5 reads `ops_runs` with `psql`; there is no test-alert command; `securityFixesSince` is TypeScript with a `semver` dependency, so Task 4 ports it (same regexes, x.y.z only).

## Operator follow-ups (before the first real ship)

1. **A target box** (or rented server): x86-64 Linux, Docker Engine + Compose plugin, `setsid` (util-linux), a deploy user in the `docker` group, the bundle folder created and owned by that user (`sudo mkdir -p /opt/highland/<name> && sudo chown <user> /opt/highland/<name>`), Conductor's SSH public key in that user's `authorized_keys`, and the box's host key in Conductor's `~/.ssh/known_hosts` (check the fingerprint by hand: Conductor never accepts a new key).
2. **SSH config alias per deployment** in `~/.ssh/config` (recommended: the deployment's `host` is the alias). For a box behind the Cloudflare tunnel: route an SSH hostname to `ssh://host.docker.internal:22` in the tunnel dashboard, install `cloudflared` on the Conductor VM and add `ProxyCommand cloudflared access ssh --hostname %h` to the alias. First ship happens on the LAN or VPN; afterwards only the alias changes.
3. **Matrix:** a bot account, an alerts room (the bot invited and joined), the bot's access token to paste at first ship; put the homeserver and room id in `factory.alerts.matrix` in Conductor's config.
4. **Uptime Kuma:** one push monitor per deployment (alert after 5 minutes of silence); paste its push address at first ship.
5. **Cloudflare tunnel:** one tunnel per client box, its token pasted at first ship, routes added in the dashboard (staff address → `http://proxy:80`). Not yet tried on a real box (runbook).
6. **Backup destination per client** (per the data policy) and its sign-in details; for `sftp:` the box's own SSH key must be authorised there.
7. **Password manager:** an entry per client for `BACKUP_PASSWORD`.
8. **Build machine** (CT 111 `hf-build` under the `static` provider): Node 22, npm with internet access, Docker, git. For registry delivery, `docker login <registry>` once on it.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/factory/deployments/store.js` | Contract 4 record: validate, new, load, save (atomic, secret-refusing), list, history, lock | 1 |
| `src/secrets.js` (modify) | `rememberSecret`, `forgetRememberedSecrets` | 1 |
| `src/exec.js` (modify) | `spawnTracked` (streaming children killed on Ctrl-C) | 2 |
| `src/factory/ship/remote.js` | tool detection, target checks, `shq`, `sshArgs`, `remoteRun`, `remotePipe`, `sendFile`, `sshProblem` | 2 |
| `test/helpers/fakeSsh.js` | scripted stub `ssh` that records argv and stdin | 2 |
| `src/factory/ship/outcomes.js` | `ops update` exit code + message → plain outcome; `SHIP_EXIT` | 3 |
| `src/factory/ship/securityFixes.js` | version compare, CHANGELOG parse, `securityFixesSince`, `latestFoundation` | 4 |
| `src/factory/ship/probe.js` | `composeCmd`, `preflight`, `probeBox` (version, `ops check`, backup/restore runs) | 5 |
| `src/factory/ship/release.js` | `approvedRelease`, `imageNames`, `buildOnMachine`, `deliverToBox`, `cleanupBuild` | 6 |
| `src/ui/ask.js` | terminal questions: text, hidden secret, choice, confirm; fail closed | 7 |
| `src/factory/ship/setupPlan.js` | `policyProblems`, `askDeploymentBasics`, `askSettings`, backup-destination checks, `initArgs` | 7 |
| `src/factory/ship/envFile.js` | `SETTABLE`, `dotenvLine`, `setEnvCommand`, `setEnv`, `readBackupPassword` | 8 |
| `src/factory/ship/firstShip.js` | resumable first-time setup | 8 |
| `src/factory/ship/update.js` | detached update, polling, bundle-file refresh, image-file pruning, `runLaterShip` | 9 |
| `src/factory/ship/index.js` | `shipProject`: lock, checks, build, deliver, first or later ship, logs | 10 |
| `src/cli/args.js`, `src/cli/main.js` (modify), `src/cli/factoryShip.js`, `src/config.js` (modify) | `ship` / `deployments` commands, dispatch before the git-repo check, `factory` passthrough | 10 |
| `src/factory/ship/status.js`, `src/cli/factoryShip.js` (modify) | `deploymentStatus`, `statusText`, `listText`, `deploymentsCli` | 11 |
| `test/helpers/shipProject.js`, `test/helpers/scriptedAsk.js` | temp project + app repo, stub machine provider, test brief, whole-ship SSH rules; scripted answers | 6, 7, 10 |
| `README.md`, `config.example.json`, `spikes/ship-smoke/` | operator docs and operator-run smoke | 12 |

## Tasks

1. [Deployment records (Contract 4)](task-01-deployment-store.md)
2. [Remote runner and the fake SSH](task-02-remote.md)
3. [Update outcomes in plain English](task-03-outcomes.md)
4. [Foundation security fixes](task-04-security-fixes.md)
5. [Preflight and box probe](task-05-probe.md)
6. [Build on a machine and deliver](task-06-build-deliver.md)
7. [Questions and policy-derived settings](task-07-setup-plan.md)
8. [First-time setup](task-08-first-ship.md)
9. [Later ships through the safe update](task-09-later-ship.md)
10. [`conductor ship`](task-10-ship-cli.md)
11. [`conductor deployments [status]`](task-11-deployments-cli.md)
12. [Docs and operator ship smoke](task-12-docs-smoke.md)

Order: 1, 3, 4 need nothing; 2 needs 1 (`rememberSecret`); 5 needs 2; 6 needs 2; 7 needs 1; 8 needs 2, 5, 6, 7; 9 needs 2, 3, 5, 6; 10 needs 1–9; 11 needs 1, 4, 5, 10; 12 needs all. Plans 7 (brief) and 8 (machines, project layout) must be merged before Task 10's end-to-end tests run against real `loadBrief`; until then Task 10 injects them.

## Shared Interfaces (all tasks)

```js
// Task 1 — src/factory/deployments/store.js
SETUP_STEPS = ['new', 'delivered', 'initialised', 'password-saved', 'configured', 'started', 'verified', 'done']
OUTCOMES = ['installed', 'updated', 'rolled-back', 'cancelled', 'already-on', 'busy', 'settings-error', 'urgent', 'lost-contact', 'confirmed']
Deployment = {
  schema: 1, name, project,                     // name: /^[a-z0-9][a-z0-9-]{0,39}$/; project = slug
  host, ssh: { user, port: number|null, keyPath: string|null },
  bundleDir,                                    // /^\/[A-Za-z0-9._\/-]+$/, no '..'
  hosting: 'client-box'|'operator-server',
  imageDelivery: 'tar'|'registry', registry: null | { host, namespace, user },
  access: 'cloudflare-tunnel'|'ssh'|'tailscale', origin, site,   // site ':80' when access is cloudflare-tunnel
  alerts: { matrix: null | { homeserver, roomId }, webhook: boolean, heartbeat: boolean },
  setup: { step, at }, currentVersion: string|null, foundation: string|null,   // foundation 'v0.1.0'
  bundleVersion: string|null,                   // which .conductor/bundle-<v>/ reference copy is on the box
  pendingCheck: null | { since, version, why },
  lastStatus: null | { at, app, foundation, ok, problems: string[] },
  history: [{ at, version, from, outcome, detail }]
}
deploymentPath(projectDir, name) -> string
validateDeployment(obj) -> { ok, problems: string[] }
newDeployment(fields) -> Deployment
loadDeployment(projectDir, name) -> Deployment | null           // throws DeploymentError (plain English)
saveDeployment(projectDir, dep) -> void                          // atomic; throws DeploymentError on invalid / secret-looking content
listDeployments(projectsRoot) -> [{ slug, projectDir, name, deployment: Deployment|null, problem: string|null }]
addHistory(dep, { version, from = null, outcome, detail = '', at }) -> Deployment
withStep(dep, step, at) -> Deployment
lockDeployment(projectDir, name, { pid = process.pid, isAlive = defaultIsAlive } = {}) -> { release(): void } | null

// Task 1 — src/secrets.js
rememberSecret(value) -> void        // values ≥ 4 chars join secretValues(); redact() then covers them
forgetRememberedSecrets() -> void    // tests only
// Task 2 — src/exec.js
spawnTracked(cmd, args, opts) -> ChildProcess     // detached, in LIVE until 'close'
// Task 2 — src/factory/ship/remote.js
Target = { host, user, port: number|null, keyPath: string|null, label }   // label: plain name for messages
missingTools(names, { env }) -> string[]
targetOf(dep) -> Target;  targetOfMachine(machine) -> Target
targetProblem(t) -> string | null
shq(s) -> string
sshArgs(t, command) -> string[]
remoteRun(t, command, { input = null, timeoutMs = 120000, env = process.env } = {}) -> Promise<{ code, stdout, stderr, timedOut, unreachable }>
remotePipe(from: { target, command }, to: { target, command }, { timeoutMs, env }) -> Promise<{ ok, why: string|null }>
sendFile(localPath, to: { target, command }, { timeoutMs, env }) -> Promise<{ ok, why: string|null }>
sshProblem(t, r) -> string

// Task 3 — src/factory/ship/outcomes.js
SHIP_EXIT = { done: 0, notDone: 1, partway: 2, urgent: 3, usage: 64, interrupted: 130 }
interpretUpdate({ code, output, to, from, name, bundleDir }) -> { outcome, backup: string|null, warnings: string[], text }
exitFor(outcome) -> number

// Task 4 — src/factory/ship/securityFixes.js
isVersion(s) -> boolean; compareVersions(a, b) -> -1|0|1
parseChangelog(text) -> [{ version, date, lines }]
securityFixesSince(text, version) -> [{ version, lines }]
latestFoundation(foundationDir, { env }) -> Promise<{ ok: true, version, changelog } | { ok: false, problem }>

// Task 5 — src/factory/ship/probe.js
composeCmd(dep, args: string) -> string
preflight(t, { bundleDir, env }) -> Promise<{ ok, problems: string[], facts: { arch, freeKb, hasEnv, hasCompose, setsid } }>
probeBox(t, dep, { env }) -> Promise<BoxStatus>
probeVersion(t, dep, { env }) -> Promise<{ unreachable, version: { app, foundation, commit } | null, problem: string|null }>
BoxStatus = { reachable, problem: string|null,
  version: { app, foundation: string|null, commit: string|null } | null,
  checks: { ok, failing: string[] } | null,
  runs: { backup: RunPair, restoreTest: RunPair } | null, notes: string[] }
RunPair = { last: { at, ok, detail } | null, lastOk: { at } | null }

// Task 6 — src/factory/ship/release.js
approvedRelease(projectDir, { env }) -> Promise<{ ok: true, sha, version, tag } | { ok: false, problem }>
imageNames({ imageDelivery, registry, slug, version }) -> { app, ops, appRef, opsRef }
buildOnMachine({ provider, slug, runId, appDir, release, dep, say, env }) -> Promise<Built | { ok: false, problem }>
Built = { ok: true, machine, target, workDir, images: { app, ops, appRef, opsRef }, imagesFile: { path, sha256 } | null, bundleFile: { path, sha256 } }
deliverToBox({ built, target, dep, version, say, env }) -> Promise<{ ok, problem: string|null, imagesFile: string|null }>
cleanupBuild(built, { env }) -> Promise<void>     // never throws

// Task 7 — src/ui/ask.js
createAsk({ input, output, isTTY }) -> Ask
Ask = { isTTY, say(text), sayOnce(text), text(q, { def, check }) -> Promise<string|null>, secret(q, { check, optional }) -> Promise<string|null>,
        choose(q, [{ key, label }]) -> Promise<key|null>, confirm(q) -> Promise<boolean>, close() }
// Task 7 — src/factory/ship/setupPlan.js
policyProblems(policy, { hosting, access }) -> string[]
askDeploymentBasics(ask, { name, slug, policy, defaults }) -> Promise<fields for newDeployment | null>
askSettings(ask, { dep, policy, defaults }) -> Promise<{ settings: [{ key, value, secret }], alerts } | null>
backupProblem(repo) -> string | null; backupShown(repo) -> string
initArgs(dep, brief) -> string[]

// Task 8 — src/factory/ship/envFile.js
SETTABLE: readonly string[]; dotenvLine(key, value) -> string
setEnvCommand(bundleDir) -> string
setEnv(t, bundleDir, settings: [{ key, value }], { env }) -> Promise<{ ok, problem: string|null }>
readBackupPassword(t, bundleDir, { env }) -> Promise<string|null>
// Task 8 — src/factory/ship/firstShip.js
runFirstSetup(ctx) -> Promise<{ outcome: 'installed'|'stopped'|'partway', text, dep }>

// Task 9 — src/factory/ship/update.js
startDetachedUpdate(t, dep, { version, imagesFile, runId, env }) -> Promise<{ ok, problem }>
pollUpdate(t, dep, { runId, timeoutMs, pollMs, sleep, env }) -> Promise<{ code: number|null, output: string, lostContact: boolean }>
refreshBundleFiles(t, dep, { version, env }) -> Promise<{ replaced: string[], warnings: string[] }>
pruneImageFiles(t, dep, { keep: string[], env }) -> Promise<void>
runLaterShip(ctx) -> Promise<{ outcome, text, dep }>

// Task 10 — src/factory/ship/index.js
shipProject({ projectsRoot, slug, name, settings /* shipSettings(config.factory) */, ask, env, provider, loadBrief, runId, sleep, state }) -> Promise<{ exit, text }>
shipSettings(factory) -> { projectsRoot, foundationDir, matrix, updateTimeoutMs, pollMs, startTimeoutMs, buildTimeoutMs }
// Task 10 — src/cli/factoryShip.js
shipCli(cli, deps) -> Promise<number>; deploymentsCli(cli, deps) -> Promise<number>
// parseCli: { command: 'ship', slug, to } | { command: 'deployments', status: boolean, slug: string|null }

// Task 11 — src/factory/ship/status.js
deploymentStatus(entry, { foundation, env, now }) -> Promise<StatusReport>
StatusReport = { slug, name, ok, lines: string[], dep: Deployment|null }
statusText(reports) -> string; listText(entries) -> string
```

## Config (read from `config.factory`; all optional)

```json
"factory": {
  "projectsRoot": "~/highland-projects",
  "foundationDir": "~/highland-foundation",
  "alerts": { "matrix": { "homeserver": "https://matrix.example.org", "roomId": "!alerts:example.org" } },
  "ship": { "updateTimeoutMs": 2700000, "pollMs": 5000, "startTimeoutMs": 300000, "buildTimeoutMs": 3600000 }
}
```
