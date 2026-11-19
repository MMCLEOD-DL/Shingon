# Codex claim — preparation failure cleanup

- Packet: P07/P08, PR116 review R3. Owner Codex; reviewer Claude requested at submission.
- Branch `codex/preparation-failure-cleanup`, baseline `7e5ab5cdee0faf15ab2fc59dc6b9e0316ec82d80`. Previous PR126 submission verified ancestor of origin/main.
- Scope: `conductor/src/conductor.js`, CLI preparation/main seams, service `runs.js` cleanup projection and regression tests. Give preparation refusals a reason and archive the transcript/remove an unused clone when preparation ends before a saved plan. Preserve existing planned work, interrupted baseline recovery and explicit keepWorkspace.
- First action: reproduce with synthetic preparation outcomes and real temporary Git workspaces, then correct and validate. No live models or worker operations.
- Existing untracked Windows acceptance report belongs to the user and remains excluded. P07/P08 remain IN_PROGRESS.
