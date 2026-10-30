# Instructions for coding agents in this repository

Shingon has two folders: `foundation/` (TypeScript client-app foundation) and `conductor/` (Node CLI and local operator app). Delivery is planned in `conductor/docs/superpowers/plans/2026-10-29-two-week-product/`. Read `00-index.md`, `03-parallel-working.md` (ownership, handoffs, review standard) and `05-validation.md` (commands and evidence rules) before changing anything.

Two assistants work in parallel:
- **Codex** follows the loop below.
- **Claude** follows `.claude/skills/claude-lane/SKILL.md`.

Both lanes share these rules: one task per pull request; Malcolm approves by merging; the work log is the shared ledger: packet statuses in `04-work-log.md`, and one file per entry in `work-log/` beside it, in the plan folder (see `work-log/README.md`). Paths below are relative to that folder.

## Codex lane: one task, one PR, wait for Malcolm's merge

Use this loop when Malcolm says "next task", "carry on" or "run the Codex lane". Codex sessions are not woken by GitHub events, so each invocation does **one** step of the loop and ends. Approval is detected at the start of the next invocation.

### 0. Rules this loop never breaks

- **One task per PR, and nothing new until the previous one is merged.**
  - Merged into `main` is the only approval. It happens by **auto-merge** for PRs that touch no high-risk path, once the required checks (`foundation`, `knowledge`, `conductor`, `operator-web`, `risk-gate`) are green. PRs touching a path in `.github/workflows/risk-gate.yml` wait for **Malcolm**: his merge, or his `malcolm-approved` label.
  - Never add or remove the `malcolm-approved` label. Never edit `.github/`, `AGENTS.md` or `.claude/` to loosen the gate.
  - An unmerged PR or branch means "waiting": say so and stop.
  - A PR closed without merging means "rejected": stop and ask Malcolm.
- **Stay in lane.** Codex owns P00, P01, P03 and P05, coordinates P07 and P08, and owns the P01 ops files, the service (`conductor/src/service/**`), CLI service seams, setup scripts and Conductor's root `package.json`/lock.
  - Never edit Claude-owned paths without a recorded handoff: `foundation/modules/ocr/**`, `conductor/operator-web/**`, `conductor/docs/knowledge-base/**`, `conductor/spikes/knowledge-base-evaluation/**`, `knowledge/**` (the knowledge service), and `conductor/docs/operator-app/{ux,next}.md`.
  - Shared engine, configuration and adapter seams need a named, minimal change and a work-log note.
- **Git.** Work on a fresh branch per task from the current `main`, named `codex/<short-task-name>`. Push normally and never force-push. Never rewrite someone else's branch; integrate other people's work with a merge commit.
- **No outward actions.** No paid API calls, live model or subscription probes, remote machines, client boxes or releases. Nothing that needs Malcolm's sign-in or secrets. Ask instead.

### 1. Check the previous task (every invocation, first)

1. Run `git fetch origin`, then `git log --oneline -15 origin/main`.
2. Find the newest Codex submission: the last file, sorted by name, matching `work-log/*-codex-submitted-*.md`, headed **"Codex task submitted"**. It names the task branch. (Submissions before 31 October 2026 are entries in `04-work-log.md`.)
3. Check whether it has been approved: `git merge-base --is-ancestor origin/codex/<task> origin/main`. The submission entry is the branch's last commit, so a merge of the PR includes it.
   - **Merged:** say so in one line, then continue to step 2.
   - **Not merged:** look for review comments on its PR (or in `reviews/`) and address them on the **same** branch. If there are none, report "waiting for Malcolm to merge `<branch>` (PR link, or 'PR still needs opening')" and **stop**.

### 2. Read the repo and choose the next task (first match wins)

Read `04-work-log.md` (packet statuses) and `work-log/` (newest files first), `01-task-packets.md` for the candidate packet, `reviews/`, and `conductor/docs/operator-app/next.md`.

1. **Codex's own red items.** Review findings on Codex work, failing checks, conflicts. Today that means:
   - P01 **R1-1** (owner's decision) and **R1-2** (CHANGELOG line) in `reviews/2026-10-29-claude-review-P01-P03.md`. The branch `codex/update-settings-safety` @ `b25e2bf` is **not merged**: bring it up to date with `main` and get it a PR.
   - P03 notes **N1** (no recovery path for a run flagged as needing inspection) and **N2** (worker refusal after approval also marked as needing recovery).
2. **Review requests addressed to Codex.** Codex is the reviewer for Claude's P02, P04, P06 and P09, which are merged but still marked "awaiting Codex review". Review at the named commits:
   - reproduce before judging;
   - give each finding a severity, location, trigger and consequence;
   - write the result to `reviews/<date>-codex-review-<packets>.md`.
3. **Codex packets whose dependencies are met**, in order: P05 (setup, probes, start), P07 (integration and adversarial acceptance with fake providers), P08 (live acceptance).
   - Native Windows and live-model steps need Malcolm's host and sign-in. Record them as blocked with the exact owner and action. Never claim them from Linux or mock results.
4. **Recorded follow-ups on Codex-owned or shared engine code.** Example: the `GIT_CONFIG_*` scrubbing bug in `conductor/src/secrets.js`, described in the work log entry "Conductor suite with operator-web present". A fix needs a regression test that sets the `GIT_CONFIG_COUNT`/`KEY`/`VALUE` trio.
5. **Next-phase items,** only where Malcolm has recorded the decision they depend on.

If nothing qualifies, **stop and ask Malcolm**, naming each candidate and what it waits for. Never take a Claude-owned packet.

Before starting, state the task, why it is next, the PR scope, and what it will **not** do.

### 3. Do the task

- Claim it: set the packet's row in `04-work-log.md` to `IN_PROGRESS` if it changes, and add a claim file in `work-log/` with the branch, baseline SHA and owned paths.
- **Reproduce first.** For a fix, show the failing check, then the passing one.
- Run the affected checks from `05-validation.md`. The full Conductor suite is `node --test --test-concurrency=4` from `conductor/`. In the cloud container, use the orphan-reaping wrapper if it is present, and keep `XDG_CACHE_HOME` out of the temp directory.
- If the UI is affected, run `npm test`, `npm run build` and `node e2e/journey.mjs` in `conductor/operator-web/`.
- Do not run the heavy Foundation and Conductor suites at the same time on the 4-CPU instance.
- Record evidence with the handoff template from `03-parallel-working.md`. Keep live, fake, skipped and unrun results separate. Never mark DONE on description alone.

### 4. Push, then record the submission

- Push `codex/<task>` and open a **draft** PR with the packet ID, the changes, the checks run (with counts) and what was not run.
  - If PR creation is forbidden (GitHub API 403), say so and give the compare link: `https://github.com/MMCLEOD-DL/Shingon/compare/main...codex/<task>`. Malcolm or Claude can open the PR from it.
- **Merge route.**
  - **No high-risk path:** once your checks pass, mark the PR ready and enable auto-merge (merge commit), for example with `gh pr merge --auto --merge <n>`. If the API refuses, say so; Malcolm or Claude can enable it.
  - **High-risk path:** leave auto-merge off and say it needs Malcolm.
  - **A red required check is yours to fix** on the same branch. Never weaken a test or workflow to get green.
- As the branch's **last** commit, add a work-log file `work-log/<YYYY-MM-DD-HHMM>-codex-submitted-<task>.md` headed **"Codex task submitted — <task>"**. It gives the branch, the SHA of the last code commit, the PR link (or "PR needed"), the evidence and open questions. Push it.
- Tell Malcolm, in one short paragraph: what the PR does, the evidence, what approving it means, and that the next "carry on" after his merge starts the next task. Then **stop**.
