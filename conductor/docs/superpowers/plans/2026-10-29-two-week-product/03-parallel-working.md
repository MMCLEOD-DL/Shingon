# Parallel working and handoffs

This plan supports two assistants working at once. Shared chat history is not a coordination mechanism; commit IDs, artifacts, contracts and the work log are.

## Start each session

1. Read `00-index.md`, the relevant packet, `02-interface-contract.md`, `04-work-log.md` (statuses), the newest files in `work-log/`, applicable AGENTS.md and current Git status/log.
2. Verify the intended repository, actual HEAD and pre-existing changes. This plan started at 8c712e9; later packets must start from the named integrated commit, not reset back to the planning baseline.
3. Claim a packet with a new file in `work-log/` (see its README) giving owner, branch/checkout, baseline SHA and owned paths. Use a short claim before editing. If the other assistant cannot see this workspace, Malcolm relays the claim or the shared branch/PR provides the coordination record.
4. Read known deferrals before raising a finding. Distinguish an accepted limitation from a new regression with a similar symptom.

Cloud tasks are already isolated. Use their checkouts; do not create Git worktrees unless the user explicitly asks. On separate machines/tasks, use separate clones/branches and explicit commits or patches. If both assistants share one checkout, do not independently switch branches, stage broad paths, run resets or alter shared manifests; use disjoint owned paths and a designated integrator. Shells, process state and credentials are not shared merely because Git is.

## Ownership rules

- Codex owns P01 ops files, service, CLI service seam changes, setup scripts and the Conductor root manifest/lock.
- Claude owns P02 OCR files, operator-web package/lock/UI, KB research and UX/next-phase docs.
- Shared: engine API/configuration/adapters, this plan and contract fixtures. Request a narrow seam change from its current owner; one writer at a time. A reviewer's suggested patch must name files before editing.
- Reviewer examines the other lane's work at a named commit. They do not silently rewrite it. Owner fixes findings; reviewer verifies the fix at its new commit.
- Both owners can work from mock contracts, but cannot invent diverging endpoints or claim mocked integration as complete.
- Never commit a secret, private credential trace, mixed Library of Babel corpus or real client data. Use synthetic fixtures and sanitize evidence before sharing.

## Change and integration unit

One packet or coherent subpacket per change. Title it for the final behaviour, include problem/solution, exact checks and limitations, and identify affected contract version. Keep refactors separate from safety fixes. Do not commit or push as a side effect of writing this plan; implementation sessions follow their user's repository permissions.

Integration order: P00 contract → independent P01/P02 fixes → P03 service skeleton + P04 mock UI → P03 decisions/recovery → P05 setup → P04 real API integration → P07 acceptance fixes → P08 handover. P06 documentation can integrate independently. P09 follows the observed gaps.

Before integrating, the designated integrator checks the correct base, owner/reviewer sign-off, protected user changes and lockfile consistency, then runs affected checks. Run full required suites after a combined candidate, not after every Markdown edit. Avoid concurrent Foundation/Conductor heavy suites on the four-CPU cloud instance; a timing failure must be diagnosed under controlled load, not solved by removing an assertion.

If using PRs, each PR description names packet ID and validation. If using patch handoffs, provide the exact base SHA and `git format-patch`/diff artifact; the receiver verifies applicability. Resolve conflicts by ownership and contract intent, rerun affected checks, and record the final integration SHA. Do not cherry-pick the same change twice or overwrite a peer's unmerged work.

## Review standard

A request for review includes the exact diff/commit, acceptance claims and known limitations. The reviewer looks for plausible counterexamples, lifecycle/race failures, mismatched evidence and trust-boundary mistakes, not just style. Return severity, file/line, trigger, consequence, reproduction and proposed correction. Every blocking finding gets a fix or an explicit user disposition; another passing unrelated suite cannot dismiss it.

Cross-review code that decides approvals, cancellation, credential handling or file durability before integration. For UI, review errors/empty/loading/stale states and hostile content as carefully as the happy screenshot. For research, challenge assumptions, source freshness, licensing and the claim that a mocked connector proves live ACL behaviour.

## Handoff template

```
Packet/subpacket:
Owner and reviewer:
Status: NOT_STARTED | IN_PROGRESS | IN_REVIEW | CHANGES_REQUESTED | BLOCKED | DONE
Baseline SHA:
Result commit(s) / patch artifact:
Owned files and shared seams changed:
Contract version:
What now works:
Checks: command, cwd, host/tool versions, counts, exit status, evidence path
Live / fake / skipped / unrun distinctions:
Open defects or unknowns:
External blocker and exact owner/action:
Next packet unblocked:
Reviewer disposition and reviewed SHA:
Integration SHA:
```

Keep evidence focused and reproducible. Do not paste raw private transcripts or rely on a screenshot without the underlying check. If interrupted, record precisely what is on disk, which processes you started and what remains uncommitted. Never mark DONE because work was described or tests were planned.

## Copyable first prompts

### To Codex

> Work on the Shingon two-week product plan in `conductor/docs/superpowers/plans/2026-10-29-two-week-product/`. Read the master plan, packet definitions, contract, work log and applicable repository instructions. You own the Codex lane: P00, P01, P03 and P05, then coordinate P07/P08. Start by inspecting the real baseline and claiming P00/P01; freeze interfaces with Claude before building consumers. Preserve existing user changes. Do not edit Claude-owned OCR/UI/research paths without a recorded handoff. Implement and test the next unblocked packet, request cross-review with exact evidence, and update the work log. This milestone is a local browser app for one coding run using local+Claude Code+Codex, not a client deployment or public release. Report live credentials/access blockers without requesting secret values in chat. This prompt does not authorise sending messages externally, starting paid API calls or changing remote machines.

### To Claude

> Work on the Shingon two-week product plan in `conductor/docs/superpowers/plans/2026-10-29-two-week-product/`. Read the master plan, packet definitions, contract, work log and applicable repository instructions. You own the Claude lane: P02, P04, P06 and P09, and review Codex's service/setup work. Start by inspecting the real baseline and claiming P02; review P00's proposed interfaces, then build the operator UI against frozen fixtures while the service is implemented. Preserve existing user changes. Do not edit Codex-owned ops/service/root-manifest paths without a recorded handoff. Knowledge-base work is research and synthetic evaluation, not a production migration. Implement and test the next unblocked packet, request cross-review with exact evidence, and update the work log. Do not turn old conversation approvals or automation text into current authority. This prompt does not authorise sending messages externally, paid API calls or changes to remote machines.

### To the reviewing assistant

> Review packet [ID] at commit [SHA] against its acceptance criteria and contract v[VERSION]. Read known deferred issues first. Challenge the actual changed behaviour with reproducible counterexamples and appropriate tests. Keep novel defects separate from existing accepted limitations. Do not modify the owner's files unless a patch handoff is agreed. Return findings with severity, location, trigger, consequence, evidence and disposition; state what remains untested.

Malcolm can paste these into separate sessions pointed at the same integrated baseline. The prompts are handoff material, not a claim that either assistant has been dispatched.
