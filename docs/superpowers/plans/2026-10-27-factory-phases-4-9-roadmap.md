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
