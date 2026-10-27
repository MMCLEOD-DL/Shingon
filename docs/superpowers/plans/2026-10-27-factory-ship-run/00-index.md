# Conductor Plan 10 — Ship and run (factory phase 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** `conductor ship <slug> --to <deployment>` takes an approved client app from its project folder to a running, backed-up, monitored box, and later ships move it on through the foundation's own safe update. `conductor deployments [status]` tells the operator, in plain English, what every box is running, whether it is healthy, whether its backups and restore tests are working, and whether it is missing foundation security fixes.

**Architecture:**
- **Conductor orchestrates; the box does the work.** Every step on a box is one of the foundation's own tools, run over SSH: `ops init --out`, `docker load`, `docker compose up -d`, `ops backup`, `ops restore-test`, `ops check`, and `updater update --to` (safe update with automatic rollback). Conductor never re-implements them (Contract 4). The few things foundation v0.1.0 has no command for (writing the operator's answers into `.env`, reading the last backup times, a machine-readable update outcome) are small shell snippets or text parsers pinned by fixtures; v0.2.0 adds the proper commands (Contract 7 §7.9) and switching to them is a follow-up.
- **Releases are Plan 10's (Contract 7 §7.6).** The build and change gates only record `project.json.approved` and move `main`. `releaseApp` cuts a release with the app's own `npm run release` in a scratch clone and moves `main` by compare-and-swap; `conductor ship` finds the release on or after the approved build, or cuts the app's first one.
- **Build on a factory machine, deliver to the box.** Images and the bundle are built from the project's app repo at the release tag on a Contract 3 machine acquired with purpose `'ship'` (`npm ci`, `npm run images`, `npm run bundle`), in the machine's own `runDir`, and the `highland/app`/`highland/ops` images are removed afterwards (Contract 7 §7.8); then streamed box-ward through Conductor (SSH to SSH, checked with SHA-256) as a `docker save` file, or pushed to the operator's registry. No Docker daemon or socket is used locally.
- **Plan 11 updates boxes only through `updateDeployment`** (Contract 7 §7.6), which shares the build → deliver → safe-update path with `conductor ship`.
- **First ship vs later ships.** A deployment record (Contract 4) carries `setup.step`. Until it is `done`, `ship` runs the resumable first-time setup (deliver → `ops init` → show `BACKUP_PASSWORD` once → write the operator's answers → start → backup + restore test + checks → record). Once `done`, `ship` runs `updater update --to <version>` **detached on the box** (so a dropped SSH session or Ctrl-C can never kill an update half-way), polls it, and maps its exit code and message to a plain-English outcome recorded in `history`.
- **Secrets never touch Conductor's disk.** `DB_PASSWORD`, `HEALTH_TOKEN` and `BACKUP_PASSWORD` are generated on the box by `ops init`. Everything the operator types (mail password, Matrix token, tunnel token, backup credentials, heartbeat address) is held in memory, registered for redaction, and sent to the box **on SSH standard input**, never in argv. The health token is used **on the box** (a short probe runs inside the ops container, which already has it), so it never leaves the box at all.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`. External tools detected at run time and never installed by Conductor: `ssh` (OpenSSH client), `git`, and `node`/`npm` (only to cut a release, Task 13) locally; `docker` with the Compose plugin, `setsid`, `sha256sum`, `tar`, `awk` on the box; `docker`, `node`/`npm`, `git` on the build machine.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §4.5 Ship: a Compose bundle on any ordinary Linux machine; hosting per the data policy; "copy the bundle, start it, verify health"; the operator gives only address, access and secrets, asked in plain English;
- §4.6 Run: operator remote access (outbound tunnel by default), alerts to the operator (Matrix by default), scheduled backups and tested restores, backup destination per policy, security updates surfaced and shipped through the safe-update path;
- §6 data policy profile; §2 item 4 (backups with a tested restore, health monitoring, safe updates: "an app without these is not finished").

**Binding contracts:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md`, **Contract 7 (library seams) first**: where an earlier contract or this plan's draft disagreed with it, Contract 7 won. This plan **produces** Contract 4 (deployments), the `ship` / `deployments` rows of Contract 5, and from Contract 7: `src/factory/foundationLog.js` (`parseVersion`, `compareVersions`, `parseChangelog`, `securityFixesSince`; Plan 11 extends it), `releaseApp` and `updateDeployment` (§7.6), and the `alerts` and `ship` sections of `factoryConfig` (§7.2). It **consumes** Contract 1 / §7.5 (project folder, `project.json.approved`, `foundation.tag`), Contract 2 / §7.4 (`loadBrief`, `brief.policy` with outbound **ids**, `backupDestination: { kind, detail }`), Contract 3 / §7.8 (`getMachineProvider(factory).acquire({ purpose: 'ship', … })`), and Plans 7 and 8's shared modules: `fsAtomic.js`, `projects.js`, `config.js`, `outbound.js`, `cli/factory.js` (Plan 7); `ids.js`, `remote.js` (`shQuote`, `assertSafe`), `machines/` (Plan 8).

**The foundation is used, not copied.** Read `/root/highland-foundation/docs/RUNBOOK.md` before any task that touches a box. The exact `ops update` messages Task 3 maps come from `/root/highland-foundation/ops/src/update.ts` (v0.1.0).

## Rulings made while scoping (decided, not open)

1. **Find or cut the release (Contract 7 §7.6).** `ship` ships the newest `v<x.y.z>` tag in `<project>/app/` on `main` and on or after `project.json.approved.sha`. If there is none and the app has never had its own release (`package.json` name still `highland-foundation`), `ship` calls `releaseApp({ bump: 'first' })`; if the app already has releases, it refuses and points to `conductor change --resume` (change releases are Plan 11's). `releaseApp` runs the app's own `npm run release -- <bump>` in a scratch clone of `main`, then moves `main` by compare-and-swap and adds the tag. **`bump: 'first'` runs `npm run release -- major`** (the app's first release is 1.0.0) and first renames the package to the slug and adds a changelog line (Contract 7 §7.11: the foundation refuses `release -- first` in a clone made at a release tag; see Task 13). Every `v*` tag in an app repo is an app release, because Plan 8's `createApp` deletes the foundation tags it inherits and sets the `foundation` remote to `--no-tags` (§7.11).
2. **Build on a machine acquired with purpose `'ship'`** (Contract 7 §7.8), in the machine's `runDir` (Plan 8's `release()` removes it). `cleanupBuild` removes the `highland/app:<v>` and `highland/ops:<v>` images it built (and any registry tags) before `machine.release()`, so the foundation smoke can still run there. Plan 8's host lock means one build per static host at a time, so two clients cannot clash on the same image names.
3. **Image names.** Tar delivery keeps the foundation's local-only names `highland/app:<v>` / `highland/ops:<v>` (one client per box, so no clash there). Registry delivery pushes `<registry.host>/<registry.namespace>/app:<v>` and `/ops:<v>` (namespace default `highland-<slug>`), and the box gets `APP_IMAGE`, `OPS_IMAGE` and `IMAGE_PULL_POLICY=missing`. The build machine's Docker is signed in to the registry once by the operator; the box signs in through `docker --config <bundle>/.docker login --password-stdin`, so the password goes on stdin.
4. **Box-to-box transfer streams through Conductor** (`ssh build cat file | ssh box 'cat > file.part'`), then both ends' `sha256sum` must match before `mv file.part file`. A mismatch or a broken pipe stops the ship with nothing loaded.
5. **The health token never leaves the box.** The version/readiness probe runs as `docker compose run --rm --no-deps -T --entrypoint node ops --input-type=module -` with the script on stdin; it reads `HEALTH_TOKEN` and `APP_INTERNAL_URL` from the ops container's own environment. This is stricter than "fetched over SSH, never stored locally" and avoids `SITE_ADDRESS`/TLS/tunnel differences between boxes.
6. **Updates run detached.** `setsid nohup sh -c '<compose> run --rm -T updater update --to <v> [--image-file images-<v>.tar] > .conductor/update-<runId>.log 2>&1; echo $? > .conductor/update-<runId>.exit'`, where `runId` is a Plan 8 run id (`newRunId`, `RUN_ID_RE`; Contract 7 §7.1). Conductor polls the exit file (`pollMs` 5 s, `updateTimeoutMs` 45 min). Losing contact or timing out records `pendingCheck` on the deployment, and every later `ship` refuses until `conductor deployments status` has seen the box and resolved it.
7. **First-time setup is resumable and never repeats `ops init`.** If `.env` exists while `setup.step` is before `initialised`, the folder holds settings Conductor did not make, and the ship refuses. `BACKUP_PASSWORD` is shown once per run, on a terminal only, until the operator types `saved`; then `setup.step` becomes `password-saved` and it is never shown again by Conductor.
8. **Policy drives setup, and fails closed** (spec §6, Contract 2 `policy`):
   - `operatorAccess` must be `true`; `policy.hosting` must equal the deployment's `hosting`;
   - remote access is one of `cloudflare-tunnel` (`ops init --tunnel`, `COMPOSE_PROFILES=tunnel`, `TUNNEL_ENABLED=true`), `ssh` (direct; allowed for `operator-server`, and for `client-box` only after the operator confirms the client has agreed to an inbound SSH opening) or `tailscale` (set up by hand per the runbook; Conductor sets nothing for it);
   - the Cloudflare tunnel is refused unless `policy.outbound` includes the id `'cloudflare-tunnel'` (Plan 7's `OUTBOUND_SERVICES`, Contract 7 §7.4; never free text), because Cloudflare sees the traffic (runbook "Where data goes"); the refusal suggests Tailscale or revising the brief;
   - the backup destination is shown without credentials next to `policy.backupDestination` (`{ kind, detail }`) and `policy.residency`, and the operator must confirm they match; local folders, `localhost`/`127.*`/`::1` and unknown schemes are refused before the box is touched.
9. **Alerts default to Matrix** with `factory.alerts.matrix.homeserver` and `.roomId` (Plan 10's section of `factoryConfig`) as the suggested answers; the bot token is typed per deployment. A webhook is optional. The heartbeat address (Uptime Kuma push monitor) is required unless the operator types `skip`, which is recorded as `alerts.heartbeat: false` and shown by `deployments status` as a standing warning.
10. **Exit codes for `ship`:** `0` shipped or updated; `1` not done and nothing changed (refused, cancelled, rolled back, already on, busy); `2` stopped part-way through first-time setup or lost contact (run `ship` again, or `deployments status`); `3` urgent (the box may be down); `64` usage; `130` interrupted. `deployments status` exits `0` when every box is healthy and current, `1` otherwise.
11. **No models are used.** `ship` and `deployments` are deterministic. Nothing is sent to an AI model and no subscription is spent.
12. **A deployment's foundation is Conductor's record, not the box's claim.** `dep.foundation` (`'vX.Y.Z'`) is set at each install or update from `project.json.foundation.tag` (`ship`) or the `foundation` argument (`updateDeployment`), and `deployments status` checks security fixes against it. Foundation v0.1.0's release script writes the app's version into `foundation.json` (fixed in v0.2.0, Contract 7 §7.9 item 1), so the box's `/api/version` `foundation` field cannot be trusted on v0.1.0 apps.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. `npm test` (`node --test`). The existing suite stays green at every commit.
- **Tests never touch real boxes, real registries or a real Docker daemon, and never run real `ssh`.** Every test that reaches a box puts the `test/helpers/fakeSsh.js` stub first on `PATH`; machine providers are injected stubs. Local `git` may run for real on temporary repos.
- **No secrets in Conductor's files, logs or argv.** No secret value may appear in: deployment records, ship logs, run logs, terminal output (except `BACKUP_PASSWORD` shown once, and the first-admin link shown once), any process argv (local or remote command string), or test output. Every value the operator types as a secret, and every value read from the box's `.env`, goes through `rememberSecret()` before anything else.
- **Fail closed.** No terminal where a question is needed → refuse before touching the box. Unknown `ops update` output → treated as lost contact. Unparseable CHANGELOG → "could not tell", never "up to date". Unreadable deployment record → that deployment is reported as a problem, never silently skipped.
- **Plain UK English** for every operator-facing message; no stack traces, no raw JSON, no Docker output dumps (at most one redacted line of a tool's error).
- **Atomic writes** for every file under the project folder, through Plan 7's `writeJsonAtomic`/`createFileExclusive` (Contract 7 §7.1); no local copy of that logic.
- **SSH options, always:** `-o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=4`. Conductor never accepts a new host key for a client box and never prompts for a password. (A factory build machine keeps the host-key policy Plan 8's provider gives it: `accept-new` with a per-run known-hosts file for fresh Proxmox containers.)
- **One way to quote and check remote values:** Plan 8's `shQuote` and `assertSafe` (Contract 7 §7.1). Plan 10 has no `shq`.

## Review Focus

1. **SSH drops, or the operator presses Ctrl-C, while an update is running.** The update carries on to its own end on the box (detached); Conductor says so, records `pendingCheck`, exits 2, and the next `ship` refuses until `deployments status` has resolved what the box is running. Pinned in Task 9 (`lost contact while polling`) and Task 10 (`a pending check blocks the next ship`).
2. **First ship run without a terminal** (cron, CI, piped). It refuses before any SSH call to the box or any machine is acquired. Pinned in Task 10.
3. **The operator walks away half-way through first-time setup** (closes the terminal after the password is shown but before typing `saved`, or the start fails). Re-running `ship` resumes from `setup.step`, never re-runs `ops init` over the existing `.env`, and shows the password again only if it was never confirmed. Pinned in Task 8.
4. **Secret values with awkward characters** (`$`, `#`, spaces, quotes, backslashes in an SMTP password; a newline pasted by accident). The `.env` line reads back exactly in Compose; a newline is refused with a plain message before anything is sent. Pinned in Task 8 (`dotenvLine`).
5. **A box that answers SSH but is broken** (ops image missing, database down, `HEALTH_TOKEN` mismatch, garbage on stdout). `deployments status` reports each part plainly, carries on to the next deployment, and exits 1. Pinned in Tasks 5 and 11.
6. **Cutting a release while something else moves `main`, or crashing half-way.** `releaseApp` works in a scratch clone, adds nothing if `main` moved (compare-and-swap), and adopts a release whose commit landed but whose tag did not. Pinned in Task 13.
7. **A box whose `/api/version` claims the wrong foundation** (v0.1.0's release script stamps the app version into `foundation.json`). Status uses Conductor's record and still lists missing security fixes. Pinned in Tasks 8 and 11.

## Contract gaps: settled by Contract 7, and still open

Settled (the draft's gaps 1–5 and 7, now built to Contract 7): approval and release ownership (§7.6: gates record `approved`, Plan 10's `releaseApp` cuts releases); the `'ship'` machine purpose and image clean-up (§7.8); config through `factoryConfig` with Plan 10's `alerts`/`ship` sections and `factory.foundation.repo` (§7.2; `loadConfig` keeps `factory`, Plan 7); CLI dispatch through `FACTORY_COMMANDS` (§7.3); `policy.outbound` ids (§7.4); `foundation` always `'vX.Y.Z'` (§7.5). Draft gap 6 is settled too: Plan 11 updates deployments only through `updateDeployment` (§7.6), which refuses a deployment whose setup is not `done` or that has a `pendingCheck`.

Foundation-side gaps (draft gap 8): Contract 7 §7.9 has Plan 12 milestone 1 add `updater update --json`, `ops status --json`, `ops set-env`, `ops test-alert` and the `release.ts` stamping fix in foundation **v0.2.0**. Plan 10 stays on v0.1.0 as drafted: the `ops update` message parser (Task 3), the `psql` read of `ops_runs` (Task 5) and the `awk` `.env` setter (Task 8) are pinned by fixtures, and switching them to the v0.2.0 commands is a follow-up once apps are on v0.2.0. The changelog parser is a zero-dependency port (Task 4).

**Settled by Contract 7 §7.11** (the revision's "still open" list, now closed):
1. **Handler context:** `handler(cli, ctx) -> Promise<number|null>` with `ctx = { cwd, env, stdin, stdout, isTTY, onSignal, exit, factory, config, deps }` (Plan 7 Task 9). `ship` and `deployments` need no participants, so they never read `ctx.config`.
2. **Tags in the app repo:** Plan 8's `createApp` deletes the inherited foundation tags and sets the `foundation` remote to `--no-tags`; Plan 11 fetches the tag it needs as `refs/foundation/vX.Y.Z`; so every `v*` tag in an app repo is an app release. `project.json.foundation.tag` is the only record of the foundation version, and each deployment's `foundation` is recorded from it (Ruling 12). The `foundation.json` side is Plan 11's merge rule ("take the foundation's") and Plan 12 Task 9a's release-script fix.
3. **Update outcomes:** Plan 10's `OUTCOMES` are the only names. Plan 11 uses `updated`, `already-on`, `cancelled`, `rolled-back`, `urgent`, `lost-contact` and `refused` (from `updateDeployment`'s `UPDATE_OUTCOMES`), and calls `interruptShip(state)` on Ctrl-C.
4. **`assertSafe('purpose', 'ship')`** is accepted by Plan 8 Task 10.

Nothing is still open across plans.

## Operator follow-ups (before the first real ship)

1. **A target box** (or rented server): x86-64 Linux, Docker Engine + Compose plugin, `setsid` (util-linux), a deploy user in the `docker` group, the bundle folder created and owned by that user (`sudo mkdir -p /opt/highland/<name> && sudo chown <user> /opt/highland/<name>`), Conductor's SSH public key in that user's `authorized_keys`, and the box's host key in Conductor's `~/.ssh/known_hosts` (check the fingerprint by hand: Conductor never accepts a new key).
2. **SSH config alias per deployment** in `~/.ssh/config` (recommended: the deployment's `host` is the alias). For a box behind the Cloudflare tunnel: route an SSH hostname to `ssh://host.docker.internal:22` in the tunnel dashboard, install `cloudflared` on the Conductor VM and add `ProxyCommand cloudflared access ssh --hostname %h` to the alias. First ship happens on the LAN or VPN; afterwards only the alias changes.
3. **Matrix:** a bot account, an alerts room (the bot invited and joined), the bot's access token to paste at first ship; put the homeserver and room id in `factory.alerts.matrix` in Conductor's config.
4. **Uptime Kuma:** one push monitor per deployment (alert after 5 minutes of silence); paste its push address at first ship.
5. **Cloudflare tunnel:** one tunnel per client box, its token pasted at first ship, routes added in the dashboard (staff address → `http://proxy:80`). Not yet tried on a real box (runbook).
6. **Backup destination per client** (per the data policy) and its sign-in details; for `sftp:` the box's own SSH key must be authorised there.
7. **Password manager:** an entry per client for `BACKUP_PASSWORD`.
8. **Build machine** (CT 111 `hf-build` under the `static` provider): Node 22, npm with internet access, Docker, git. For registry delivery, `docker login <registry>` once on it.
9. **The machine running Conductor** cuts releases (`releaseApp`): it needs Node 22, npm with internet access (`npm ci` and the release script's `npm audit`) and git.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/factory/deployments/store.js` | Contract 4 record: validate, new, load, save (atomic via Plan 7's `fsAtomic`, secret-refusing), list, history, lock | 1 |
| `src/secrets.js` (modify) | `rememberSecret`, `forgetRememberedSecrets` | 1 |
| `src/exec.js` (modify) | `spawnTracked` (streaming children killed on Ctrl-C) | 2 |
| `src/factory/ship/remote.js` | tool detection, targets, `sshArgs`, `remoteRun`, `remotePipe`, `sendFile`, `sshProblem` (quoting and checks from Plan 8's `remote.js`) | 2 |
| `test/helpers/fakeSsh.js` | scripted stub `ssh` that records argv and stdin | 2 |
| `src/factory/ship/outcomes.js` | `ops update` exit code + message → plain outcome; `SHIP_EXIT` | 3 |
| `src/factory/foundationLog.js` | Contract 7 §7.1 shared module: `parseVersion`, `compareVersions`, `parseChangelog`, `securityFixesSince` (Plan 11 adds three more) | 4 |
| `src/factory/ship/probe.js` | `composeCmd`, `preflight`, `probeBox` (version, `ops check`, backup/restore runs) | 5 |
| `src/factory/ship/build.js` | `imageNames`, `buildOnMachine` (purpose `'ship'`), `deliverToBox`, `cleanupBuild` | 6 |
| `src/ui/ask.js` | terminal questions: text, hidden secret, choice, confirm; fail closed | 7 |
| `src/factory/ship/setupPlan.js` | `policyProblems`, `askDeploymentBasics`, `askSettings`, backup-destination checks, `initArgs`, `baseSettings` | 7 |
| `src/factory/ship/envFile.js` | `SETTABLE`, `dotenvLine`, `setEnvCommand`, `setEnv`, `readBackupPassword` | 8 |
| `src/factory/ship/firstShip.js` | resumable first-time setup | 8 |
| `src/factory/ship/update.js` | detached update, polling, bundle-file refresh, image-file pruning, `runLaterShip` | 9 |
| `src/factory/ship/index.js` | `shipProject`, `updateDeployment`, `interruptShip`: lock, checks, release, build, deliver, first or later ship, logs | 10 |
| `src/factory/config.js` (modify, Plan 7's) | `alerts` and `ship` sections of `factoryConfig` | 10 |
| `src/cli/args.js`, `src/cli/factory.js` (modify, Plan 7's), `src/cli/factoryShip.js` | `ship` / `deployments` parser cases and `FACTORY_COMMANDS` handlers | 10 |
| `src/factory/ship/status.js`, `src/cli/factoryShip.js` (modify) | `latestFoundation`, `deploymentStatus`, `statusText`, `listText`, `deploymentsCommand` | 11 |
| `README.md`, `config.example.json`, `spikes/ship-smoke/` | operator docs and operator-run smoke | 12 |
| `src/factory/ship/release.js` | `findRelease`, `releaseApp`, `approvedRelease` (find or cut) | 13 |
| `test/helpers/shipProject.js`, `test/helpers/scriptedAsk.js` | temp project + app repo, stub machine provider, stub `npm`, test brief, whole-ship SSH rules; scripted answers | 6, 7, 10, 13 |

## Tasks

1. [Deployment records (Contract 4)](task-01-deployment-store.md)
2. [Remote runner and the fake SSH](task-02-remote.md)
3. [Update outcomes in plain English](task-03-outcomes.md)
4. [Foundation changelog reader (`foundationLog.js`)](task-04-security-fixes.md)
5. [Preflight and box probe](task-05-probe.md)
6. [Build on a machine and deliver](task-06-build-deliver.md)
7. [Questions and policy-derived settings](task-07-setup-plan.md)
8. [First-time setup](task-08-first-ship.md)
9. [Later ships through the safe update](task-09-later-ship.md)
10. [`conductor ship`, `updateDeployment` and the config sections](task-10-ship-cli.md)
11. [`conductor deployments [status]`](task-11-deployments-cli.md)
12. [Docs and operator ship smoke](task-12-docs-smoke.md)
13. [Cutting releases (`releaseApp`) and finding the approved one](task-13-release.md) (added for Contract 7 §7.6; numbered last to keep 1–12 stable, but **run it before Task 10**)

Order: 1, 3, 4 need nothing; 2 needs 1 (`rememberSecret`); 5 needs 2; 6 needs 2; 7 needs 1; 8 needs 2, 5, 6, 7; 9 needs 2, 3, 4, 5; 13 needs 4 and 6 (the helper); 10 needs 1–9 and 13; 11 needs 1, 4, 5, 10; 12 needs all. **Plans 7 and 8 must be merged first** (Plan 10 imports `fsAtomic.js`, `projects.js`, `config.js`, `outbound.js`, `brief.js`, `cli/factory.js`, `ids.js`, `remote.js` and the machine providers); Plan 9 is not needed by any task.

## Shared Interfaces (all tasks)

```js
// Consumed from Plans 7 and 8 (Contract 7 §7.1; exact names, never redefined here)
//   src/factory/fsAtomic.js   writeJsonAtomic(file, obj, { mode }), createFileExclusive(file, data, { mode })
//   src/factory/projects.js   validateSlug(slug) -> problem|null, readProject(root, slug) -> { dir, project }, loadProject(dir), saveProject(dir, project)
//                             (first install: status 'ready' → 'shipped', Contract 7.5; Plan 10 owns that move)
//   src/factory/brief.js      loadBrief(projectDir) -> Brief   (policy: { hosting, outbound: string[] ids, residency, retention, backupDestination: { kind, detail }, operatorAccess })
//   src/factory/outbound.js   OUTBOUND_SERVICES   ('cloudflare-tunnel' is the only id Plan 10 reads)
//   src/factory/config.js     factoryConfig(config, { env, home }) -> FactoryConfig   (Plan 10 adds alerts, ship: Task 10)
//   src/cli/factory.js        FACTORY_COMMANDS   (Plan 10 adds ship, deployments: Task 10)
//   src/factory/ids.js        newRunId(), RUN_ID_RE   ('20261027-143005-a1b2')
//   src/factory/remote.js     shQuote(s), assertSafe(kind, value)
//   src/factory/machines      getMachineProvider(factory).acquire({ purpose: 'ship', projectSlug, runId }) -> Machine { id, host, ssh: { user, keyPath, knownHostsFile, hostKeyPolicy }, runDir, release() }

// Task 1 — src/factory/deployments/store.js
SETUP_STEPS = ['new', 'delivered', 'initialised', 'password-saved', 'configured', 'started', 'verified', 'done']
OUTCOMES = ['installed', 'updated', 'rolled-back', 'cancelled', 'already-on', 'busy', 'settings-error', 'urgent', 'lost-contact', 'confirmed']
Deployment = {
  schema: 1, name, project,                     // name: /^[a-z0-9][a-z0-9-]{0,39}$/; project = slug (validateSlug)
  host, ssh: { user, port: number|null, keyPath: string|null },
  bundleDir,                                    // /^\/[A-Za-z0-9._\/-]+$/, no '..'
  hosting: 'client-box'|'operator-server',
  imageDelivery: 'tar'|'registry', registry: null | { host, namespace, user },
  access: 'cloudflare-tunnel'|'ssh'|'tailscale', origin, site,   // site ':80' when access is cloudflare-tunnel
  alerts: { matrix: null | { homeserver, roomId }, webhook: boolean, heartbeat: boolean },
  setup: { step, at }, currentVersion: string|null,
  foundation: string|null,                      // 'vX.Y.Z' always (Contract 7 §7.5); Conductor's record (Ruling 12)
  bundleVersion: string|null,                   // which .conductor/bundle-<v>/ reference copy is on the box
  pendingCheck: null | { since, version, foundation, why },
  lastStatus: null | { at, app, foundation, ok, problems: string[] },
  history: [{ at, version, from, outcome, detail }]
}
deploymentPath(projectDir, name) -> string
validateDeployment(obj) -> { ok, problems: string[] }
newDeployment(fields) -> Deployment
loadDeployment(projectDir, name) -> Deployment | null           // throws DeploymentError (plain English)
saveDeployment(projectDir, dep) -> void                          // atomic; throws DeploymentError on invalid / secret-looking content
listDeployments(projectsRoot, { slug = null } = {}) -> [{ slug, projectDir, name, deployment: Deployment|null, problem: string|null }]
addHistory(dep, { version, from = null, outcome, detail = '', at }) -> Deployment
withStep(dep, step, at) -> Deployment
lockDeployment(projectDir, name, { pid = process.pid, isAlive = defaultIsAlive } = {}) -> { release(): void } | null

// Task 1 — src/secrets.js
rememberSecret(value) -> void        // values ≥ 4 chars join secretValues(); redact() then covers them
forgetRememberedSecrets() -> void    // tests only
// Task 2 — src/exec.js
spawnTracked(cmd, args, opts) -> ChildProcess     // detached, in LIVE until 'close'
// Task 2 — src/factory/ship/remote.js
Target = { host, user, port: number|null, keyPath: string|null, knownHostsFile?: string|null, hostKeyPolicy?: 'yes'|'accept-new', label }
missingTools(names, { env }) -> string[]
targetOf(dep) -> Target;  targetOfMachine(machine) -> Target
targetProblem(t) -> string | null                  // assertSafe-based, plain message
sshArgs(t, command) -> string[]
remoteRun(t, command, { input = null, timeoutMs = 120000, env = process.env } = {}) -> Promise<{ code, stdout, stderr, timedOut, unreachable }>
remotePipe(from: { target, command }, to: { target, command }, { timeoutMs, env }) -> Promise<{ ok, why: string|null }>
sendFile(localPath, to: { target, command }, { timeoutMs, env }) -> Promise<{ ok, why: string|null }>
sshProblem(t, r) -> string

// Task 3 — src/factory/ship/outcomes.js
SHIP_EXIT = { done: 0, notDone: 1, partway: 2, urgent: 3, usage: 64, interrupted: 130 }
interpretUpdate({ code, output, to, from, name, bundleDir }) -> { outcome, backup: string|null, warnings: string[], text }
exitFor(outcome) -> number

// Task 4 — src/factory/foundationLog.js (Contract 7 §7.1; Plan 11 adds changesBetween, releaseTags, readChangelogAt)
parseVersion(s) -> { major, minor, patch, pre: Array<string|number> } | null
compareVersions(a, b) -> -1|0|1                    // semver precedence; throws on an invalid version
parseChangelog(text) -> [{ version, date, lines }]  // throws the foundation's own messages
securityFixesSince(text, version) -> [{ version, lines }]

// Task 5 — src/factory/ship/probe.js
composeCmd(dep, args: string) -> string
preflight(t, { bundleDir, env }) -> Promise<{ ok, problems: string[], facts: { arch, freeKb, hasDir, hasEnv, hasCompose } }>
probeBox(t, dep, { env }) -> Promise<BoxStatus>
probeVersion(t, dep, { env }) -> Promise<{ unreachable, version: { app, foundation, commit } | null, problem: string|null }>
BoxStatus = { reachable, problem: string|null,
  version: { app, foundation: string|null, commit: string|null } | null,     // foundation shown, never trusted (Ruling 12)
  checks: { ok, failing: string[] } | null,
  runs: { backup: RunPair, restoreTest: RunPair } | null, notes: string[] }
RunPair = { last: { at, ok, detail } | null, lastOk: { at } | null }

// Task 6 — src/factory/ship/build.js
imageNames({ imageDelivery, registry, slug, version }) -> { app, ops, appRef, opsRef }
buildOnMachine({ provider, slug, runId, appDir, release: { sha, version, tag }, dep, say, env, buildTimeoutMs }) -> Promise<Built | { ok: false, problem }>
Built = { ok: true, machine, target, workDir /* machine.runDir */, version, arch, images: { app, ops, appRef, opsRef }, imagesFile: { path, sha256 } | null, bundleFile: { path, sha256 } }
deliverToBox({ built, target, dep, version, say, env }) -> Promise<{ ok, problem: string|null, imagesFile: string|null }>
cleanupBuild(built, { env }) -> Promise<void>     // removes highland/app:<v>, highland/ops:<v> (+ registry tags), then machine.release(); never throws

// Task 7 — src/ui/ask.js
createAsk({ input, output, isTTY }) -> Ask
Ask = { isTTY, say(text), sayOnce(text), text(q, { def, check }) -> Promise<string|null>, secret(q, { check, optional }) -> Promise<string|null>,
        choose(q, [{ key, label }]) -> Promise<key|null>, confirm(q) -> Promise<boolean>, close() }
// Task 7 — src/factory/ship/setupPlan.js
policyProblems(policy, { hosting, access }) -> string[]          // tunnel needs outbound id 'cloudflare-tunnel'
askDeploymentBasics(ask, { name, slug, policy, defaults }) -> Promise<fields for newDeployment | null>
askSettings(ask, { dep, policy, defaults: { matrix } }) -> Promise<{ settings: [{ key, value, secret }], alerts } | null>
backupProblem(repo) -> string | null; backupShown(repo) -> string
initArgs(dep, brief) -> string[]; baseSettings(dep, version) -> [{ key, value, secret: false }]

// Task 8 — src/factory/ship/envFile.js
SETTABLE: readonly string[]; dotenvLine(key, value) -> string
setEnvCommand(bundleDir) -> string
setEnv(t, bundleDir, settings: [{ key, value }], { env }) -> Promise<{ ok, problem: string|null }>
readBackupPassword(t, bundleDir, { env }) -> Promise<string|null>
// Task 8 — src/factory/ship/firstShip.js
runFirstSetup({ dep, brief, target, ask, version, foundation, images, imagesFile, facts, settings, save, env, now, opts })
  -> Promise<{ outcome: 'installed'|'stopped'|'partway', text, dep }>

// Task 9 — src/factory/ship/update.js
startDetachedUpdate(t, dep, { version, imagesFile, runId, env }) -> Promise<{ ok, problem }>
pollUpdate(t, dep, { runId, timeoutMs, pollMs, sleep, env }) -> Promise<{ code: number|null, output: string, lostContact: boolean }>
refreshBundleFiles(t, dep, { version, env }) -> Promise<{ replaced: string[], warnings: string[] }>
pruneImageFiles(t, dep, { keep: string[], env }) -> Promise<void>
runLaterShip({ dep, target, version, foundation, imagesFile, runId, say, save, env, now, opts }) -> Promise<{ outcome, text, dep }>

// Task 10 — src/factory/config.js additions to FactoryConfig (Contract 7 §7.2)
alerts: { matrix: null | { homeserver, roomId } }
ship: { updateTimeoutMs: 2700000, pollMs: 5000, startTimeoutMs: 300000, buildTimeoutMs: 3600000 }
// Task 10 — src/factory/ship/index.js
shipProject({ factory, slug, name, ask, env, runId, sleep, state, deps = {} }) -> Promise<{ exit, text }>
updateDeployment({ projectDir, name, version, foundation, runId }, { factory, provider, env, say, sleep, state } = {})
  -> Promise<{ outcome: UpdateOutcome, message }>                // Contract 7 §7.6; Plan 11's only way to a box
UPDATE_OUTCOMES = ['updated', 'rolled-back', 'cancelled', 'already-on', 'busy', 'settings-error', 'urgent', 'lost-contact', 'refused']
interruptShip(state) -> string
NO_TTY_FIRST: string
// Task 10 — src/cli/factoryShip.js, registered in FACTORY_COMMANDS
shipCommand(cli, ctx) -> Promise<number>; deploymentsCommand(cli, ctx) -> Promise<number>
// parseCli: { command: 'ship', slug, to } | { command: 'deployments', status: boolean, slug: string|null }

// Task 11 — src/factory/ship/status.js
latestFoundation(repo, { env }) -> Promise<{ ok: true, version, changelog } | { ok: false, problem }>   // repo = factory.foundation.repo
deploymentStatus(entry, { foundation, env, now }) -> Promise<StatusReport>
StatusReport = { slug, name, ok, lines: string[], dep: Deployment|null }
statusText(reports) -> string; listText(entries) -> string; ukTime(iso) -> string

// Task 13 — src/factory/ship/release.js (Contract 7 §7.6)
RELEASE_BUMPS = ['first', 'minor', 'patch']; FIRST_RELEASE_NPM_BUMP = 'major'
findRelease(appDir, sha, { env }) -> Promise<{ sha, version, tag } | null>
releaseApp({ projectDir, bump, runId }, { env, run } = {}) -> Promise<{ ok: true, version, sha, tag } | { ok: false, reason }>
approvedRelease(projectDir, { runId, env }) -> Promise<{ ok: true, sha, version, tag, cut: boolean } | { ok: false, problem }>
```

## Config (Plan 10's sections of `factoryConfig`; all optional)

```json
"factory": {
  "foundation": { "repo": "/root/highland-foundation", "tag": "v0.1.0" },
  "alerts": { "matrix": { "homeserver": "https://matrix.example.org", "roomId": "!alerts:example.org" } },
  "ship": { "updateTimeoutMs": 2700000, "pollMs": 5000, "startTimeoutMs": 300000, "buildTimeoutMs": 3600000 }
}
```

`foundation` is Plan 8's section, shown because `deployments status` reads `foundation.repo` for the newest foundation release. `projectsRoot` (Plan 7), `build` and `machines` (Plan 8) are theirs.
