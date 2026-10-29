# Conductor Plan 5 — Council v1 on the repo flow

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** With `conductor "…" --council`, the finished change gets checked by three independent specialist reviewers (Security, Legal, Correctness) after the final review and before the operator's gate. Blocking problems go back through the normal step loop as fix steps. The council runs again in full after each fix round, at most 3 fix rounds. Anything still stuck becomes a plain-English question to the operator, and the gate shows a council report written for the operator.

**Architecture:**
- **Members.** A council member is a plain object `{ member, label, alwaysInterpret, collect(input) }`.
  - `collect` runs the member's deterministic checks: external CLIs found at runtime, plus checks Conductor does itself (lockfile licences, test results, changed-file rules). It returns `ToolRun[]`, each with `Finding[]` graded by the tool.
  - An LLM interpreter then reads only that member's findings. The prompt goes to the team's **reviewer** seat, which is the other vendor from the author. The reply is a JSON block that can keep, regrade or set aside each finding, explain it and propose a fix, and add findings the tools missed.
  - **Code, not the LLM, enforces the rules.** Locked findings cannot be set aside or downgraded. Every finding carries a ceiling (`maxGrade`) set when it is made: only the Ruling 6 cases can ever be blocking, and a finding without tool evidence, or one that was already there before this change, can be at most a warning. The LLM can lower a grade or raise it up to that ceiling, never above.
- **Round.** `runCouncilRound` runs the members one after another. Each prompt carries only that member's evidence, so members never see each other's verdicts. The round then builds a `CouncilReport` (verdict, blocking/warning/note lists, resolved items, checks that did not run, plain text) and saves the round in `state.council`.
- **Bounce-back.** In `drive`, the chunks phase and the final phase become one loop. When a round is `blocked` and fix rounds remain, a fix chunk (`Council fixes, round N`) is appended to `state.plan.chunks` and the phase goes back to `chunks`. The fix then runs through the existing local → frontier → chunk review loop, and the final review plus a full council round run again. When the cap is reached, `askUser` escalates (kind `council`). Approve → gate with the report marked overridden; reject → `stopped`.
- **UI.** New `council-*` events feed `StatusModel` (a council line, fix steps appended to the step list). The report text is added to the gate summary. `--council` turns it on, and `conductor doctor` lists which council tools are installed.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`, `git` CLI. Optional external CLIs, detected on `PATH` at runtime and never installed by Conductor: `semgrep`, `gitleaks`, `npm` (for `npm audit`), `scancode`.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §4.3: council members, rules, bounce-back, report;
- §5a: licence rule;
- §7: constraints;
- §8 item 2: council v1 on today's flow, opt-in, after the final review, members cut down on a repo with no brief.

The MVP spec (`2026-10-18-conductor-mvp-design.md`) still governs everything this plan does not change.

Plans 1–3 are merged (master at or after `2f61dbd`) and provide:
- `runTask`/`resume`/`drive` with hooks;
- `reviewLoop`, `runChunk`, `callAgent`, `noteSameVendor`, `askUser`;
- `RunLog` events;
- `StatusModel` and the terminal;
- `buildSummary`, `redact`, `runCommand`/`strictChildEnv`, `Workspace.filesRange`/`diffRange`/`runTests`.

Plan 4 (wake workers, factory phase 1, `docs/superpowers/plans/2026-10-25-conductor-wake-workers/`) may land first. It also edits:
- `src/options.js`, `src/conductor.js` and `src/cli/main.js`;
- `src/ui/terminal.js` and `README.md`;
- and possibly `src/cli/args.js`.

Rebase on master and merge those edits by hand: both plans only add options, flags and branches. Nothing here depends on Plan 4.

## Rulings made while scoping (decided, not open)

1. **Opt-in.** `DEFAULT_OPTIONS.council = false`. Turn it on with `--council` or `"options": { "council": true }` in a project's `conductor.json`. Why: spec §8 item 2 [call]. Existing runs don't pay for it.
2. **"3 rounds" means 3 fix rounds.** `councilFixRounds: 3`, so the council can run at most 4 times: the first review plus a full re-run after each of 3 fixes. Then the operator is asked. Why: spec §4.3 "the council re-runs fully after each fix … capped at 3 rounds". `0` is allowed (no bounce-back: blocking goes straight to the operator).
3. **The final review re-runs with the council after each fix.** Fixes are new commits, and what the operator approves must have been reviewed. Why: MVP gate rule "what the user approves is exactly approvedSha".
4. **One fix chunk per round**, containing every blocking finding with its tool evidence and the suggested fix. It runs through `runChunk` unchanged (local first, frontier fallback, cross-vendor chunk review). Why: "bounce back as fix tasks through the existing loop", and the chunk loop already handles escalation, pause and resume.
5. **What already existed doesn't block (repo flow only).** A finding is marked `preExisting` and capped at **warning**, with "already there before this change", when it is about something this run did not introduce:
   - **Semgrep and Gitleaks results:** judged per **line**, not per file. A result counts as introduced only when one of its lines was added by this change (`git diff -U0 baseSha..HEAD`). An old `eval` in a file the run merely touched is still "already there".
   - **Dependencies** (npm audit, licences): a package whose `name@version` this run did not add or change (lockfile delta).
   - **Failing tests:** when the test command fails on the finished change, the council runs it once on the starting commit (a temporary checkout inside the workspace, put back straight after; the answer is saved in `state.council.baseTests`). A suite that already failed there is a **locked warning** ("they already failed before this change"), not a block, because Conductor cannot tell old failures from new ones.

   Why: on ordinary repos the council would otherwise send the fixers off to rewrite unrelated code, or burn every fix round on a suite that was already red. Spec §4.8's whole-app review is a factory-phase concern. Limit: a change that moves or re-indents an old problem line counts as introducing it. **The operator should know this** (see Operator Questions).
6. **Who can block:**

   | Member | Tool evidence (source of truth) | Blocks when | Locked (LLM cannot clear) |
   |---|---|---|---|
   | Security | Semgrep `ERROR` results; Gitleaks hits; `npm audit` high/critical; scanner-settings files touched | introduced by this run and still kept after interpretation | the scanner-settings warning |
   | Legal | lockfile licence of each **introduced, non-dev** package that is copyleft, unknown or missing (§5a); ScanCode copyleft match in a changed file | always for the lockfile facts; ScanCode matches can be set aside as false alarms | lockfile licence facts. Only `councilAcceptLicences` clears one |
   | Correctness | the test command failing | always | test failure |

   Everything else is at most a warning, **and the interpreter cannot raise it higher**: each finding's ceiling (`maxGrade`) is the grade its tool gave it when that grade is blocking, otherwise warning. So a dev-only non-permissive dependency, the "adds or edits no tests" check, a Semgrep `WARNING`/`INFO`, a moderate or low `npm audit` result and an unrecognised ScanCode match can never become a fix round. The interpreter can still set aside (unless locked) or lower a blocking finding. Dev-only dependencies with a non-permissive licence are warnings, because they are not shipped.
   - **Lockfile details.** A v1 lockfile (no `packages` section) records no licences: the licence check is skipped with a note asking the operator to upgrade the lockfile, rather than calling every package unlicensed. `link: true` entries and workspace packages (keys outside `node_modules/`) are the project's own code and are skipped. `devOptional: true` stays **shipped**: npm sets it on a package that is also an optional dependency of a production dependency, so it can be installed in production.
   - **Accepting.** `councilAcceptLicences` takes licence ids (`"LGPL-3.0-only"`) and, for one specific package, `name@version` (`"left-pad@1.3.0"`, `"@scope/pkg@0.1.0"`). A `name@version` entry clears that package whatever its licence, including a missing or unrecognised one.
7. **The interpreter seat is `team.reviewer`** for all three members: different vendor from the author when two vendors are healthy. Same-vendor use goes through `noteSameVendor` (phase `council`), so the existing summary warning covers it. It is checked against the author's vendor **and** against every vendor that wrote a council fix step (`state.council.fixVendors`, recorded by `drive` from `runChunk`'s new `vendor`), because a fix step at an odd index falls back to the reviewer's vendor when the local model fails. **No LLM call when a member's tools found nothing**, unless the member is Correctness, which always checks the request. Why: spec §7 "as few frontier tokens as possible".
8. **Tools are optional and detected at runtime.**
   - Not installed → status `missing` with an install hint, shown under "Checks that did not run". This is never a failure.
   - Installed but it crashes, times out or prints garbage → status `error` with a **warning** finding.
   - `councilTools: { name: false }` turns a tool off; `councilTools: { name: "/path" }` points at a binary that is not on `PATH`.
   - Tools run with `strictChildEnv` (no credentials).
9. **Fail closed on the interpreter, not on the tools.** If the interpreter call fails or replies with something unparseable, the tool findings stand exactly as graded, plus a note saying so. A `no-participant` failure pauses the run, as the final review does.
10. **Conductor never copies a secret it finds, and never lands one in history.**
    - Gitleaks runs with `--redact`, and its `Secret`/`Match` fields are never read.
    - A file with a possible secret introduced by this change is hidden from the diff in every later council prompt.
    - Every finding goes through `redact()` when it is made, and every prompt, event and state write is redacted as today.
    - **History.** Each step is its own commit and `land()` fetches the whole run branch, so a secret removed by a fix step would still sit in the earlier step's commit. Once any council round has seen a possible secret introduced by this change (`state.council.secretSeen`), `drive` **combines the run's commits into one commit on `baseSha`** (`ws.squashSince`) before the gate, checks the tree is byte-for-byte the same, and the gate approves and lands that commit. The summary says so in a note. Pinned by a drive test (`rev-list --count` is 1 and `git log -p` holds no key).
    - Limits (stated, not fixed in v1):
      - the AI members can still read workspace files;
      - the Plan 3 final review, the chunk review of the step that added the secret and the chunk review of the fix step (whose diff shows the removed `-` line) have seen it; the transcript's `call` event keeps the first 1000 characters of each prompt and may hold it. Hiding it there would mean changing the chunk loop and the MVP transcript, which this plan does not do;
      - Gitleaks scans the finished tree only (`--no-git`), so a secret added in one step and removed in a later step **before** the council runs is not detected, and its commit is not combined.
11. **Semgrep uses `--config p/default --metrics=off`.** `--config auto` needs metrics on, and that sends data to Semgrep. `p/default` downloads registry rules but uploads no code. The operator can point `councilSemgrepConfig` at a local rules file to run fully offline.
12. **Out of scope for v1:**
    - the design, reliability and efficiency members;
    - the brief and data policy, and the data-flow check;
    - role-crossing tests;
    - dependency checks for anything but npm lockfiles;
    - parallel members;
    - remote client previews.

## Global Constraints

- Node ≥ 20, ESM (`"type": "module"`), **no npm dependencies**. Tests run with `npm test` (`node --test`). Tests never make network calls outside `127.0.0.1`. **Tests never run a real `semgrep`, `gitleaks`, `npm audit` or `scancode`.** Every council test sets `councilTools` to stubs or `false`.
- **Real repository:** never modified except by `land()`, which only creates a **new** branch. The council does not edit the change: tools run read-only, the interpreter runs with `write: false`, and only fix chunks edit. Two workspace operations are allowed, both leaving the files exactly as approved: the one-off test run on the starting commit (Ruling 5, reset straight back to the change) and combining the commits when a secret was seen (Ruling 10, same tree checked).
- **Credentials:** no credential value appears in prompts, transcripts, state, findings, reports, terminal output or test output. Tools run with `strictChildEnv`.
- **Fail closed:**
  - only `approveResult` returning exactly `true` lands;
  - a council escalation answered anything but `approve` stops the run;
  - an interpreter failure never removes or downgrades a tool finding.
- **Rules from spec §4.3, enforced in code:**
  - members are independent and never see each other's findings;
  - a finding without tool evidence may only warn;
  - grades are exactly `blocking` / `warning` / `note`.
- **Plain English:** the report, the escalation and the status line speak to the operator, not as a scanner dump: member name, what is wrong, why it matters, where. No stack traces, no raw JSON.
- **Licence rule (§5a), verbatim:** "shipped apps use only permissively licensed dependencies (for example MIT, Apache-2.0, BSD, ISC). GPL, AGPL and other copyleft licences are a **blocking** finding for the Legal/data member, unless the operator explicitly accepts one for a specific project. Unknown or missing licences are also blocking."
- **Reuse:** existing events and behaviour stay as they are with the council off. The existing suite (405 tests at `2f61dbd`, more if Plan 4 has landed) stays green at every commit. Only two tasks edit existing assertions: Task 7 (the `runChunk` "changed nothing" `deepEqual` in `test/chunkPhase.test.js` gains `vendor: 'local'`) and Task 9 (the two `parseCli` flag `deepEqual`s gain `council`).

## Review Focus

1. **A council tool that is installed but broken** (crashes, prints a banner instead of JSON, hangs):
   - the run carries on;
   - the check shows as "did not finish" with a warning;
   - nothing blocks or crashes because of it.
   Pinned in Task 1 (`runTool`) and Task 7 (end to end).
2. **A repo with old problems the change didn't introduce** (an old `eval` in an untouched file or on an untouched line of an edited file, an old vulnerable or GPL dependency, a test suite that was already red):
   - they show as warnings marked "already there before this change";
   - the same holds for an old problem line in a file the change **did** touch, and for a test suite that already failed at the starting commit;
   - no fix chunk is created for them.
   Pinned in Tasks 2, 3, 4, 6 and 7.
3. **The interpreter tries to bend the rules**:
   - setting aside a failing test or a lockfile licence fact;
   - blocking with no tool evidence;
   - raising a tool's warning (a Semgrep `WARNING`, a dev-only licence, the "no tests" check) to blocking;
   - replying with prose or broken JSON.
   The code holds the line, and the tool findings stand. Pinned in Task 5.
4. **Ctrl-C or pause in the middle of the council, or after a fix chunk was queued:**
   - `conductor resume` runs the queued fix step, then the council again;
   - the fix-round count is **not** reset, so the cap still holds;
   - a crash after a round was saved but before its fix step was queued (or during the council escalation) re-runs that round **with the same number**, replacing its history entry rather than adding one. A round is the same round when the reviewed `sha` and `fixRounds` match the last history entry.
   Pinned in Tasks 6 and 7.
5. **A real secret in the change:**
   - the Gitleaks hit blocks;
   - Conductor never copies the value into a council prompt (the file is hidden from the diff), a council event, the report or the fix step;
   - after the fix, the landed branch is one commit, so the secret is not in your repository's history either (Ruling 10, with its stated limits).
   Pinned in Tasks 2, 6 and 7.

## Operator Questions (open; the plan builds the defaults shown)

1. **Ruling 5 vs spec §5a.** On ordinary repos, problems that were already there before the change only warn, including an existing GPL or unlicensed dependency. §5a otherwise makes copyleft and unknown licences blocking without exception. Default built: they warn.
2. **Licence list** (spec §5a, pending a solicitor's check). Default built: CC-BY-3.0/4.0, Python-2.0 and BSL-1.0 count as permissive; MPL-2.0 and LGPL count as copyleft and block.
3. **A dependency with no licence at all.** Default built: the operator can accept that one package per project with `name@version` in `councilAcceptLicences`. The alternative is that it always comes to the operator as an escalation (drop the `name@version` form).

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/options.js` (modify) | council options | 1 |
| `src/council/findings.js` | `GRADES`, `MEMBER_LABEL`, `makeFinding`, `clampGrade`, `findingKey`, `tally` | 1 |
| `src/council/tools.js` | `findBin`, `resolveTool`, `runTool` → `ToolRun` | 1 |
| `src/council/lockfile.js` | `lockPackages`, `readLock`, `lockDelta` | 2 |
| `src/council/security.js` | Semgrep/Gitleaks/npm audit parsers, scanner-settings check, `SECURITY` member | 2 |
| `src/council/licences.js` | `classifyLicence`, `licenceFindings`, `parseScancode`, `LEGAL` member | 3 |
| `src/council/correctness.js` | `testFindings`, `testFilesFinding`, `CORRECTNESS` member | 4 |
| `src/prompts.js` (modify) | `councilMember` prompt | 5 |
| `src/council/interpret.js` | `parseInterpretation`, `applyInterpretation`, `interpretMember` | 5 |
| `src/council/report.js` | `councilVerdict`, `buildReport`, `reportText`, `fixChunk` | 6 |
| `src/council/index.js` | `MEMBERS_V1`, `runCouncilRound`, `validateCouncilOptions`, `councilToolStatus` | 6 |
| `src/conductor.js`, `src/escalation.js`, `src/chunkPhase.js` (modify) | the bounce-back loop, escalation, combining commits after a secret, gate summary; `runChunk` reports the fix step's vendor | 7 |
| `test/helpers/councilStubs.js` | stub council CLIs for tests | 2 (used by 3, 7) |
| `src/ui/status.js` (modify) | council line, fix steps, final "reviewed" | 8 |
| `src/cli/args.js`, `src/cli/main.js` (modify) | `--council`, doctor's council tool list | 9 |
| `README.md`, `config.example.json`, `spikes/council-smoke/` | docs and an operator-run smoke | 10 |

## Tasks

1. [Options, findings & tool runner](task-01-findings-tools.md)
2. [Security member](task-02-security.md)
3. [Legal member (licences)](task-03-legal.md)
4. [Correctness member](task-04-correctness.md)
5. [LLM interpreter](task-05-interpreter.md)
6. [Council round & report](task-06-round-report.md)
7. [Bounce-back loop, escalation & gate](task-07-drive.md)
8. [Status view](task-08-status.md)
9. [`--council` and doctor](task-09-cli.md)
10. [Docs & operator council smoke](task-10-docs-smoke.md)

Order matters:
- 2–4 need 1; 3 also reuses Task 2's lockfile module and stub helper;
- 5 needs 1;
- 6 needs 2–5;
- 7 needs 6;
- 8 needs 7's events;
- 9 needs 6;
- 10 needs all.

## Shared Interfaces (all tasks)

```js
// Task 1 — src/options.js (DEFAULT_OPTIONS gains)
council: false, councilFixRounds: 3, councilToolTimeoutMs: 600000,
councilTools: Object.freeze({}), councilAcceptLicences: Object.freeze([]), councilSemgrepConfig: 'p/default'

// Task 1 — src/council/findings.js
GRADES = ['blocking', 'warning', 'note']
MEMBER_LABEL = { security: 'Security', legal: 'Legal', correctness: 'Correctness' }
makeFinding({ member, tool = null, grade, maxGrade = grade === 'blocking' ? 'blocking' : 'warning', title, detail = '', file = null, line = null, evidence = tool != null, locked = false, preExisting = false })
  -> Finding { member, tool, grade, maxGrade, title, detail, file, line, evidence, locked, preExisting, dismissed: false, why: null, fix: null }
  // maxGrade (the ceiling) = clampGrade(maxGrade, (!evidence || preExisting) ? 'warning' : 'blocking'); grade = clampGrade(grade, maxGrade)
  // so only findings their tool graded blocking can ever block; title/detail redacted then clipped (200 / 2000)
clampGrade(grade, max) -> grade            // only ever lowers
findingKey(f) -> 'member|tool-or-ai|file|title'
tally(findings) -> { blocking, warning, note }   // dismissed findings not counted

// Task 1 — src/council/tools.js
findBin(bin, { env = process.env } = {}) -> string | null
resolveTool(name, bin, { options, env }) -> { path: string | null, off: boolean }
runTool({ member, name, label, bin, args, cwd, options, env = process.env, parse, install = '' }) -> Promise<ToolRun>
  // ToolRun { tool: name, label, status: 'ran' | 'missing' | 'off' | 'skipped' | 'error', findings: Finding[], note: string | null }
  // args may contain '{report}': replaced by a temp file path; parse then gets that file's text instead of stdout
  // parse(text, { code, stderr }) -> Finding[]; a throw = status 'error'
skipped(member, name, label, note) -> ToolRun   // status 'skipped'
TOOL_LABEL = { semgrep: 'Semgrep (code scanner)', gitleaks: 'Gitleaks (secret scanner)', 'npm-audit': 'npm audit (dependency security check)',
               scancode: 'ScanCode (licence scanner)', licences: 'dependency licence check', settings: 'scanner settings check',
               tests: 'the test command', 'test-files': 'test coverage check' }

// CouncilInput (built by Task 6, consumed by every member's collect)
{ dir, files: string[], changed: Set<string>, added: Map<string, Set<number>> | null, baseSha, tests, baseTests, options, env, request, plan, diff }
  // added: lines added by this change per file (null = unknown: a whole changed file counts as introduced)
  // baseTests: { ran, passed, code } of the test command at baseSha, or null when not needed

// Member (Tasks 2–4)
{ member: 'security'|'legal'|'correctness', label, alwaysInterpret: boolean, collect(input) -> Promise<ToolRun[]> }
SECURITY (src/council/security.js), LEGAL (src/council/licences.js), CORRECTNESS (src/council/correctness.js)

// Task 2 — src/council/lockfile.js
lockPackages(lock) -> [{ name, version, license, dev }]
hasLicenceData(lock) -> boolean                  // false for a v1 lockfile (no `packages`)
readLock(dir, sha = null) -> Promise<object | null>
lockDelta(basePkgs, headPkgs) -> Set<name>

// Task 2 — src/council/security.js (also used by Task 6)
unquoteGitPath(s) -> string                      // git's C-quoted path form ("a/x\303\251") → the real path
addedLines(unifiedDiffU0) -> Map<file, Set<line>>
isIntroduced({ changed, added }, file, start, end = start) -> boolean

// Task 5
prompts.councilMember({ member, label, request, plan, diff, base, tests, items, notes }) -> string
parseInterpretation(text) -> { ok: true, findings: [{ id, decision, grade, why, fix }], extra: [{ title, why, grade, file }] } | { ok: false, error }
applyInterpretation(findings, ids, reply, { member }) -> Finding[]
interpretMember(ctx, { member, label, findings, notes, input }) -> Promise<{ status: 'ok', findings, by, interpreted } | { status: 'paused', reason }>

// Task 6
councilVerdict(findings) -> 'blocked' | 'approved-with-warnings' | 'approved'
buildReport({ round, findings, toolRuns, by, history = [], overridden = false })
  -> CouncilReport { round, verdict, blocking, warnings, notes, dismissed, resolved: string[], toolNotes: string[], by, overridden, text }
reportText(report) -> string
fixChunk(report, fixRound) -> { title: `Council fixes, round ${fixRound}`, instructions, councilFix: fixRound }
MEMBERS_V1 = [SECURITY, LEGAL, CORRECTNESS]
hideFiles(diff, files: Set<string>) -> string
runCouncilRound(ctx, { files, tests, diff, members = MEMBERS_V1, env = process.env }) -> Promise<{ status: 'ok', report } | { status: 'paused', reason }>
validateCouncilOptions(options)   // throws plain-English errors
councilToolStatus({ options, env }) -> [{ tool, label, ok, why }]
state.council = { round, fixRounds, secretSeen, history: [{ round, sha, fixRounds, blocking: [{ key, title, member }] }],
                  baseTests?, fixVendors?, squashedAt? }
events:
  'council-start' { round, members }
  'council-member' { member, stage: 'tools' | 'interpreting' }
  'council-tool' { member, tool, status, findings }
  'council-member-done' { member, blocking, warning, note, by, interpreted }
  'council-finding' { member, tool, grade, title, file, line, preExisting, dismissed }
  'council-verdict' { round, verdict, blocking, warning, note }
  'council-base-tests' { passed, code }

// Task 7
event 'council-fix' { round, title, blocking }
event 'council-squash' { from, to, steps }
fixChunk(...) also carries councilFix: fixRound   // marks a fix step in state.plan.chunks
runChunk(...) 'done' result gains vendor          // the vendor that wrote the step (or 'local')
escalation kind 'council', situation 'stuck'
buildSummary({ …, council = null })                    // council: report text, after warnings, before Notes
approveResult arg gains council: CouncilReport | null

// Task 9
parseCli flags gain council: boolean
```
