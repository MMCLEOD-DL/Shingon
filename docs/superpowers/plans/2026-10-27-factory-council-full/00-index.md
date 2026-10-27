# Conductor Plan 9 — Full council (factory phase 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** When `conductor build` (Plan 8) reaches its final phase, the full council reviews the **whole client app** against the approved brief and data policy with five members:
- **Design** (new): screenshots of every page at desktop and phone width, the overflow and tap-size gate, an accessibility scan;
- **Reliability** (new): deploy into a throwaway machine, back up, restore, stop and restart services, check that alerts fire and clear;
- **Correctness** (extended): every worked example in the brief has a passing test; money and permission paths;
- **Legal/data** (extended): outbound network destinations against `policy.outbound`, plus personal-data and retention notes;
- **Security**, as in Plan 5.

Blocking findings go back to Plan 8's build loop as a fix, the whole app is reviewed again after each fix, and the operator's build gate gets a council report saved in the build folder. On an ordinary repo, `--council` behaves exactly as Plan 5 built it.

**Architecture:**
- **The hook.** Plan 8's build ends with `hooks.council({ projectDir, appDir, sha, brief, policy, runId, slug, team, factory, onEvent })` → `{ status, text, fix?, reason? }` (Plan 8 index, "Task 9"). This plan provides `runProjectCouncil`, which implements that hook, and wires it into `conductor build`. Plan 8 owns the loop around it: a `blocked` result with a `fix` becomes a fix feature, the build runs again, and the hook is called again on the new commit. At Plan 8's cap the operator is asked. Plan 5's `drive` is not involved, so ordinary runs cannot change by accident.
- **One round per call.** `runProjectCouncil` opens a throwaway council workspace: a real `Workspace` (with its git-directory guard) cloned from `appDir` and checked out at `sha`, whose `baseSha` is the **foundation commit**. It runs one Plan 5 council round in it, with the project members, and returns the verdict, the report text and a fix chunk. Round numbers, the "fixed during the review" history and cached evidence persist across calls in `builds/<runId>/council/state.json` (a `RunLog` in that folder, which also writes the council's own event log).
- **Whole app.** Because the round's base is the foundation commit (`project.json.foundation.commit`, which Plan 8 records), the files, the diff and the "introduced" line sets cover everything the factory added since the foundation. All of it can block. What the foundation release itself contains is the reviewed baseline and is capped at warning by the existing Plan 5 rules.
- **Evidence, gathered once per round, before the members:**
  - **Gates, locally**, in the council workspace, needing the same things Plan 8's whole-app checks already need (`TEST_DATABASE_URL` and Playwright browsers): `npm ci`, the foundation's `verify` steps with a JSON test report, and its browser gate (the app's own `apps/web/e2e`, screenshots at desktop and phone width) through a council-only Playwright config that adds an axe-core accessibility pass when the operator has axe.
  - **Reliability smoke, on a machine.** One throwaway machine (`purpose: 'council'`, Contract 3, Plan 8's provider and SSH helper) runs the app's own copy of the foundation's `deploy/smoke/run-smoke.sh`: deploy, backup, restore test, real restore, app stopped → alert → Fixed, good update, broken update rolled back, secrets check. The machine is always cleaned and released.
  - The result is cached by commit, so a paused or crashed round does not repeat 30 minutes of work.
- **Members slice the evidence.** Each member reads only its slice and its own tools, and its interpreter sees only its own findings:
  - Design: the page gate, the screen registry, axe and a house-style check;
  - Reliability: the smoke;
  - Correctness: the verify steps, user journeys, brief coverage and a money check;
  - Legal: adds a static data-flow scan and a data-policy check.
- **Code still enforces the rules** (Plan 5 Rulings 6–9). Every finding is made with `makeFinding`, so it carries a ceiling. Only the cases in Ruling 6 below can block, and the interpreter can never raise a grade or clear a locked fact.
- **Report.** On project rounds the report gains a "What was checked" section and a brief-coverage line. `council-report.md` and `council-report.json` are written atomically to `builds/<runId>/` after every round, and the returned `text` names the file.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`, `git`. Detected at run time, never installed by Conductor:
- on the Conductor machine: `npm` and the app's own Playwright (installed by `npm ci` in the council workspace), the Playwright browsers, a PostgreSQL role in `TEST_DATABASE_URL` (Plan 8 already requires these), `ssh`/`scp` (through Plan 8), and axe-core's `axe.min.js` as a file (MPL-2.0, used by Conductor only);
- on the council machine: Docker with Compose, Node 22.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §2 quality bar (items 1–4);
- §4.3 council table, rules and bounce-back;
- §4.4 operator approval (the council report part);
- §4.7 test machines;
- §6 data policy profile.

**Roadmap:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md`. This plan implements **Contract 6** and consumes:
- Contract 1 (project folder);
- Contract 2 (brief);
- Contract 3 (machines).

Plans 7 and 8 were written in parallel. This plan follows Plan 8's on-disk interfaces as of 2026-10-27:
- the `hooks.council` contract;
- `getMachineProvider(factory, deps)`, `Machine.runDir`, `createSsh` (`exec`, `upload`);
- `browsersInstalled`, `testDatabaseProblem`;
- `MEMBERS` / `membersFor(names)`;
- the `[<featureId>#<n>]` test tag.

Every place this plan depends on them is listed under "Assumptions about Plans 7 and 8".

**Builds on:** Plan 5 (`docs/superpowers/plans/2026-10-25-conductor-council-v1/`), merged. Its Rulings 1–12 still hold unless a ruling below changes them for project rounds. The foundation is `/root/highland-foundation` at tag `v0.1.0`: `deploy/smoke/run-smoke.sh`, `apps/web/e2e/`, `docs/RUNBOOK.md`, `docs/BUILDING-ON.md`.

## Rulings made while scoping (decided, not open)

1. **Ordinary repos keep v1.** `drive` and `runCouncilRound`'s behaviour with no project are unchanged, apart from the Plan 5 follow-ups (Ruling 12). Project rounds pass `project` to `runCouncilRound`, and every project-only line sits behind `if (project)`. Pinned by a regression test in Task 12. Why: roadmap Contract 6.
2. **The hook is the only way in.** `runProjectCouncil` is passed as `hooks.council` by the `conductor build` command (Task 13). Plan 8's per-feature councils (`FEATURE_COUNCIL`) are unchanged. The full council runs only on the whole app at the build's final phase. Why: spec §4.3 "runs on the finished build"; Plan 8 Ruling 1.
3. **Whole app = everything since the foundation commit.**
   - The base is `project.json.foundation.commit`, falling back to `git rev-parse <tag>^{commit}`.
   - If neither resolves in the council workspace, the round uses the commit Plan 8's build branch started from (`git merge-base <sha> main` in `appDir`), with a locked warning: `Conductor could not find foundation release <tag>, so the council reviewed only this build's own changes`.
   Why: spec §4.3/§4.8 whole-app review.
4. **One machine per round, for the smoke only, always released.**
   - `provider.acquire({ purpose: 'council', projectSlug, runId })`.
   - The reviewed commit is pushed with `git archive` → `upload` → `tar -x` into `<machine.runDir>/smoke-app`.
   - In `finally`: the named smoke clean-up (only the smoke's own `hfsmoke` Compose project, `hf-smoke-rest` container, `/tmp/hf-smoke`, `/tmp/hf-smoke-cookies`, and `<runDir>/smoke-app`), then `machine.release()`. Each is in its own `try`.
5. **Gates run locally, in the council workspace** (the same place and requirements as Plan 8's `runAppChecks`):
   - `testDatabaseProblem` → gates "not proven", with Plan 8's own sentence;
   - no browsers (`browsersInstalled`) → the verify steps run, and the browser step is skipped with that reason.
   Conductor writes `.council/playwright.config.ts` and `.council/a11y.spec.ts` into the throwaway workspace only. The config imports the app's `apps/web/playwright.config.ts`, keeps every project, and adds `council-a11y-desktop` / `council-a11y-phone` when axe is available. The spec imports the app's own `PAGES`, `resolvePath`, `resolveReady`, `authFile` and `loadFixtures`. Nothing is committed: the workspace is removed after the round.
6. **Who can block (new members and extensions).** Everything not listed is at most a warning, and the interpreter cannot raise it.

   | Member | Tool evidence | Blocks when | Locked |
   |---|---|---|---|
   | Design | the page gate (`responsive.spec.ts`: page fails to load, scrolls sideways, buttons too small to tap, script errors); the screen registry (`registry.spec.ts`) | always | yes |
   | Design | axe-core violations | never: `critical`/`serious` → warning, `moderate`/`minor` → note | no |
   | Design | house-style check (hand-typed colours, web fonts, inline styles) | never: warning or note | no |
   | Reliability | a smoke step failed | always | yes |
   | Reliability | the smoke could not run, was refused or timed out | never: a **locked warning** "Reliability was not proven: …" | yes |
   | Correctness | a foundation verify step failed in the council's run (install, lint, types, licences, tests, build) | always (replaces Plan 5's local test result on project rounds) | yes |
   | Correctness | a worked example has no test, or its test fails, is skipped or is a todo | always | yes |
   | Correctness | a user journey (`flows.spec.ts`) fails | always | yes |
   | Correctness | money arithmetic in floating point (heuristic) | never: warning | no |
   | Legal | the app (files since the foundation) reaches an outside host, or ships a known outside-service SDK, that `policy.outbound` does not allow | yes, unless the interpreter sets it aside **with a reason** | no |
   | Legal | personal data held; retention not enforced | never: note / warning | no |

7. **"Not proven" is never silent.** When evidence is missing:
   - Reliability adds the locked warning `Reliability was not proven: <reason>`;
   - Correctness adds `Brief coverage was not proven: there was no test report`;
   - Design adds `The pages were not checked at desktop and phone width`.
   They head the report's warnings. They do not block, because a finding without tool evidence of a failure may only warn (spec §4.3). The operator decides at the gate (Operator Question 1).
8. **Acceptance tag** (Plan 8 Ruling 3): a test proves example `n` (1-based) of brief feature `id` when its full title contains `[<id>#<n>]`. Vitest and Playwright titles both count, and one test can carry several tags. `ACCEPTANCE_TAG` in `src/council/coverage.js` is the only place the format lives.
9. **The data-flow check is static in this plan.**
   - It scans the files changed since the foundation (not tests or docs) for `http(s)://` and `ws(s)://` hosts, and the shipped packages introduced since the foundation for a fixed list of outside-service SDKs. It ignores reserved and example hosts.
   - **Allowed** = a `policy.outbound` entry (trimmed, lowercased) equals the host, is a parent domain of it, or equals the SDK's service name.
   - The foundation's own destinations (SMTP, backups, Matrix, webhook, heartbeat, tunnel, certificates, registry, Docker Hub) are set per deployment in `.env` and listed in the runbook's "Where data goes", so they are not re-checked. The backup destination (spec §4.6) is not in the app's code either; its check belongs to shipping (Plan 10). Here the interpreter sees `policy.backupDestination` and the residency rule and can warn.
   - Capturing real traffic at run time is out of scope.
10. **Screenshots reach the interpreter as files.** They already sit in the council workspace (`reports/screenshots/`, the interpreter's working folder). Design's prompt lists at most 40 relative paths, phone first. Whether the reviewer CLI can look at images varies. If it cannot, it says so, and the tool evidence stands. Copies are kept in `builds/<runId>/council/round-<N>/screenshots/` for the operator.
11. **axe-core is Conductor's tool, never the client's.**
    - The file comes from `councilTools.axe` (a path, or `false`), default `~/.local/share/conductor/axe-core/axe.min.js`.
    - `detectAxe` requires `axe v<x.y.z>` and `Mozilla Public License` in the first 1 KB. Absent → "not installed". Unrecognised → status `error` with a warning, and the file is not used.
    - It is injected from its own path with `page.addScriptTag({ path })`. It is never copied into the app, its `package.json`, its lockfile or its commits, so the app's licence gate never sees it. MPL-2.0 is file-level copyleft, so using it unmodified as a tool, not shipped, is fine (spec §5a governs shipped apps).
12. **Plan 5 follow-ups folded in** (from `spikes/council-smoke/RESULT.md`):
    - an added `gitleaks:allow` is a **blocking** possible secret (not locked, so a plainly fake test key can be set aside with a reason). Its file is hidden from later prompts, and `secretSeen` is set;
    - Semgrep's short `nosem` marker warns too;
    - npm 6 `audit` output is an error, not "clean";
    - an errored check appears once in the report;
    - the status line uses `council-fix`'s own `blocking` count;
    - doctor's could-not-check path still prints the council section;
    - a `fixVendors` drive test.
13. **Out of scope:**
    - the Efficiency member (see Contract gaps);
    - capturing network traffic at run time;
    - a hard kill (`docker kill`) of the database, because the foundation smoke stops and starts the app and ops cleanly and Conductor never edits the foundation;
    - Security changes beyond the follow-ups (the role-crossing tests reach the council as `verify` test failures);
    - squashing the build branch when a secret is seen (Plan 8 owns that branch; see Contract gaps);
    - live use of the `proxmox` provider.

## Assumptions about Plans 7 and 8 (each built in one place, easy to change)

- **A1 — the hook.** `hooks.council(args) -> { status: 'approved'|'approved-with-warnings'|'blocked'|'paused', text, fix?: { title, instructions }, reason? }` with `args = { projectDir, appDir, sha, brief, policy, runId, slug, team, factory, onEvent }` (Plan 8 Task 9). Built in Task 12.
- **A2 — machines.** `getMachineProvider(factory, { ssh })` from `src/factory/machines/index.js`, where `Machine` has `id`, `runDir` and `release()`. `createSsh()` from `src/factory/ssh.js` gives `exec(machine, script, { timeoutMs })` and `upload(machine, localFile, remotePath, { timeoutMs })`. Both resolve `{ code, stdout, stderr }`, and 255 means SSH failed (Plan 8 Tasks 10–11). Built in Task 5.
- **A3 — checks helpers.** `browsersInstalled({ env, home })` and `testDatabaseProblem({ testCommand: null, env })` from `src/factory/checks.js` (Plan 8 Task 6). Built in Task 4.
- **A4 — member registry.** `MEMBERS` and `membersFor(names)` in `src/council/index.js` (Plan 8 Task 5). This plan adds `design` and `reliability` to `MEMBERS` and exports `PROJECT_COUNCIL = ['security', 'legal', 'correctness', 'design', 'reliability']`. Built in Task 12.
- **A5 — project file and brief.** `loadProject(projectDir)` from `src/factory/project.js` (Plan 7 seam, named in Plan 8), whose `foundation` is `{ repo, tag, commit }`, and `renderBrief(brief)` from `src/factory/brief.js` (Contract 2). Built in Tasks 1 and 12.
- **A6 — the client app keeps the foundation's `notes` example and its fixtures.** The smoke counts `notes` rows and uploads `apps/server/test/fixtures/files/tiny.png`. If they are removed, the smoke fails and Reliability says so plainly.

If any of these lands under another name, change only the import or adapter named in the task.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. `npm test` (`node --test`). The suite stays green at every commit.
- **Tests stub everything external.** No real `npm`, Playwright, browsers, Postgres, axe, `ssh`, `scp`, Docker, Proxmox, machine or model. Tests inject a fake `run` for local commands (Plan 8 style), a fake SSH object and a fake provider through `deps`, fake briefs, and fixture reports. No network beyond `127.0.0.1`.
- **Grading, ceilings and locks per Plan 5.** Every finding goes through `makeFinding`. The interpreter never raises a grade above `maxGrade`, never clears a locked finding, and anything it adds without tool evidence is at most a warning. Grades are exactly `blocking` / `warning` / `note`.
- **Members are independent.** No member reads another's findings. Evidence is gathered before the members, and each reads only its slice. Context and attachments for an interpreter come only from that member's ToolRuns.
- **Fail closed on the run, not on the tools.** A missing or broken tool, machine or script is a ToolRun with status `missing` / `off` / `skipped` / `error` and a plain note, never a crash. The hook returns `paused` only when the reviewer has no participant (Plan 5 Ruling 9). Any other unexpected error becomes `{ status: 'paused', reason }` with a plain sentence, so the build can resume.
- **No secrets, no client data.** Remote output and local tool output go through `redact()` before reaching a finding, event, state or report. Local commands run with the same environment rule as Plan 8's `runAppChecks`. The factory works on demo data only (Contract 1). `notes/` is never read.
- **Nothing is written to `appDir`, the real repo or the foundation repo.** The council workspace is a throwaway clone outside the project folder. It is removed after the round, also on error.
- **Project folder writes are atomic** (temp file, fsync, rename): `council-report.md`, `council-report.json`, `council/state.json` (through `RunLog.saveState`).
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

## Operator Questions (open; the plan builds the defaults shown)

1. **"Not proven" on a client build** (no machine, no browsers, no test database). Default built: a locked warning heading the report, not a block. The alternative is to block until proven.
2. **Serious accessibility problems** (axe `critical`/`serious`). Default built: warning. The spec blocks Design only for broken or unusable layouts.
3. **Time per round.** About 10 minutes of gates locally plus 10–20 minutes of smoke on the machine, on every council round. Default built: everything every round (spec §4.3 "re-runs fully"). The alternative is the smoke only on the first round and the round going to the gate.
4. **The fix-round cap.** Spec §4.3 says council reruns are capped at 3. Plan 8 uses one shared cap, `factory.build.fixRounds` (default 2), for red checks and council fixes together. Default built here: nothing (Plan 8 owns the loop). See Contract gap 5.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/council/findings.js`, `interpret.js`, `report.js`, `tools.js` (modify) | labels, id prefixes, report order, tool labels for the new members and tools | 1 |
| `src/options.js`, `src/council/index.js` (modify) | `councilSmokeTimeoutMs`, `councilGatesTimeoutMs`; `axe` in `councilTools` | 1 |
| `src/council/project.js` | `projectContext`, `acceptanceIds` | 1 |
| `src/council/security.js`, `report.js`, `tools.js`, `findings.js`, `index.js` (modify) | Plan 5 follow-ups | 2 |
| `src/council/councilWorkspace.js` | `openCouncilWorkspace` (a guarded throwaway clone at `sha`, base = foundation commit), `openCouncilLog` | 3 |
| `src/council/gates.js`, `src/council/assets/council.playwright.config.ts`, `src/council/assets/council-a11y.spec.ts` | `detectAxe`, `runGates`, parsers for the step list, vitest, Playwright and axe reports | 4 |
| `src/council/smoke.js`, `src/council/assets/smoke.sh`, `src/council/assets/smoke-clean.sh` | `pushCommit`, `runSmoke`, `parseSmokeLog`, `SMOKE_STEPS` | 5 |
| `src/council/evidence.js` | `collectEvidence` (gates + smoke, cached by commit) | 6 |
| `src/prompts.js`, `src/council/interpret.js` (modify) | brief, policy, measurements and screenshot paths in the interpreter prompt | 7 |
| `src/council/design.js` | `DESIGN` and its checks | 8 |
| `src/council/coverage.js`, `src/council/correctness.js` (modify) | brief coverage, verify, journeys, money | 9 |
| `src/council/dataflow.js`, `src/council/licences.js` (modify) | data-flow and data-policy checks | 10 |
| `src/council/reliability.js` | `RELIABILITY` | 11 |
| `src/council/index.js`, `report.js` (modify), `src/council/reportFile.js`, `src/council/projectCouncil.js` | project round, report sections, `writeCouncilReport`, `runProjectCouncil` (the hook) | 12 |
| `src/cli/main.js`, `src/ui/status.js` (modify) | wire the hook into `conductor build`; council progress lines; doctor; follow-ups | 13 |
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
9. [Correctness for client apps](task-09-correctness.md)
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
- Plan 8 must be merged before Task 5 (it uses `createSsh`) and Task 13. Tasks 1–4 and 6–12 use only injectable `deps` and can be built first.

## Shared Interfaces (all tasks)

```js
// Task 1 — labels and options
MEMBER_LABEL += { design: 'Design', reliability: 'Reliability' }      // src/council/findings.js
ID_PREFIX    += { design: 'D', reliability: 'R' }                     // src/council/interpret.js
ORDER         = [...Plan 5 order, (Plan 8's 'foundation' if present), 'design', 'reliability']   // src/council/report.js
TOOL_LABEL   += { 'page-gate': 'the page check (desktop and phone)', registry: 'the screen list check', axe: 'axe-core (accessibility scanner)',
  'house-style': 'house style check', smoke: 'the reliability test (deploy, backup, restore, alerts, updates)',
  verify: "the foundation's checks (install, lint, types, licences, tests, build)", coverage: 'brief coverage check',
  journeys: 'the user journey tests', money: 'money arithmetic check', 'data-flow': 'outside connections check', 'data-policy': 'data policy check' }
DEFAULT_OPTIONS += { councilGatesTimeoutMs: 2400000, councilSmokeTimeoutMs: 2400000 }
// councilTools also accepts axe: '<path to axe.min.js>' | false (a file, not a binary)

// Task 1 — src/council/project.js
projectContext({ projectDir, appDir, sha, brief, policy, runId, slug }, { loadProject, git } = {}) -> Promise<ProjectContext>
ProjectContext = { slug, runId, projectDir, appDir, sha, buildDir, brief, policy, client, foundation: { repo, tag, commit }, problem: string | null }
  // Task 12 adds: factory (the hook's factory config), deps (injected services), briefText (renderBrief(brief))
acceptanceIds(brief) -> [{ id: 'feature-id#n', featureId, n, title, example: { given, when, then } }]

// Task 3 — src/council/councilWorkspace.js
openCouncilWorkspace({ appDir, sha, foundation, runId, baseDir }) -> Promise<{ ws: Workspace, baseSha, problem: string | null, remove(): void }>
openCouncilLog(buildDir, { onEvent }) -> { log: RunLog, state }    // state from <buildDir>/council/state.json, or fresh

// Task 4 — src/council/gates.js
detectAxe({ options, env }) -> { path, version, status: 'ok' | 'missing' | 'off' | 'error', note }
runGates({ dir, axe, options, env, run = runCommand, home }) -> Promise<GatesResult | { problem: string }>
GatesResult = { steps: { 'npm-ci', lint, typecheck, licences, vitest, build, browser: number | null },
  tests: TestCase[] | null, browser: BrowserCase[] | null, a11y: A11yPage[] | null, crossing: { routes, checks, failures: string[] } | null,
  screenshots: [{ page, project, file }],      // file relative to dir (reports/screenshots/…)
  logs: { [step]: string }, axe: detectAxe result, note: string | null }
TestCase    = { file, title, status: 'passed' | 'failed' | 'skipped' | 'todo', message }
BrowserCase = { file, title, project, ok, skipped, message }
A11yPage    = { page, project, violations: [{ id, impact, help, nodes, target }] }
parseSteps(text), parseVitestJson(text), parsePlaywrightJson(text), parseA11yLines(text)

// Task 5 — src/council/smoke.js
pushCommit({ ssh, machine, dir, sha, remoteDir, timeoutMs }) -> Promise<void>       // throws SmokeError (plain message)
runSmoke({ ssh, machine, remoteDir, timeoutMs }) -> Promise<SmokeResult>
SmokeResult = { ran, passed, refused: string | null, failedStep: string | null, failure: string | null,
                steps: [{ n, title, ok }], tail: string, timedOut: boolean }
parseSmokeLog(text, code, { timedOut = false } = {}) -> SmokeResult
SMOKE_STEPS = { '1': 'build the app images', …, secrets: 'no secret in the alerts or logs', '10': 'tear down' }
cleanSmoke({ ssh, machine, remoteDir }) -> Promise<string | null>                     // null, or a plain problem

// Task 6 — src/council/evidence.js
collectEvidence(ctx, { project, head, round, deps }) -> Promise<Evidence>
Evidence = { gates: GatesResult | null, gatesNote: string | null,
             smoke: SmokeResult | null, smokeStatus: 'ran' | 'missing' | 'off' | 'error', smokeNote: string | null, machine: string | null,
             shotsDir: string | null }       // builds/<runId>/council/round-<N>/screenshots
state.council.evidence = { sha, value: Evidence }
event 'council-evidence' { stage: 'cached' | 'gates' | 'acquire' | 'push' | 'smoke' | 'cleanup' | 'release', status: 'start' | 'ok' | 'error', machine }

// Task 7 — prompts and interpreter
ToolRun.context?: string; ToolRun.attach?: string[]      // attach: paths relative to the council workspace
prompts.councilMember({ …, briefText = null, policy = null, context = [], attachments = [] })
POLICY_LINES(policy) -> string
interpretMember(ctx, { …, context = [], attach = [] })
CouncilInput gains: project, brief, briefText, policy, evidence     // all null on ordinary repos

// Tasks 8–11 — members
DESIGN      = { member: 'design', label: 'Design', alwaysInterpret: true, collect }          // src/council/design.js; also WIDTH
RELIABILITY = { member: 'reliability', label: 'Reliability', alwaysInterpret: false, collect } // src/council/reliability.js
CORRECTNESS.collect / LEGAL.collect: Plan 5 output when input.brief == null

// Task 12
PROJECT_COUNCIL = ['security', 'legal', 'correctness', 'design', 'reliability']; MEMBERS gains design, reliability
runCouncilRound(ctx, { files, tests, diff, members, env, project = null })
CouncilReport gains (project rounds only): checked: string[], coverage: { proven, total } | null, files: { md, json, screenshots } | null
writeCouncilReport(buildDir, report) -> Promise<{ md, json }>; writeAtomic(file, text)    // src/council/reportFile.js
runProjectCouncil(args, { team?, options = {}, deps = {} }) -> Promise<{ status, text, fix?, reason? }>   // src/council/projectCouncil.js
  // args as A1; deps: { loadProject, renderBrief, getMachineProvider, createSsh, run, now, baseDir }
event 'council-report-saved' { md }
```

## Contract gaps found while writing this plan (reported; the roadmap is not edited)

1. **Contract 6 does not say how the council is called on a project.** Plan 8 answers it with `hooks.council` (args and result in Plan 8 Task 9), and this plan follows that. The roadmap should name the hook as the Contract 6 entry point, replacing "the council gets `input.brief` and `input.policy`".
2. **No link from a worked example to its test in Contract 2.** Plan 8 fixed `[<featureId>#<n>]` (Plan 8 Ruling 3), and this plan uses it. The roadmap should record it in Contract 2, because Plan 11 (change requests) and Plan 12 need it too.
3. **Contract 3 has no exec/copy helper and no remote folder.** Plan 8 added `createSsh` and `Machine.runDir` / `composeProject`. The roadmap's `Machine` shape is out of date, and should gain those fields plus `ssh.knownHostsFile` / `hostKeyPolicy`.
4. **The hook gets no evidence from Plan 8's whole-app checks.** Plan 8 runs `verify` and the browser gate just before calling the hook, but passes neither the result nor its reports. Its output has no machine-readable test list either. So this plan runs the gates again with JSON reporters (about 10 minutes per round). Fix: Plan 8's `runAppChecks` adds the vitest JSON reporter and Playwright's JSON reporter, and passes `checks` (with report paths) in the hook's arguments. Then Task 6 can use them for the same `sha` instead of running again.
5. **Fix-round cap.** Spec §4.3 caps council reruns at 3. Plan 8 shares one cap, `factory.build.fixRounds` (default 2), between red checks and council fixes. Either the roadmap accepts 2 shared rounds, or Plan 8 adds a separate `factory.build.councilFixRounds` (default 3).
6. **A secret seen by the council is not squashed out of history.** Plan 5 combined a run's commits when a possible secret was seen (Plan 5 Ruling 10). On a build, the history lives on Plan 8's `build/<runId>` branch (one squashed commit per feature), so a key added in feature 2 and removed by a council fix stays in feature 2's commit and reaches `main`. The hook's result has no field for it. Fix: the hook returns `secretSeen: true`, and Plan 8 squashes the build branch before the gate.
7. **The foundation smoke breaks two Contract 3 rules.** It hard-codes `/tmp/hf-smoke` and Compose project `hfsmoke`, where Contract 3 wants `hf-<slug>-<runId>`. That is safe only under the `static` provider's host lock. It also **refuses to run where `highland/app` or `highland/ops` images exist**, which Plan 8's previews on the same CT 111 may leave behind. Fix: Plan 8's preview teardown removes its images, or the council uses a different host, or a foundation release adds `HF_SMOKE_PROJECT`/`HF_SMOKE_DIR`. The last is an operator decision, because the factory never edits the foundation.
8. **The smoke depends on the foundation's `notes` example** (A6) and has no hard-kill step (spec §4.3 "kill and restart services"). Removing `notes` from client apps would make Reliability unpassable. A hard kill needs a foundation smoke change.
9. **`policy.outbound` is free text.** Matching needs host or service names. Plan 7 could store `{ service, hosts: [] }` entries.
10. **Unclaimed spec items.** The **Efficiency** member (spec §4.3, advisory) is in no roadmap plan. Spec §4.3 lists the **role-crossing tests** as a Security tool, but Contract 6 leaves Security alone. Here they reach the council only as `verify` test failures (Correctness), and their summary is shown to the Correctness interpreter.
