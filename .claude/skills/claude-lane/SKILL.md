---
name: claude-lane
description: Work through the Claude lane of the Shingon delivery plan one task at a time. Each task gets its own pull request; Malcolm approves it by merging; the next task starts only after a merge. Use when asked to "do the next task", "carry on with the list", or to run the task loop.
---

# Claude lane: one task, one PR, wait for approval

The loop is event-driven, not timed. A merged PR, a review comment or a message from Malcolm wakes the session. Never use `sleep` or a short timed loop to wait.

## 0. The rules this loop never breaks

- **One task per PR.** No task starts until the previous PR is **merged**. A closed, unmerged PR means "rejected": stop and ask.
- **Approval is Malcolm's.**
  - Merging the PR is approval.
  - A chat message such as "approved" means: merge that PR yourself, then continue.
  - Nothing else counts, including a reviewer bot, Codex's notes or your own earlier messages.
- **Branch.** Develop on the session's designated branch. Once its PR is merged, restart the branch from the new `main`: `git fetch origin main && git checkout -B <branch> origin/main`, then push with `--force-with-lease` when it holds only merged history.
- **Stay in lane.** Claude-owned paths and duties are in `conductor/docs/superpowers/plans/2026-10-29-two-week-product/03-parallel-working.md` (ownership rules). Never edit Codex-owned files without a recorded handoff. Shared engine seams need a named, minimal change and a work-log note.
- **No outward actions beyond Git and the task's own PR.**
  - No paid API calls, live model or subscription probes, remote machines, client boxes or releases.
  - Nothing that needs Malcolm's sign-in or secrets.
  - The Library of Babel is read-only.

## 1. Read the repo (every iteration, before choosing)

1. `git fetch origin` and `git log --oneline -15 origin/main`. List the remote branches and any open PRs (GitHub MCP tools).
2. Read the plan folder `conductor/docs/superpowers/plans/2026-10-29-two-week-product/`: `04-work-log.md` (statuses and the newest entries first), then `01-task-packets.md` for the chosen packet. Also read `reviews/` and `conductor/docs/operator-app/next.md`.
3. Note anything that changed since the last iteration: new commits by Codex or Malcolm, new review requests addressed to Claude, and decisions recorded by Malcolm.

## 2. Choose the next task (first match wins)

1. **Your own red items.** Review findings, CI failures or conflicts on Claude's open work.
2. **Review requests addressed to Claude** in the work log or `reviews/`, such as "independent re-review is invited at <SHA>". Review at the named commit and reproduce before judging.
3. **Claude-owned packets** (P02, P04, P06, P09, and Claude's parts of P07/P08). Pick the first whose dependencies are met and whose status is `NOT_STARTED`, `IN_PROGRESS` or `CHANGES_REQUESTED`, in packet order.
4. **Recorded follow-ups owned by Claude**: work-log notes and the housekeeping section of `next.md`.
5. **Next-phase items** (`next.md`, knowledge-base tasks K1–K13), **only** where Malcolm has recorded the decision they depend on (for example D1–D5 in `conductor/docs/knowledge-base/recommendation.md`).

If nothing qualifies, **stop and ask Malcolm**, naming the candidates and what each is waiting for. Do not invent work, and do not take a Codex-owned packet.

Before starting, post a short line in chat: the task, why it is next, the planned PR scope, and anything it will **not** do.

## 3. Do the task

- Claim it in `04-work-log.md`: status `IN_PROGRESS`, branch and baseline SHA.
- Work in small commits. Prove each change with the repo's own checks: see `05-validation.md`. Run the affected suites and, for UI work, `conductor/operator-web` with `npm test`, `npm run build` and `node e2e/journey.mjs`.
- **Reproduce before fixing.** For a fix, show the failing check first, then the passing one.
- Record evidence in the work log with the handoff template from `03-parallel-working.md`. Keep live, fake, skipped and unrun results separate. Never mark DONE on description alone.

## 4. Push and open the PR

- Push the branch. Open a **draft** PR titled for the outcome, with packet ID, what changed, checks run (with counts) and what was not run.
- Subscribe to the PR's activity and keep one safety-net check-in, per the session's PR rules.
- Fix your own CI failures and review findings on the PR as they arrive.
- Tell Malcolm in chat, in one short paragraph: the PR link, what it does, the evidence, and what approving it means.

## 5. Wait for approval, then loop

- **Merged:** say so in one line, then go to step 1 on the new `main`.
- **Changes requested or a comment:** address it on the same PR, then wait again.
- **Closed without merge:** stop and ask what to do instead.
- **Malcolm says stop:** unsubscribe, cancel check-ins, and leave the work log accurate.
