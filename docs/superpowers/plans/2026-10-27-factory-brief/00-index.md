# Conductor Plan 7 — Brief intake (factory phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** The operator turns a client's meeting notes into an approved, versioned, machine-checkable brief. He runs `conductor project new "<client>"`, then `conductor brief <slug> --notes <file>`. A frontier author drafts the brief and asks him plain-English questions one at a time until nothing important is guessed. He reads the rendered Markdown and approves it. Conductor writes `brief/brief-vN.json`, `brief/brief-vN.md` and `brief/current.json`, and Plans 8–12 build from that.

**Architecture:**
- **Project folder** (roadmap Contract 1, extended by Contract 7 §7.5). `src/factory/projects.js` creates, loads and saves `<projectsRoot>/<slug>/project.json` (with `approved: null` and `builtFromBrief: null` at creation) plus the `brief/`, `notes/`, `builds/` and `deployments/` folders. Every write goes through `src/factory/fsAtomic.js`: temp file, fsync, rename, fsync the folder. `projectsRoot` and `operatorName` come from `factoryConfig` in `src/factory/config.js` (env `CONDUCTOR_PROJECTS_ROOT` > config `factory.projectsRoot` > `~/highland-projects`); `loadConfig` now keeps the `factory` section. Project commands work without a participants config. `src/factory/projectLock.js` gives one lock per project, shared by briefs, builds and changes.
- **The brief** (Contract 2). `src/factory/brief.js` owns the schema:
  - `normalizeBrief` turns untrusted model JSON into a brief: known keys only, control and bidi characters stripped, lengths and list sizes capped, approval fields dropped;
  - `validateBrief` returns plain-English problems at three stages (`draft` / `ready` / `approved`);
  - `renderBrief` produces UK-English Markdown;
  - `saveApprovedBrief` writes a new version exclusively (it never overwrites one), then moves the `current.json` pointer, which carries a sha256;
  - `loadBrief` follows the pointer, checks the fingerprint and validates at `approved`.

  The concreteness rules for worked examples live in `src/factory/acceptance.js`, so the validator and the author prompt quote the same rules. The same module stamps example ids (`<featureId>#<n>`) at approval and exports the shared readers `acceptanceIds` and `testTag`. `src/factory/outbound.js` holds the fixed list of outside services (`OUTBOUND_SERVICES`) that `policy.outbound` and `integrations[].service` must name by id.
- **The session.** `src/factory/briefSession.js` keeps the in-progress state in `brief/session.json`, saved atomically after every model reply and every answer, so Ctrl-C loses nothing. It also copies the notes verbatim into `notes/` and writes `brief/draft.md`. The CLI holds the project lock (`lockProject(dir, 'brief')`) for the whole sitting. `src/factory/briefRun.js` runs the state machine `draft → questions → draft … → approve`, with the author seat and a terminal `io` injected. `src/factory/briefPrompts.js` builds the one author prompt and parses the reply defensively.
- **CLI.** `src/cli/args.js` gains `project new|list|show` and `brief`. `src/cli/factory.js` exports the `FACTORY_COMMANDS` table and `runFactoryCommand`; `src/cli/main.js` sends any command in that table there **before** the "inside a git repository" check (Contract 7 §7.3). Later plans only add table entries. The brief command:
  - builds a **frontier-only author seat** (`src/factory/briefTeam.js`: subscriptions, plus paid API only when `routing.allowApi` is true; never a `local-agent`);
  - skips worker wake/readiness, because the local model is not used;
  - fails closed without a TTY **before** reading the notes or calling any model.

  `src/ui/terminal.js` gains `askBriefQuestion`, `approveBrief` and `confirmDiscard`.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`. Nothing new.

**Spec:** `docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §1: the operator is the only user and never reads code, so plain English throughout;
- §3: anti-goals, especially client data leaving where the policy allows and surprise paid-API bills;
- §4.1: brief intake, follow-up questions "until nothing important is guessed", acceptance examples **[call]**;
- §4.6: operator access, which is required, and the backup destination;
- §6: the data policy profile;
- §7: client data never goes to the factory's models;
- §9: unsupported kinds are refused.

**Binding contracts:** `docs/superpowers/plans/2026-10-27-factory-phases-4-9-roadmap.md`. This plan implements Contract 1 (project folder), Contract 2 (brief and `src/factory/brief.js` exports), the Plan 7 rows of Contract 5 (commands) and the Plan 7 parts of **Contract 7** (library seams), plus the cross-cutting rules. Where an earlier draft of this plan disagreed with Contract 7, Contract 7 won; see "Contract 7 alignment" below.

Plans 1–6 are merged. Master is at or after `e3b3e6a`, with 570 tests at the time of writing. They provide:
- `Participant`, `Seat`, `HealthBoard`, `checkHealth`, `callRole`, `RunLog`;
- `redact`, `childEnv`, `killAllChildren`;
- `createTerminal`, `parseCli`, `findConfig` and `loadConfig`;
- the test helpers `fakeParticipant` and `writeStubCli`.

## Contract 7 alignment

Plan 7 owns, and builds here with tests: `fsAtomic.js`, `config.js` (`factoryConfig`; replaces the draft's `settings.js`/`factorySettings`), the `loadConfig` change, `projects.js` (with `loadProject` and `saveProject`), `projectLock.js` (`lockProject`; replaces the draft's `acquireBriefLock`), `acceptance.js` (with `acceptanceIds` and `testTag`), `outbound.js` and `src/cli/factory.js` (`FACTORY_COMMANDS`, `runFactoryCommand`). It also builds the §7.4 brief additions and the §7.5 project file.

Small additions beyond the exact Contract 7 names. None changes a Contract 7 signature:
- `assignExampleIds(brief, base)` and `EXAMPLE_ID_RE` in `acceptance.js`, and the brief meta field `exampleSeq`, which are how "an `n` is never reused" is kept;
- `integrations[].service` (an `OUTBOUND_SERVICES` id), so integrations are matched on ids rather than names;
- optional test seams: `factoryConfig`'s `user` option and `lockProject`'s third argument `{ pid, isAlive, now }`;
- `FactoryContext` (`ctx`), the object `runFactoryCommand` hands every handler, so Plans 8, 10 and 11 get `ctx.factory` and `ctx.configPath` without re-reading the config.

Still open (Contract 7 does not settle these):
- `factoryConfig` reads only the `factory` key, and project commands read it straight from the config file without `loadConfig`, because `loadConfig` refuses a config with no `participants`. Later plans whose commands need participants must call `loadConfig(ctx.configPath)` themselves.
- `OUTBOUND_SERVICES` has no ids yet for email delivery, Matrix alerts or backup storage. Per Plan 9, the foundation's own destinations are set per deployment, not in the brief. A plan that wants them in `policy.outbound` adds the ids.

## Rulings made while scoping (decided, not open)

1. **Questions are asked one at a time, in batches per round.** Each author reply carries its open questions, at most 5, most important first. The terminal asks them one by one, each answer is saved as it is typed, and only then does the author redraft with all answers. The alternative was one frontier call per answer, which is slower and dearer for the same result. Why: spec §4.1 says "asks … until nothing important is guessed", and the operator asked for one question at a time.
2. **The operator is the brief's reviewer. There is no cross-vendor model review of the brief.** The checks are the deterministic validator plus his approval of the rendered Markdown. Why: the brief is a statement of what the client wants, and only the operator knows that. A second model would only add spend.
3. **Raw notes go to the author seat only.** The author seat is built by `briefAuthorSeat`. Its candidates are the healthy subscription CLIs (and paid API only with `routing.allowApi: true`, the existing opt-in), and `assertFrontierSeat` refuses any `local-agent`. The brief command never builds a local seat, never wakes workers and never calls `buildTeam`. Why: the operator's constraint, and Contract 1 ("never shown to models beyond the brief step").
4. **Model output is data.**
   - The reply's last ```json block is parsed, at most 500 000 characters. `normalizeBrief` copies known keys only, so `__proto__` and other unknown keys are dropped.
   - Every string loses C0/C1 control characters (except `\n` and `\t`), ANSI escapes and bidi controls before it reaches the terminal or a file.
   - `approvedAt` and `approvedBy` from a model are always discarded.
   - Nothing in the brief is ever executed, and no field is used as a path. File names come from Conductor: slug, version number, notes stamp.
5. **The brief folder.**
   - `brief/brief-vN.json` and `brief/brief-vN.md` are written once and never overwritten (exclusive create).
   - `brief/current.json` is a **pointer**: `{ schema: 1, version, json, md, sha256, approvedAt, approvedBy }`. `loadBrief` refuses a brief whose sha256 no longer matches.
   - `N` is one more than the highest `brief-v*.json` on disk, so a crash between writing the file and moving the pointer never reuses a number.
   - `draft.md` is the in-progress copy for reading. `logs/transcript.jsonl` is the session's run log, and it stays inside the project folder.
   - The lock is not in `brief/`: it is the project-wide `<project>/.conductor.lock` from `lockProject(dir, 'brief')`, so a brief cannot start while a build or change runs, and the other way round.
6. **Validation stages.**
   - `draft`: policy fields may be `null` and a feature's `acceptance` may be empty, **only while there are open questions**. Every example that is present must already be concrete.
   - `ready` (the default for `validateBrief(obj)`): complete, and no open questions.
   - `approved`: `ready`, plus `slug`, `version`, `approvedAt` and `approvedBy`.

   Draft problems go back to the author automatically, up to 3 tries per round, without bothering the operator.
7. **Concrete examples are checked by rules, not by a model** (`acceptance.js`):
   - each of `given`, `when` and `then` is at least 8 characters;
   - no placeholders (TBD, TBC, TODO, etc, "and so on", `...`, `…`, `??`, lorem ipsum, xxx);
   - `then` holds an **anchor**: a digit, quoted text, a capitalised name that does not start a sentence, or a month or weekday;
   - `then` has no vague-outcome phrase ("works correctly", "as expected", "is handled", "behaves properly", "successfully processed" …).

   Every rejection says what to write instead.
8. **The data policy uses fixed shapes** (Contract 7 §7.4):
   - `retention: { text, days: integer 1–36500 | null }`;
   - `backupDestination: { kind: 'client-owned'|'operator-run'|'cloud-bucket', detail }`; `detail` is never a credential;
   - `operatorAccess` must be literally `true`;
   - `outbound` is a list of **ids** from `OUTBOUND_SERVICES` (seeded with `cloudflare-tunnel` and `azure-document-intelligence`); an unknown id is a problem;
   - every integration names its `service` (an `OUTBOUND_SERVICES` id), and that id must be in `policy.outbound`. Matching is on ids only, never on names;
   - a `pdf` output needs the `pdf-export` module and an `xlsx` output needs `xlsx-export`;
   - any string that looks like a credential is a problem.

   The author prompt says never to guess a policy field: leave it `null` and ask.
9. **Fields added beyond the Contract 2 minimum:**
   - `roles[].sees` (spec §6 "who can see what", which feeds the role-crossing tests);
   - `records[]` (`{ name, description, holdsFiles, personalData }`), with `features[].data` naming records;
   - `outputs[].roles`;
   - `integrations[].dataSent` and `integrations[].service`;
   - `features[].acceptance[].id` and `exampleSeq` (Ruling 15), stamped by Conductor only;
   - `assumptions[]` (shown to the operator for checking);
   - the meta fields `slug`, `version`, `createdAt` and `revisedFrom`, which Conductor stamps and the model never sets.
10. **Resuming.**
    - `conductor brief <slug>` with no `--notes` carries on with an unfinished session.
    - `--notes` while a session exists is refused, with the two ways forward.
    - `--discard-draft` asks for confirmation, then removes `session.json` and `draft.md`. The notes are kept.
    - The approval write is crash-safe: before writing, the session records `approving: { version }`. A resume that finds `current.json` already at that version with a matching fingerprint just finishes. It never makes a duplicate version.
11. **Limits.**
    - Notes file ≤ 100 000 bytes, UTF-8, no NUL bytes, not blank. A session starts from exactly one notes file. The prompt refuses more than 200 000 characters of notes, which leaves room for later plans to add files.
    - 3 author tries per round and 8 rounds per sitting. A rerun gets fresh budgets, and the saved answers carry over.
    - At most 5 questions per round.
    - If every question in a round is skipped, the sitting stops and those questions are saved to be asked again next time, so the loop cannot spin.
12. **Project status.** `project new` sets `briefing`, `foundation: { repo: null, tag: null }`, `approved: null` and `builtFromBrief: null` (Contract 7 §7.5). Plan 7 never changes them: approving a brief leaves the status `briefing` (there is no "brief approved" status; `currentBriefInfo` reports it), and Plan 8 moves it to `building`. Revising a brief does not change it either.
13. **`approvedBy`** is config `factory.operatorName`, else the OS user name, else `"operator"`.
14. **Exit codes.** These follow `EXIT` in `src/cli/main.js`: approved or listed 0, stopped or refused 1, failed 2, paused (no frontier model left) 3, usage 64, Ctrl-C 130.
15. **Example ids** (Contract 7 §7.4). Every worked example in an approved brief carries `id: '<featureId>#<n>'`, stamped by `assignExampleIds` when the operator is shown the brief for approval (so he sees the tags he approves).
    - On a revision, an example whose `given`/`when`/`then` are unchanged (whitespace aside) in the same feature keeps its id; a new or reworded example takes the next unused `n` for that feature.
    - An `n` is never reused: the brief carries `exampleSeq: { [featureId]: highest n ever used }`, carried forward even for features that were dropped.
    - Ids from a model are always discarded. Tests prove an example by putting `testTag(id)` (`[<featureId>#<n>]`) in their title.

## Global Constraints

- Node ≥ 20, ESM, **no npm dependencies**. Run tests with `npm test` (`node --test`). The existing suite stays green at every commit, and **no existing assertion is edited**. The new CLI values live outside `flags`, so the two `parseCli` flags `deepEqual`s are untouched.
- **Tests never call real models or touch the network beyond 127.0.0.1.** Unit tests use `fakeParticipant`. CLI tests use `writeStubCli` stubs for `claude` and `codex`, plus a 127.0.0.1 HTTP stub for the local model.
- **The raw notes reach only the author seat.** They never go to a `local-agent` participant, never into any file outside `<projectsRoot>/<slug>/`, and never into a hook payload. The session transcript (`brief/logs/`) is inside the project folder. Prompts still go through `redact()` (`callRole` does it).
- **Fail closed.**
  - Without a TTY, `conductor brief` does nothing: no notes import, no model call, no session. It prints `NO_TTY_BRIEF_START` and exits 1.
  - End of input at a question or at the approval prompt means "stop for now".
  - Only an explicit `a` approves.
  - A brief is approved only through `saveApprovedBrief` after the operator's `a`.
- **Untrusted model JSON** is parsed defensively, normalised, validated, never executed and never used to build a path.
- **Atomic writes** for every file under the project folder (Contract 1). Versioned brief files are exclusive-create.
- **Plain UK English** for every operator-facing message. No stack traces, no raw JSON at the terminal. Dates are shown as `27 October 2026` (en-GB, UTC).
- **No client data** (spec §7): the factory stores the operator's meeting notes and the brief, never client records.

## Review Focus

1. **A hostile or broken author reply** (prose only, broken JSON, a `__proto__` key, ANSI escape codes in a question, `approvedAt` set by the model, a 2 MB reply, a vague worked example): nothing is executed, nothing is approved, the terminal never receives an escape character, and the problem goes back to the author as plain feedback. Pinned in Tasks 3, 5 and 7.
2. **Ctrl-C or a crash at any moment** (during the author call, between two answers, between writing `brief-vN.json` and moving `current.json`): `conductor brief <slug>` carries on with no answer lost and never makes a duplicate version. Pinned in Tasks 4, 6, 7 and 10.
3. **The notes reaching anything but the author seat**, such as a config whose only healthy model is local, or a local stub that records what it is sent: the brief refuses to start rather than use the local model, and the 127.0.0.1 local stub never receives the notes. Pinned in Tasks 7 and 10.
4. **Hostile names and files** (slug `../etc`, `Acme/..`, a client name with no letters, an existing project, a notes path that is a folder, binary, empty or over 100 KB): plain refusals, and nothing is written outside `projectsRoot`. Pinned in Tasks 1 and 6.
5. **An operator who never finishes** (skips every question, says "stop", or the author keeps asking forever): the sitting ends with a plain message and saved state, and `project show` says the brief is unfinished. Pinned in Tasks 7 and 9.

## Operator Questions (open; the plan builds the defaults shown)

1. **Meeting notes in the project folder.** Contract 1 says "no client data ever goes into this folder", yet it also puts the operator's raw notes in `notes/`. Notes can name client staff. Default built: notes are kept verbatim at 0600 in `notes/` and sent only to the author seat. They count as requirements, not client records. Keep real records (receipts, payroll) out of notes.
2. **Paid API for briefs.** With `routing.allowApi: true`, the author seat can fall back to the Anthropic/OpenAI API, so the notes would go to that vendor's API. Default built: the existing opt-in applies unchanged, and the API is off by default.
3. **No model review of the brief** (Ruling 2). Default built: the operator's approval plus the deterministic validator. A cross-vendor critique pass could be added later if briefs come out thin.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/factory/fsAtomic.js` | `writeFileAtomic`, `writeJsonAtomic`, `createFileExclusive` | 1 |
| `src/factory/config.js` | `factoryConfig` (Plan 7's `projectsRoot`, `operatorName`; Plans 8 and 10 extend it), `DEFAULT_PROJECTS_ROOT` | 1 |
| `src/config.js` (modify) | `loadConfig` also returns `factory` | 1 |
| `src/factory/projects.js` | `slugify`, `validateSlug`, `projectDir`, `createProject`, `readProject`, `loadProject`, `saveProject`, `listProjects`, `PROJECT_STATUSES` | 1 |
| `src/factory/projectLock.js` | `lockProject` | 1 |
| `src/factory/acceptance.js` | `EXAMPLE_RULES_TEXT`, `exampleProblems`, `EXAMPLE_ID_RE`, `assignExampleIds`, `acceptanceIds`, `testTag` | 2 |
| `src/factory/outbound.js` | `OUTBOUND_SERVICES`, `outboundProblems` | 2 |
| `src/factory/brief.js` | constants, `cleanText`, `normalizeBrief`, `validateBrief` (Task 3); `ukDate`, `renderBrief`, `briefPaths`, `nextVersion`, `saveApprovedBrief`, `loadBrief`, `currentBriefInfo` (Task 4) | 3, 4 |
| `test/helpers/briefFixtures.js` | `validBrief()`, `approvedBrief()` | 3 |
| `src/plan.js` (modify) | export the existing `extractJson` | 5 |
| `src/factory/briefPrompts.js` | `NOTES_MAX`, `BRIEF_SKELETON`, `briefDraftPrompt`, `parseBriefReply` | 5 |
| `src/factory/briefSession.js` | `importNotes`, `readNotes`, `newSession`, `loadSession`, `saveSession`, `discardSession` | 6 |
| `src/factory/briefRun.js` | `BRIEF_LIMITS`, `assertFrontierSeat`, `runBriefSession` | 7 |
| `src/ui/terminal.js` (modify) | `askBriefQuestion`, `approveBrief`, `confirmDiscard`, `NO_TTY_BRIEF` | 8 |
| `src/cli/args.js`, `src/cli/main.js` (modify); `src/cli/factory.js` (create) | the `project` and `brief` commands; `FACTORY_COMMANDS`, `runFactoryCommand`; project commands | 9 |
| `src/factory/briefTeam.js`; `src/cli/factory.js` (extend) | frontier-only author seat; the `brief` command end to end | 10 |
| `README.md`, `config.example.json`, `spikes/brief-smoke/` | docs and the operator-run smoke | 11 |

## Tasks

1. [Project folder: atomic writes, factory config, projects, project lock](task-01-projects.md)
2. [Worked examples (concreteness and ids) and outside services](task-02-acceptance.md)
3. [Brief schema: normalise and validate](task-03-brief-validate.md)
4. [Render, versioned save, load](task-04-brief-store.md)
5. [Author prompt and reply parsing](task-05-brief-prompt.md)
6. [Session store and notes intake](task-06-session.md)
7. [The brief loop](task-07-brief-run.md)
8. [Terminal prompts](task-08-terminal.md)
9. [CLI: parsing and project commands](task-09-cli-projects.md)
10. [CLI: the brief command](task-10-cli-brief.md)
11. [Docs and operator brief smoke](task-11-docs-smoke.md)

Order:
- 2 is independent;
- 3 needs 1 and 2;
- 4 needs 1, 2 and 3;
- 5 needs 2 and 3;
- 6 needs 1 and 4;
- 7 needs 4–6;
- 8 is independent;
- 9 needs 1, 4 and 6;
- 10 needs 7–9;
- 11 needs all.

## Shared Interfaces (all tasks)

```js
// Task 1 — src/factory/fsAtomic.js (Contract 7 §7.1; Plans 8–12 import, never redefine)
writeFileAtomic(file, data, { mode = 0o600 } = {}) -> void      // tmp in same dir, fsync, rename, fsync dir
writeJsonAtomic(file, obj, { mode = 0o600 } = {}) -> void       // JSON.stringify(obj, null, 2) + '\n'
createFileExclusive(file, data, { mode = 0o600 } = {}) -> void  // tmp + fsync + linkSync(tmp, file); throws err.code 'EEXIST' if present

// Task 1 — src/factory/config.js (Contract 7 §7.2; Plans 8 and 10 add their sections)
DEFAULT_PROJECTS_ROOT = '~/highland-projects'
factoryConfig(config /* any object with a `factory` key, or null */, { env = process.env, home = homedir(), user = safeUserName() } = {})
  -> { projectsRoot: string /* absolute */, operatorName: string }   // throws plain Error on a bad factory section
// src/config.js: loadConfig(file) -> { participants, byName, routing, options, factory /* parsed.factory ?? {} */ }

// Task 1 — src/factory/projects.js
PROJECT_STATUSES = ['briefing', 'building', 'ready', 'shipped']
slugify(client: string) -> string                    // '' when nothing usable
validateSlug(slug) -> string | null                  // plain problem or null
projectDir(root, slug) -> string                     // throws plain Error if validateSlug fails
createProject(root, { client, slug = slugify(client), now = new Date() }) -> { dir, project }
readProject(root, slug) -> { dir, project }          // throws plain Error
loadProject(dir) -> Project                          // throws plain Error
saveProject(dir, project) -> void                    // validated, atomic; throws and writes nothing on a bad project
listProjects(root) -> { projects: [{ slug, client, status, createdAt, dir }], skipped: number }
// Project (Contract 7 §7.5) = { schema: 1, slug, client, createdAt, status,
//   foundation: { repo, tag, commit } | { repo: null, tag: null }, approved: null | { sha, at, runId, briefVersion },
//   builtFromBrief: number | null }        // Plan 7 creates { …, status: 'briefing', foundation: nulls, approved: null, builtFromBrief: null }

// Task 1 — src/factory/projectLock.js
lockProject(projectDir, kind: 'brief'|'build'|'change', { pid, isAlive, now } = {}) -> release()   // file <projectDir>/.conductor.lock
// busy → throws 'This project is busy: a <kind> is running (pid …, since …). Wait for it to finish or stop it, then try again.'

// Task 2 — src/factory/acceptance.js
EXAMPLE_RULES_TEXT: string
exampleProblems(example, where: string) -> string[]
EXAMPLE_ID_RE = /^([a-z0-9]+(?:-[a-z0-9]+)*)#([1-9]\d{0,3})$/
assignExampleIds(brief, base = null) -> brief        // pure; stamps acceptance[].id, sets exampleSeq
acceptanceIds(brief) -> [{ id: 'feature-id#n', featureId, n, title, example: { given, when, then } }]   // throws if an id is missing
testTag(id) -> '[<id>]'

// Task 2 — src/factory/outbound.js
OUTBOUND_SERVICES = { 'cloudflare-tunnel': { label, hosts: ['*.cloudflare.com', '*.argotunnel.com'], carries },
                      'azure-document-intelligence': { label, hosts: ['*.cognitiveservices.azure.com'], carries } }   // deep-frozen
outboundProblems(ids) -> string[]

// Task 3 — src/factory/brief.js
BRIEF_SCHEMA = 1; ROLE_MAPS; MODULES; OUTPUT_FORMATS; HOSTING; RESIDENCY; BACKUP_KINDS; LIMITS
cleanText(value, max) -> string | undefined
normalizeBrief(raw) -> object        // never throws; content keys only (no meta, no approval)
validateBrief(obj, { stage = 'ready' } = {}) -> { ok: boolean, problems: string[] }   // stage: 'draft'|'ready'|'approved'

// Task 4 — src/factory/brief.js
ukDate(iso) -> string                               // '27 October 2026'
renderBrief(brief) -> string
briefPaths(projectDir) -> { dir, current, session, draftMd, logs, json(v), md(v) }
nextVersion(projectDir) -> number
saveApprovedBrief(projectDir, brief) -> { version, jsonPath, mdPath }
loadBrief(projectDir) -> Brief                      // Contract 2
currentBriefInfo(projectDir) -> null | { version, approvedAt, approvedBy } | { broken: string }

// Task 5 — src/factory/briefPrompts.js ; src/plan.js gains `export function extractJson(text)`
NOTES_MAX = 200_000; REPLY_MAX = 500_000; BRIEF_SKELETON: object
briefDraftPrompt({ notes: [{ name, text }], baseBrief = null, answers = [], changeRequests = [], problems = [] }) -> string
parseBriefReply(text) -> { ok: true, draft } | { ok: false, error: string }

// Task 6 — src/factory/briefSession.js
NOTES_FILE_MAX = 100_000
importNotes(projectDir, notesFile, { now = new Date() } = {}) -> { name, bytes }   // name 'notes/<stamp>-<base>'
readNotes(projectDir, names) -> [{ name, text }]
newSession({ slug, mode: 'new'|'revise', baseVersion = null, notes, now = new Date() }) -> Session
loadSession(projectDir, slug) -> Session | null
saveSession(projectDir, session, { now = new Date() } = {}) -> void
discardSession(projectDir) -> void
// Session = { schema: 1, slug, mode, baseVersion, notes: string[], stage: 'draft'|'questions'|'approve',
//   draft: object|null, pending: Question[], answers: [{ id, question, answer: string|null, at }],
//   changeRequests: string[], problems: string[], attempts: number, rounds: number,
//   costUsd: number, approving: null | { version }, startedAt, updatedAt }
// Question = { id, question, why }

// Task 7 — src/factory/briefRun.js
BRIEF_LIMITS = { attempts: 3, rounds: 8, questionsPerRound: 5, answerMax: 2000 }
assertFrontierSeat(seat) -> void                    // throws plain Error if any candidate is local
runBriefSession({ projectDir, session, author, io, log, operatorName, cwd, timeoutMs = 1800000, now = () => new Date() })
  -> { status: 'approved', version, jsonPath, mdPath, costUsd }
   | { status: 'stopped' | 'failed' | 'paused', reason, costUsd }
// io = { say(text), ask({ index, total, question, why }) -> { answer } | { skip: true } | { stop: true },
//        approve({ markdown, draftPath }) -> { decision: 'approve' } | { decision: 'change', note } | { decision: 'stop' } }

// Task 8 — src/ui/terminal.js (createTerminal() return value gains)
askBriefQuestion, approveBrief, confirmDiscard({ slug }) -> boolean ; export NO_TTY_BRIEF

// Task 9 — src/cli/args.js parseCli results (flags object unchanged)
{ command: 'project-new', client, slug: string|null, flags } | { command: 'project-list', flags }
{ command: 'project-show', slug, flags } | { command: 'brief', slug, notes: string|null, revise, discardDraft, flags }
// src/cli/factory.js (Contract 7 §7.3) — main() calls runFactoryCommand for any key of FACTORY_COMMANDS, before the git-repo check
FACTORY_COMMANDS = { 'project-new', 'project-list', 'project-show', brief }   // { [command]: async (cli, ctx) -> exitCode }; Plans 8, 10, 11 add keys
runFactoryCommand(cli, { cwd, env, stdin, stdout, isTTY, onSignal, exit, deps = {} }) -> Promise<number>
// FactoryContext ctx = { cwd, env, home, stdin, stdout, isTTY, onSignal, exit, deps, print, configPath: string|null, factory: FactoryConfig }

// Task 10 — src/factory/briefTeam.js
briefAuthorSeat(participants, { routing = {}, env = process.env, health = checkHealth, board = new HealthBoard() } = {})
  -> { ok: true, seat: Seat, warnings: string[] } | { ok: false, error: string }
// src/cli/factory.js exports NO_TTY_BRIEF_START; FACTORY_COMMANDS.brief is the brief handler
```
