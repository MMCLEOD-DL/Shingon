# Codex task submitted — Windows tool discovery

- Packet: P07/P08, PR130 R1 WIN-TOOLS follow-up. Owner Codex; Claude cross-review requested. Status IN_REVIEW; P07/P08 remain IN_PROGRESS.
- Branch `codex/windows-tool-discovery`, isolated checkout. Initial baseline `8a4971ea41d8220bc1336e0b3c3ad150c337e538`. [Draft PR135](https://github.com/MMCLEOD-DL/Shingon/pull/135). Production commit `f3d08164e751d270ff3770c66ac4e758c832ca67`; final code/test commit `5a8493c7c16b4f639c99b715d1b5ae67effdb6d9` strengthens one boundary assertion. Inventory reconciliation `939078d`; latest main PR133 documentation integrated by merge `1fcb74b36bcf612f0fc93872ed4644aef280adee`. No runtime source changed after f3d0816.
- Shared seams claimed before editing: `src/council/tools.js` lookup; `src/factory/ship/remote.js` owned-tree cleanup and real-file observation seam. Fixture/test changes are named in the claim. Protected factory/ship path needs Malcolm's approval/merge; auto-merge OFF. No approval-label or workflow changes.

## Recent PRs read and lane selection

PR131 final submissione6e41b9 verified included in main; its final Linux CI all four code jobs PASS. PR132 is a documentation proposal, including d5ea1d5's third-answer, service-survival and execution-policy corrections. W1–W8 remain decisions, so merging it is not treated as runtime worker-start authority. PR133 landed during validation and was also read: peer-reported live E1/E2 pass at85bfe0f, D3/F3 unrun and Part F gaps preserved. Its cause grouping defers to the per-test inventory. The merge into this branch changes only that peer work-log file, so it needs no new native code claim.

The own WIN-TOOLS red backlog is the next unblocked task under the lane order. No new worker feature, live acceptance run, model call or UI change was made. The old local80fc452 patch has the same stable patch identity as merged293eb16; the old8f8b5e1 partial handoff is superseded by the merged Part E record. No peer branch was deleted, reset or rewritten.

## Result

Native lookup now reads mixed-case Path/PATHEXT, respects extension order and quoted directories, and rejects drive/path traversal while retaining POSIX executable checks. Synthetic SSH environments have one native PATH key and the host delimiter. Both shared and hanging helpers verify exact stub identity before transport.

Real fixture execution exposed Windows descendants surviving the old POSIX kill fallback. Transport failure/timeout now uses the existing owned-process-tree helper for live Windows roots, preserving POSIX group cleanup even after a root exits. The file closure assertion observes a real ReadStream rather than Linux /proc. No assertions were removed or Windows tests skipped. Generic Windows batch dispatch and full native factory support remain unverified.

## Validation

Native Windows, Node24.12.0, isolated clone. Initial focused reproduction: **1pass/4fail**, exit1. Corrected lookup then reached the two descendant assertions, which failed before the cleanup fix.

- Final `node --test test/council-tools.test.js test/factory-ship-remote.test.js`: **23/23PASS**, exit0, including two real synthetic descendants, timeout cleanup, real stream closure, malformed/path inputs, quoted PATH/PATHEXT ordering and a negative stub-identity guard. Strengthened outside-PATH boundary assertion also passed separately at5a8493c.
- Full `node --test --test-concurrency=4`, started at productionf3d0816: **1,737total;1,645pass/91fail/1skip**, exit1,613seconds. Private log `%TEMP%/shingon-windows-tool-discovery-full.log`. The later5a8493c change adds one assertion to an existing test; no runtime source changes.
- **Exact file/name-set reconciliation** against the prior199 failures: **108 resolved,0new failure identities**. The201-row CSV now has110 cumulative FIXED_NATIVE and91 OPEN. W119/W120 get through discovery and now fail on missing sh fixture writes; their latest category/action is recorded. Other initial categories remain historical, with separate latest-observation fields. No failure count is accepted as a passing baseline.
- Inventory checks:201 unique IDs and test identities, complete owner/actions, reconciled status totals and no absolute Windows host paths. `git diff --check` PASS.
- Linux CI is pending on this final submission. Native UI checks were not repeated because this task changes tool lookup and factory transport, not UI/API fields; required CI still includes operator-web. Prior source131 UI evidence is not presented as a fresh run of this change.

## Fixture incident and scope

The first targeted run after lookup repair missed a separate hanging-SSH helper's colon PATH. It selected installed SSH against synthetic fixture names, returning code255/timeout rather than expected fake outcomes. No successful remote execution was observed. This is not described as synthetic-only. The helper was corrected, both helper entry points now assert their exact stub path before execution, and fixture-owned PIDs are cleaned in teardown even after failed assertions. All completed focused/full evidence above follows those guards.

No actual worker start/restart, model/subscription use, deliberate real remote operation, execution-policy or credential change was performed. Claude retains live Part E and UI ownership. Existing legacy holds, spent bindings and immutable archives remain unchanged.

Next action: finish final-head CI and cross-review, fix attributable findings on this branch, then Malcolm's protected merge. No new product task until this final submission is included in main. The remaining91 are an explicit queue; FIX-URL20 and the two newly exposed sh fixture writes are concrete next candidates. PR132 implementation stays gated by W1–W8.
