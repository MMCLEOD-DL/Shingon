# Conductor Plan 9 — Full council (factory phase 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** When `conductor build` (Plan 8) reaches its final phase, the full council reviews the **whole client app** against the approved brief and data policy with five members:
- **Design** (new): screenshots of every page at desktop and phone width, the overflow and tap-size gate, an accessibility scan;
- **Reliability** (new): deploy into a throwaway machine, back up, restore, stop and restart services, check that alerts fire and clear;
- **Correctness** (extended): every worked example in the brief has a passing test; money and permission paths;
- **Legal/data** (extended): outbound network destinations against `policy.outbound` (ids from `OUTBOUND_SERVICES`), the app's own `licence-exceptions.json`, plus personal-data and retention notes;
- **Security** (extended): as in Plan 5, plus the role-crossing harness results as its tool evidence (Contract 7.7).

The **Efficiency** member (spec §4.3, advisory) is deferred to after Plan 12 (Contract 7.10).

Blocking findings go back to Plan 8's build loop as a fix, the whole app is reviewed again after each fix, and the operator's build gate gets a council report saved in the build folder. On an ordinary repo, `--council` behaves exactly as Plan 5 built it.

**Architecture:**
- **The hook (Contract 7.7, the Contract 6 entry point).** Plan 8's build ends with `hooks.council({ projectDir, appDir, sha, brief, policy, runId, slug, team, factory, onEvent, checks })` → `{ status, text, fix?, reason?, secretSeen? }`. This plan provides `runProjectCouncil`, which implements that hook, and wires it into `conductor build`. Plan 8 owns the loop around it: a `blocked` result with a `fix` becomes a fix feature, the build runs again, and the hook is called again on the new commit. Council fix rounds are capped by Plan 8's `factory.build.councilFixRounds` (3); at the cap the operator is asked. `secretSeen: true` makes Plan 8 squash the whole `build/<runId>` branch before the gate (Plan 5 Ruling 10). Plan 5's `drive` is not involved, so ordinary runs cannot change by accident.
- **One round per call.** `runProjectCouncil` opens a throwaway council workspace: a real `Workspace` (with its git-directory guard) cloned from `appDir` and checked out at `sha`, whose `baseSha` is the **foundation commit**. It runs one Plan 5 council round in it, with the project members, and returns the verdict, the report text and a fix chunk. Round numbers, the "fixed during the review" history and cached evidence persist across calls in `builds/<runId>/council/state.json` (a `RunLog` in that folder, which also writes the council's own event log).
- **Whole app.** Because the round's base is the foundation commit (`project.json.foundation.commit`, which Plan 8 records), the files, the diff and the "introduced" line sets cover everything the factory added since the foundation. All of it can block. What the foundation release itself contains is the reviewed baseline and is capped at warning by the existing Plan 5 rules.
- **Evidence, gathered once per round, before the members:**
  - **Plan 8's checks first.** The hook's `checks` is Plan 8's `AppChecks` for the same `sha`: `verify` and `browser` results, plus `checks.reports` listing the vitest JSON report, the Playwright JSON report, `crossing.json` and the `screenshots/` folder in `builds/<runId>/reports/`. The council reuses them and does not run those gates again.
  - **Own gates, locally, only for what is missing**, in the council workspace, needing the same things Plan 8's whole-app checks need (`TEST_DATABASE_URL` and Playwright browsers): the `verify` steps with a JSON test report when `checks` has no usable test result; the browser gate (the app's own `apps/web/e2e`) when `checks` has no Playwright report; and, whenever the operator has axe, the **axe pass** (`npm ci`, the web build, and only the council's two accessibility projects), because Plan 8's checks never run axe.
  - **Reliability smoke, on a machine.** One throwaway machine (`purpose: 'council'`, Contract 3, Plan 8's provider and SSH helper) runs the app's own copy of the foundation's `deploy/smoke/run-smoke.sh`: deploy, backup, restore test, real restore, app stopped → alert → Fixed, good update, broken update rolled back, secrets check. The machine is always cleaned and released.
  - The result is cached by commit, so a paused or crashed round does not repeat 30 minutes of work.
- **Members slice the evidence.** Each member reads only its slice and its own tools, and its interpreter sees only its own findings:
  - Design: the page gate, the screen registry, axe and a house-style check;
  - Reliability: the smoke;
  - Correctness: the verify steps (role-crossing tests excluded), user journeys, brief coverage and a money check;
  - Legal: the app's `licence-exceptions.json` as accepted licences, a static data-flow scan against `OUTBOUND_SERVICES` ids and hosts, and a data-policy check;
  - Security: Plan 5's tools plus the role-crossing harness results (`crossing.json`).
- **Code still enforces the rules** (Plan 5 Rulings 6–9). Every finding is made with `makeFinding`, so it carries a ceiling. Only the cases in Ruling 6 below can block, and the interpreter can never raise a grade or clear a locked fact.
- **Report.** On project rounds the report gains a "What was checked" section (naming where each piece of evidence came from: the build's checks or the council's own run) and a brief-coverage line. `council-report.md` and `council-report.json` are written atomically to `builds/<runId>/council-report.{md,json}` after every round (Contract 7.5: Plans 11 and 12 read the council result from there), and the returned `text` names the file.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`, `git`. Detected at run time, never installed by Conductor:
- on the Conductor machine: `npm` and the app's own Playwright (installed by `npm ci` in the council workspace), the Playwright browsers, a PostgreSQL role in `TEST_DATABASE_URL` (Plan 8 already requires these), `ssh`/`scp` (through Plan 8), and axe-core's `axe.min.js` as a file (MPL-2.0, used by Conductor only);
- on the council machine: Docker with Compose, Node 22.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §2 quality bar (items 1–4);
- §4.3 council table, rules and bounce-back;
- §4.4 operator approval (the council report part);
- §4.7 test machines;
- §6 data policy profile.

**Roadmap:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md`. This plan implements **Contract 6** through the hook of **Contract 7.7**, and consumes:
- Contract 1 / 7.5 (project folder, `project.json.foundation`);
- Contract 2 / 7.4 (brief, stable example ids, `policy.outbound` ids, `policy.retention` and `policy.backupDestination` shapes);
- Contract 3 / 7.8 (machines);
- Contract 7.1 (shared modules), 7.2 (`factoryConfig`), 7.3 (CLI dispatch).

Every name this plan imports from Plans 7 and 8 is listed under "Names from Plans 7 and 8 (Contract 7)".

**Builds on:** Plan 5 (`docs/superpowers/plans/2026-10-25-conductor-council-v1/`), merged. Its Rulings 1–12 still hold unless a ruling below changes them for project rounds. The foundation is `/root/highland-foundation` at tag `v0.1.0`: `deploy/smoke/run-smoke.sh`, `apps/web/e2e/`, `docs/RUNBOOK.md`, `docs/BUILDING-ON.md`.

## Rulings made while scoping (decided, not open)

1. **Ordinary repos keep v1.** `drive` and `runCouncilRound`'s behaviour with no project are unchanged, apart from the Plan 5 follow-ups (Ruling 12). Project rounds pass `project` to `runCouncilRound`, and every project-only line sits behind `if (project)`. Pinned by a regression test in Task 12. Why: roadmap Contract 6.
2. **The hook is the only way in.** `runProjectCouncil` is passed as `hooks.council` by the `conductor build` command (Task 13). Plan 8's per-feature councils (`FEATURE_COUNCIL`) are unchanged. The full council runs only on the whole app at the build's final phase. Why: spec §4.3 "runs on the finished build"; Plan 8 Ruling 1.
3. **Whole app = everything since the foundation commit.**
   - The base is `project.json.foundation.commit`, falling back to `refs/foundation/<tag>^{commit}` in `appDir` (Plan 8's `createApp` keeps the foundation release there and deletes the inherited `refs/tags/*`, Contract 7 §7.11).
   - If neither resolves in the council workspace, the round uses the commit Plan 8's build branch started from (`git merge-base <sha> main` in `appDir`), with a locked warning: `Conductor could not find foundation release <tag>, so the council reviewed only this build's own changes`.
   Why: spec §4.3/§4.8 whole-app review.
4. **One machine per round, for the smoke only, always released.**
   - `provider.acquire({ purpose: 'council', projectSlug, runId })`.
   - The reviewed commit is pushed with `git archive` → `upload` → `tar -x` into `<machine.runDir>/smoke-app`.
   - In `finally`: the named smoke clean-up (only the smoke's own `hfsmoke` Compose project, `hf-smoke-rest` container, `/tmp/hf-smoke`, `/tmp/hf-smoke-cookies`, and `<runDir>/smoke-app`), then `machine.release()`. Each is in its own `try`.
5. **Reuse Plan 8's checks; run own gates only for what is missing, and for axe** (Contract 7.7). `reuseChecks(checks)` (Task 6) decides, per part:
   - **verify** is reused when `checks.verify.status === 'failed'` (with the vitest report's cases if present; `npm run verify` chains its steps with `&&`, so a present vitest report means lint, types and licences passed), or when it `passed` and the vitest report is present. Otherwise (no `checks`, `missing`, `skipped`, or passed with no report) the council runs its own verify steps;
   - **browser** is reused when the Playwright report is present. Otherwise the council runs its own browser gate;
   - **axe** always runs locally when `detectAxe` says `ok`: when the browser gate is reused, as the `a11y` step (`npm ci`, the web build, then only the `council-a11y-desktop` / `council-a11y-phone` projects);
   - `crossing.json` and `screenshots/` are taken from `checks.reports` when present.
   Own gates run in the council workspace (the same place and requirements as Plan 8's `runAppChecks`):
   - `testDatabaseProblem` → own gates "not proven", with Plan 8's own sentence (reused parts still count);
   - no browsers (`browsersInstalled`) → the verify steps run, and the browser and `a11y` steps are skipped with that reason.
   Conductor writes `.council/playwright.config.ts` and `.council/a11y.spec.ts` into the throwaway workspace only. The config imports the app's `apps/web/playwright.config.ts`, keeps every project, and adds `council-a11y-desktop` / `council-a11y-phone` when axe is available. The spec imports the app's own `PAGES`, `resolvePath`, `resolveReady`, `authFile` and `loadFixtures`. Nothing is committed: the workspace is removed after the round.
6. **Who can block (new members and extensions).** Everything not listed is at most a warning, and the interpreter cannot raise it.

   | Member | Tool evidence | Blocks when | Locked |
   |---|---|---|---|
   | Design | the page gate (`responsive.spec.ts`: page fails to load, scrolls sideways, buttons too small to tap, script errors); the screen registry (`registry.spec.ts`) | always | yes |
   | Design | axe-core violations | never: `critical`/`serious` → warning, `moderate`/`minor` → note | no |
   | Design | house-style check (hand-typed colours, web fonts, inline styles) | never: warning or note | no |
   | Reliability | a smoke step failed | always | yes |
   | Reliability | the smoke could not run, was refused or timed out | never: a **locked warning** "Reliability was not proven: …" | yes |
   | Correctness | a foundation verify step failed, in Plan 8's checks or the council's own run (install, lint, types, licences, tests outside the role-crossing harness, build) | always (replaces Plan 5's local test result on project rounds) | yes |
   | Correctness | a worked example has no test, or its test fails, is skipped or is a todo | always | yes |
   | Correctness | a user journey (`flows.spec.ts`) fails | always | yes |
   | Correctness | money arithmetic in floating point (heuristic) | never: warning | no |
   | Legal | the app (files since the foundation) reaches an outside host, or ships a known outside-service SDK, that `policy.outbound` does not allow | yes, unless the interpreter sets it aside **with a reason** | no |
   | Legal | personal data held; retention not enforced | never: note / warning | no |
   | Legal | a licence accepted by the app's own `licence-exceptions.json` (with a reason) | never: note showing the reason | no |
   | Security | the role-crossing harness reports a failure (`crossing.json`) | always | yes |
   | Security | no role-crossing report | never: a **locked warning** `The role-crossing tests were not proven: there was no report` | yes |

7. **"Not proven" is never silent.** When evidence is missing:
   - Reliability adds the locked warning `Reliability was not proven: <reason>`;
   - Correctness adds `Brief coverage was not proven: there was no test report`;
   - Design adds `The pages were not checked at desktop and phone width`;
   - Security adds `The role-crossing tests were not proven: there was no report`.
   They head the report's warnings. They do not block, because a finding without tool evidence of a failure may only warn (spec §4.3). The operator decides at the gate (Operator Question 1).
8. **Acceptance tag** (Contract 7.4): every brief example carries a stable `id: '<featureId>#<n>'`, assigned by Plan 7 at approval and never reused. A test proves an example when its full title contains `testTag(id)` (`'[<id>]'`). Vitest and Playwright titles both count, and one test can carry several tags. `acceptanceIds` and `testTag` come from `src/factory/acceptance.js` (Plan 7), the only place the format lives. Ids are not positional, so a brief can have `#1`, `#2`, `#4`.
9. **The data-flow check is static in this plan.**
   - It scans the files changed since the foundation (not tests or docs) for `http(s)://` and `ws(s)://` hosts, and the shipped packages introduced since the foundation for a fixed list of outside-service SDKs. It ignores reserved and example hosts.
   - **Allowed** (Contract 7.4): `policy.outbound` is a list of ids from `OUTBOUND_SERVICES` (`src/factory/outbound.js`, Plan 7), each `{ label, hosts, carries }`. A destination is allowed when one of those ids' `hosts` matches it (`*.cloudflare.com` matches `cloudflare.com` and any subdomain; a plain host matches only itself). An SDK's `OUTBOUND_PACKAGES` row carries a host that is tested the same way. Never free text.
   - The foundation's own destinations (SMTP, backups, Matrix, webhook, heartbeat, tunnel, certificates, registry, Docker Hub) are set per deployment in `.env` and listed in the runbook's "Where data goes", so they are not re-checked. The backup destination (spec §4.6) is not in the app's code either; its check belongs to shipping (Plan 10). Here the interpreter sees `policy.backupDestination` and the residency rule and can warn.
   - Capturing real traffic at run time is out of scope.
10. **Screenshots reach the interpreter as files.** They sit in the council workspace (`reports/screenshots/`, the interpreter's working folder): written there by the council's own browser run, or copied there from Plan 8's `builds/<runId>/reports/screenshots/` when the browser gate was reused. Design's prompt lists at most 40 relative paths, phone first. Whether the reviewer CLI can look at images varies. If it cannot, it says so, and the tool evidence stands. Copies are kept in `builds/<runId>/council/round-<N>/screenshots/` for the operator.
11. **axe-core is Conductor's tool, never the client's.**
    - The file comes from `councilTools.axe` (a path, or `false`), default `~/.local/share/conductor/axe-core/axe.min.js`.
    - `detectAxe` requires `axe v<x.y.z>` and `Mozilla Public License` in the first 1 KB. Absent → "not installed". Unrecognised → status `error` with a warning, and the file is not used.
    - It is injected from its own path with `page.addScriptTag({ path })`. It is never copied into the app, its `package.json`, its lockfile or its commits, so the app's licence gate never sees it. MPL-2.0 is file-level copyleft, so using it unmodified as a tool, not shipped, is fine (spec §5a governs shipped apps).
12. **Plan 5 follow-ups folded in** (from `spikes/council-smoke/RESULT.md`):
    - an added `gitleaks:allow` is a **blocking** possible secret (not locked, so a plainly fake test key can be set aside with a reason). Its file is hidden from later prompts, and `secretSeen` is set (on a project, the hook returns it, Task 12);
    - Semgrep's short `nosem` marker warns too;
    - npm 6 `audit` output is an error, not "clean";
    - an errored check appears once in the report;
    - the status line uses `council-fix`'s own `blocking` count;
    - doctor's could-not-check path still prints the council section;
    - a `fixVendors` drive test.
13. **Out of scope:**
    - the Efficiency member (deferred, Contract 7.10);
    - capturing network traffic at run time;
    - a hard kill of the database or the box: the foundation v0.1.0 smoke stops and starts the app and ops cleanly; the hard-kill step arrives with foundation v0.2.0 (Plan 12 milestone 1, Contract 7.9), and switching to it is a follow-up;
    - Security changes beyond the follow-ups and the role-crossing evidence;
    - squashing the build branch when a secret is seen: Plan 8 does it when the hook returns `secretSeen: true`;
    - the council fix-round cap (Plan 8's `factory.build.councilFixRounds`);
    - live use of the `proxmox` provider.

## Names from Plans 7 and 8 (Contract 7; imported, never redefined here)

- **A1 — the hook** (Contract 7.7). `hooks.council(args) -> { status: 'approved'|'approved-with-warnings'|'blocked'|'paused', text, fix?: { title, instructions }, reason?, secretSeen?: boolean }` with `args = { projectDir, appDir, sha, brief, policy, runId, slug, team, factory, onEvent, checks }`. `factory` is the `FactoryConfig` from `factoryConfig` (`src/factory/config.js`). `checks` is Plan 8's `AppChecks = { verify: Check, browser: Check, reports: string[] }` for the same `sha`, or `null`; `Check = { status: 'passed'|'failed'|'missing'|'skipped', summary, output }`. Built in Task 12; `checks` read in Task 6.
- **A2 — machines** (Contract 7.8). `getMachineProvider(factory, { ssh })` from `src/factory/machines/index.js`; `Machine` has `id`, `host`, `runDir` and `release()`; `acquire` may throw `MachineError` (code `busy` when a preview holds the `static` host), reported plainly. `createSsh()` from `src/factory/ssh.js` gives `exec(machine, script, { timeoutMs })` and `upload(machine, localFile, remotePath, { timeoutMs })`, both resolving `{ code, stdout, stderr }` (255 = SSH failed). `shQuote` from `src/factory/remote.js`. Built in Task 5.
- **A3 — checks helpers.** `browsersInstalled({ env, home })` and `testDatabaseProblem({ testCommand: null, env })` from `src/factory/checks.js` (Plan 8 Task 6). The report files in `checks.reports` are found by base name: `vitest.json`, `playwright.json`, `crossing.json`, and the folder `screenshots`. That lookup lives only in `reportFiles(checks)` (Task 6). Built in Tasks 4 and 6.
- **A4 — member registry.** `MEMBERS` and `membersFor(names)` in `src/council/index.js` (Plan 8 Task 5). This plan adds `design` and `reliability` to `MEMBERS` and exports `PROJECT_COUNCIL = ['security', 'legal', 'correctness', 'design', 'reliability']`. Built in Task 12.
- **A5 — project file and brief** (Contract 7.1, 7.4, 7.5). `loadProject(dir)` from `src/factory/projects.js` (Plan 7), whose `foundation` is `{ repo, tag, commit }` (Plan 8 fills it at the first build); `renderBrief(brief)` from `src/factory/brief.js` (Plan 7); `acceptanceIds(brief)` (each `{ id, featureId, n, example }`, ids taken from the examples' stable `id`) and `testTag(id)` from `src/factory/acceptance.js` (Plan 7); `OUTBOUND_SERVICES` from `src/factory/outbound.js` (Plan 7). Built in Tasks 1, 7, 9, 10 and 12.
- **A6 — the client app keeps the foundation's `notes` example and its fixtures.** The v0.1.0 smoke counts `notes` rows and uploads `apps/server/test/fixtures/files/tiny.png`. If they are removed, the smoke fails and Reliability says so plainly. (Still open; see Contract gaps.)

If any of these changes name in the merged code, change only the import named in the task.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. `npm test` (`node --test`). The suite stays green at every commit.
- **Tests stub everything external.** No real `npm`, Playwright, browsers, Postgres, axe, `ssh`, `scp`, Docker, Proxmox, machine or model. Tests inject a fake `run` for local commands (Plan 8 style), a fake SSH object and a fake provider through `deps`, fake briefs, and fixture reports. No network beyond `127.0.0.1`.
- **Grading, ceilings and locks per Plan 5.** Every finding goes through `makeFinding`. The interpreter never raises a grade above `maxGrade`, never clears a locked finding, and anything it adds without tool evidence is at most a warning. Grades are exactly `blocking` / `warning` / `note`.
- **Members are independent.** No member reads another's findings. Evidence is gathered before the members, and each reads only its slice. Context and attachments for an interpreter come only from that member's ToolRuns.
- **Fail closed on the run, not on the tools.** A missing or broken tool, machine or script is a ToolRun with status `missing` / `off` / `skipped` / `error` and a plain note, never a crash. The hook returns `paused` only when the reviewer has no participant (Plan 5 Ruling 9). Any other unexpected error becomes `{ status: 'paused', reason }` with a plain sentence, so the build can resume.
- **No secrets, no client data.** Remote output and local tool output go through `redact()` before reaching a finding, event, state or report. Local commands run with the same environment rule as Plan 8's `runAppChecks`. The factory works on demo data only (Contract 1). `notes/` is never read.
- **Nothing is written to `appDir`, the real repo or the foundation repo.** The council workspace is a throwaway clone outside the project folder. It is removed after the round, also on error.
- **Project folder writes are atomic** (temp file, fsync, rename): `council-report.md`, `council-report.json` (Plan 7's `writeFileAtomic`), `council/state.json` (through `RunLog.saveState`).
- **Plain UK English** for every operator-facing string. No stack traces, no raw JSON in the report.

## Review Focus

1. **The machine or a tool goes away in the middle** (SSH drops, the smoke or a gate step times out, the provider throws on `acquire` or `release`):
   - clean-up and `release()` still run;
   - the right "not proven" warning appears;
   - nothing blocks because of the outage, and the hook does not throw.
   Pinned in Task 6, and end to end in Task 12.
2. **An ordinary repo with `--council`:** the same members, prompts, report text, events and state as Plan 5, with no provider call and no file under any project folder. Pinned in Task 12 (a v1 regression test) and Task 7 (the prompt is unchanged without a brief).
3. **Brief coverage at the edges:**
   - a tagged test that is `skip`/`todo`, or a mistyped tag (`[mileage-claims#2 ]`), counts as missing;
   - one test carries two tags;
   - a feature with no examples → locked warning;
   - a stale tag (`[x#9]`) → note.
   Pinned in Task 9.
4. **The interpreter tries to bend the new rules:** setting aside a page-gate, coverage or smoke failure; raising an axe warning to blocking; blocking on a screenshot alone; setting aside a data-flow finding without a reason. Code holds the line. Pinned in Tasks 8, 9, 10 and 11.
5. **The hook is called again after a pause or crash:**
   - same commit → the cached evidence is reused (no machine, no second gate run) and the round keeps its number;
   - new commit (after a fix) → fresh evidence, the next round number, and "Fixed during the review" lists what went away.
   Pinned in Tasks 6 and 12.
6. **Reusing Plan 8's checks never hides a failure:** a missing, unreadable or out-of-folder report counts as missing (the council runs that gate itself, or says "not proven"); a passed `verify` with no test report is not reused; a failed one is, and blocks; a crossing-only test failure blocks through Security, not twice. Pinned in Tasks 6, 9 and 12.

## Operator Questions (open; the plan builds the defaults shown)

1. **"Not proven" on a client build** (no machine, no browsers, no test database). Default built: a locked warning heading the report, not a block. The alternative is to block until proven.
2. **Serious accessibility problems** (axe `critical`/`serious`). Default built: warning. The spec blocks Design only for broken or unusable layouts.
3. **Time per round.** With Plan 8's checks reused, the council's own local work is only the axe pass (about 3–5 minutes: `npm ci`, the web build, two accessibility projects; nothing when axe is not installed), plus 10–20 minutes of smoke on the machine. If `checks` lacks a report, the missing gates add up to about 10 minutes. So about 15–25 minutes per round. Default built: everything every round (spec §4.3 "re-runs fully"). The alternative is the smoke only on the first round and the round going to the gate.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/council/findings.js`, `interpret.js`, `report.js`, `tools.js` (modify) | labels, id prefixes, report order, tool labels for the new members and tools | 1 |
| `src/options.js`, `src/council/index.js` (modify) | `councilSmokeTimeoutMs`, `councilGatesTimeoutMs`; `axe` in `councilTools` | 1 |
| `src/council/project.js` | `projectContext` | 1 |
| `src/council/security.js`, `report.js`, `tools.js`, `findings.js`, `index.js` (modify) | Plan 5 follow-ups | 2 |
| `src/council/councilWorkspace.js` | `openCouncilWorkspace` (a guarded throwaway clone at `sha`, base = foundation commit), `openCouncilLog` | 3 |
| `src/council/gates.js`, `src/council/assets/council.playwright.config.ts`, `src/council/assets/council-a11y.spec.ts` | `detectAxe`, `runGates` (only the parts asked for), parsers for vitest, Playwright, axe and crossing reports | 4 |
| `src/council/smoke.js`, `src/council/assets/smoke.sh`, `src/council/assets/smoke-clean.sh` | `pushCommit`, `runSmoke`, `parseSmokeLog`, `SMOKE_STEPS` | 5 |
| `src/council/evidence.js` | `reportFiles`, `reuseChecks`, `collectEvidence` (Plan 8's checks reused, own gates for the rest, smoke; cached by commit) | 6 |
| `src/prompts.js`, `src/council/interpret.js` (modify) | brief, policy, measurements and screenshot paths in the interpreter prompt | 7 |
| `src/council/design.js` | `DESIGN` and its checks | 8 |
| `src/council/coverage.js`, `src/council/correctness.js`, `src/council/security.js` (modify) | brief coverage, verify, journeys, money; Security's role-crossing ToolRun | 9 |
| `src/council/dataflow.js`, `src/council/licences.js` (modify) | data-flow and data-policy checks; the app's `licence-exceptions.json` | 10 |
| `src/council/reliability.js` | `RELIABILITY` | 11 |
| `src/council/index.js`, `report.js` (modify), `src/council/reportFile.js`, `src/council/projectCouncil.js` | project round, report sections, `writeCouncilReport`, `runProjectCouncil` (the hook) | 12 |
| `src/cli/factoryBuild.js` (Plan 8's `build` handler), `src/cli/main.js` + `src/cli/prepareRun.js` (doctor), `src/ui/status.js` (modify) | wire the hook into `conductor build`; council progress lines; doctor; follow-ups | 13 |
| `test/helpers/councilFull.js`, `test/fixtures/council-full/` | fake `run`, fake SSH and provider, fixture reports and smoke logs, a sample brief | 4, 5 (used by 6–13) |
| `README.md`, `config.example.json`, `spikes/council-full-smoke/` | docs and the operator smoke | 14 |

## Tasks

1. [Members, options and the project context](task-01-members-project.md)
2. [Plan 5 follow-ups](task-02-v1-followups.md)
3. [Council workspace and log](task-03-workspace.md)
4. [Gates (verify, browser gate, accessibility)](task-04-gates.md)
5. [Reliability smoke on a machine](task-05-smoke.md)
6. [Evidence stage](task-06-evidence.md)
7. [Interpreter for client apps](task-07-interpreter.md)
8. [Design member](task-08-design.md)
9. [Correctness for client apps, and Security's role-crossing evidence](task-09-correctness.md)
10. [Legal/data for client apps](task-10-legal-data.md)
11. [Reliability member](task-11-reliability.md)
12. [The project round, the report and the hook](task-12-round-hook.md)
13. [Wiring, status and doctor](task-13-wiring-status.md)
14. [Docs and operator smoke](task-14-docs-smoke.md)

Order:
- 2 is independent (any time);
- 3, 4, 5 need 1; 6 needs 4 and 5;
- 7 needs 1;
- 8–11 need 6 and 7;
- 12 needs 3 and 8–11; 13 needs 12; 14 needs all.
- **Merge Plans 7 and 8 before starting this plan** (roadmap order 7 → 8 → 9). Per task: Plan 7 is imported by Tasks 7, 9, 10 and 12 (`OUTBOUND_SERVICES`, `acceptanceIds`, `testTag`, `writeFileAtomic`, `renderBrief`); Plan 8 by Task 5 (`shQuote`), Task 12 (`MEMBERS`/`membersFor` in `src/council/index.js`, and the default `getMachineProvider`/`createSsh`) and Task 13 (it edits Plan 8's `buildCommand` in `src/cli/factoryBuild.js` and the doctor paths in `src/cli/prepareRun.js`). Task 1 also edits files Plan 8 Task 5 changed (`findings.js`, `report.js`, `index.js`), so rebase on Plan 8 first. Tasks 2–4, 6, 8 and 11 use only injectable `deps`.

## Shared Interfaces (all tasks)

```js
// Task 1 — labels and options
MEMBER_LABEL += { design: 'Design', reliability: 'Reliability' }      // src/council/findings.js
ID_PREFIX    += { design: 'D', reliability: 'R' }                     // src/council/interpret.js
ORDER         = [...Plan 5 order, (Plan 8's 'foundation' if present), 'design', 'reliability']   // src/council/report.js
TOOL_LABEL   += { crossing: 'the role-crossing tests', 'licence-exceptions': "the app's licence exceptions", 'page-gate': 'the page check (desktop and phone)', registry: 'the screen list check', axe: 'axe-core (accessibility scanner)',
  'house-style': 'house style check', smoke: 'the reliability test (deploy, backup, restore, alerts, updates)',
  verify: "the foundation's checks (install, lint, types, licences, tests, build)", coverage: 'brief coverage check',
  journeys: 'the user journey tests', money: 'money arithmetic check', 'data-flow': 'outside connections check', 'data-policy': 'data policy check' }
DEFAULT_OPTIONS += { councilGatesTimeoutMs: 2400000, councilSmokeTimeoutMs: 2400000 }
// councilTools also accepts axe: '<path to axe.min.js>' | false (a file, not a binary)

// Task 1 — src/council/project.js
projectContext({ projectDir, appDir, sha, brief, policy, runId, slug, checks }, { loadProject } = {}) -> Promise<ProjectContext>
ProjectContext = { slug, runId, projectDir, appDir, sha, buildDir, brief, policy, client, foundation: { repo, tag, commit }, checks: AppChecks | null, problem: string | null }
  // Task 12 adds: factory (the hook's FactoryConfig), deps (injected services), briefText (renderBrief(brief))
// imported, Plan 7: acceptanceIds(brief) -> [{ id: '<featureId>#<n>', featureId, n, example }]; testTag(id) -> '[<id>]' (src/factory/acceptance.js)
// imported, Plan 7: OUTBOUND_SERVICES = { [id]: { label, hosts: string[], carries } } (src/factory/outbound.js)

// Task 3 — src/council/councilWorkspace.js
openCouncilWorkspace({ appDir, sha, foundation, runId, baseDir }) -> Promise<{ ws: Workspace, baseSha, problem: string | null, remove(): void }>
openCouncilLog(buildDir, { onEvent }) -> { log: RunLog, state }    // state from <buildDir>/council/state.json, or fresh

// Task 4 — src/council/gates.js
detectAxe({ options, env }) -> { path, version, status: 'ok' | 'missing' | 'off' | 'error', note }
runGates({ dir, axe, need = { verify: true, browser: true }, options, env, run = runCommand, home, helpers })   // helpers: { browsersInstalled, testDatabaseProblem } -> Promise<GatesResult | { problem: string }>
  // need.verify → npm-ci, lint, typecheck, licences, vitest; need.browser → build, browser (incl. axe projects);
  // !need.browser && axe ok → build, a11y (axe projects only); npm-ci runs whenever anything does
GatesResult = { steps: { 'npm-ci', lint, typecheck, licences, vitest, build, browser, a11y: number | null },
  verify: Check | null,                        // Plan 8's verify Check when reused (Task 6), else null
  tests: TestCase[] | null, browser: BrowserCase[] | null, a11y: A11yPage[] | null, crossing: Crossing | null,
  screenshots: [{ page, project, file }],      // file relative to the council workspace (reports/screenshots/…); Task 6 copies reused ones there
  logs: { [step]: string }, axe: detectAxe result, note: string | null,
  source: { verify: 'build' | 'council' | null, browser: 'build' | 'council' | null, a11y: 'council' | null } }   // set by Task 6
Crossing    = { routes, checks, failures: string[] }       // failures = each crossing.json failure's .sentence
GATE_STEPS = ['npm-ci', 'lint', 'typecheck', 'licences', 'vitest', 'build', 'browser', 'a11y']
TestCase    = { file, title, status: 'passed' | 'failed' | 'skipped' | 'todo', message }
BrowserCase = { file, title, project, ok, skipped, message }
A11yPage    = { page, project, violations: [{ id, impact, help, nodes, target }] }
parseVitestJson(text), parsePlaywrightJson(text), parseA11yLines(text), parseCrossingJson(text)

// Task 5 — src/council/smoke.js
pushCommit({ ssh, machine, dir, sha, remoteDir, timeoutMs }) -> Promise<void>       // throws SmokeError (plain message)
runSmoke({ ssh, machine, remoteDir, timeoutMs }) -> Promise<SmokeResult>
SmokeResult = { ran, passed, refused: string | null, failedStep: string | null, failure: string | null,
                steps: [{ n, title, ok }], tail: string, timedOut: boolean }
parseSmokeLog(text, code, { timedOut = false } = {}) -> SmokeResult
SMOKE_STEPS = { '1': 'build the app images', …, secrets: 'no secret in the alerts or logs', '10': 'tear down' }
cleanSmoke({ ssh, machine, remoteDir }) -> Promise<string | null>                     // null, or a plain problem

// Task 6 — src/council/evidence.js
reportFiles(checks) -> { vitest: string | null, playwright: string | null, crossing: string | null, screenshots: string | null }   // by base name in checks.reports
reuseChecks(checks) -> { verify: Check | null, tests: TestCase[] | null, browser: BrowserCase[] | null, crossing: Crossing | null, screenshotsDir: string | null }
  // verify is set only when reusable (Ruling 5); unreadable reports count as missing
mergeGates(reused, own) -> GatesResult                                                          // own wins where it ran
collectEvidence(ctx, { project, head, round, deps }) -> Promise<Evidence>     // deps: { run, helpers, getMachineProvider, createSsh, home }
Evidence = { gates: GatesResult | null, gatesNote: string | null,             // gates null only when nothing was reused and own gates could not run
             smoke: SmokeResult | null, smokeStatus: 'ran' | 'missing' | 'off' | 'error', smokeNote: string | null, machine: string | null,
             shotsDir: string | null }       // builds/<runId>/council/round-<N>/screenshots
state.council.evidence = { sha, value: Evidence }
event 'council-evidence' { stage: 'cached' | 'reuse' | 'gates' | 'acquire' | 'push' | 'smoke' | 'cleanup' | 'release', status: 'start' | 'ok' | 'error', machine }

// Task 7 — prompts and interpreter
ToolRun.context?: string; ToolRun.attach?: string[]      // attach: paths relative to the council workspace
prompts.councilMember({ …, briefText = null, policy = null, context = [], attachments = [] })
POLICY_LINES(policy) -> string
interpretMember(ctx, { …, context = [], attach = [] })
CouncilInput gains: project, brief, briefText, policy, evidence     // all null on ordinary repos

// Tasks 8–11 — members
DESIGN      = { member: 'design', label: 'Design', alwaysInterpret: true, collect }          // src/council/design.js; also WIDTH
RELIABILITY = { member: 'reliability', label: 'Reliability', alwaysInterpret: false, collect } // src/council/reliability.js
CORRECTNESS.collect / LEGAL.collect / SECURITY.collect: Plan 5 output when input.brief == null
SECURITY gains (project rounds) a 'crossing' ToolRun: crossingFindings(crossing) -> Finding[]   // src/council/security.js, Task 9
licenceExceptions({ dir }) -> { accept: string[], findings: Finding[] }                         // src/council/licences.js, Task 10

// Task 12
PROJECT_COUNCIL = ['security', 'legal', 'correctness', 'design', 'reliability']; MEMBERS gains design, reliability
runCouncilRound(ctx, { files, tests, diff, members, env, project = null })
CouncilReport gains (project rounds only): checked: string[], coverage: { proven, total } | null, files: { md, json, screenshots } | null
writeCouncilReport(buildDir, report) -> Promise<{ md, json }>    // src/council/reportFile.js; writes with Plan 7's writeFileAtomic (src/factory/fsAtomic.js)
runProjectCouncil(args, { options = {}, deps = {} }) -> Promise<{ status, text, fix?, reason?, secretSeen? }>   // src/council/projectCouncil.js
  // args as A1 (incl. checks); deps: { loadProject, renderBrief, getMachineProvider, createSsh, run, helpers, now, baseDir }
  // report files: <projectDir>/builds/<runId>/council-report.md and council-report.json (Contract 7.5)
event 'council-report-saved' { md }
```

## Contract gaps (after Contract 7)

Contract 7 settles the earlier gaps 1–6, 9 and 10: the hook is the Contract 6 entry point (7.7); example ids are stable and tagged `[<id>]` (7.4); `Machine` carries `runDir`, `composeProject` and the SSH fields (7.8); the hook gets `checks` with JSON report paths (7.7); council fix rounds have their own cap `factory.build.councilFixRounds` (7.2, 7.7); the hook returns `secretSeen` and Plan 8 squashes (7.7); `policy.outbound` is `OUTBOUND_SERVICES` ids with hosts (7.4); Efficiency is deferred (7.10) and the role-crossing tests are Security's evidence (7.7). What remains:

1. **The foundation v0.1.0 smoke hard-codes its names** (`/tmp/hf-smoke`, Compose project `hfsmoke`), so it is safe only under the `static` provider's host lock, and it **refuses to run where `highland/app` or `highland/ops` images exist**. Contract 7.8 handles the images: Plan 10's `cleanupBuild` removes the `highland/*` images it builds, and previews use `hf-preview/*` names and remove them. `HF_SMOKE_PROJECT`/`HF_SMOKE_DIR` and the hard-kill step come with foundation v0.2.0 (Plan 12 milestone 1, Contract 7.9). This plan stays on v0.1.0 as drafted, with the refusal shown as "Reliability was not proven: …"; switching to the v0.2.0 settings is a follow-up. **Still open** only in that sense.
2. **The smoke depends on the foundation's `notes` example** (A6). Removing `notes` from client apps would make Reliability unpassable. **Still open**: no contract says client apps keep it; a v0.2.0 smoke that seeds its own table would close it.
(The former gap 3, the `checks.reports` file names, is settled: Plan 8 Task 6 fixes them as `vitest.json`, `playwright.json`, `crossing.md`, `crossing.json` and `screenshots` in `builds/<runId>/reports/`, which is what `reportFiles` looks for.)
