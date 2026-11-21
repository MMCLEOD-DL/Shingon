# Codex task submitted — native workspace command evidence

Packet P07; owner Codex / BlueLake; reviewer Claude invited. Branch codex/native-workspace-command-evidence, [PR153](https://github.com/MMCLEOD-DL/Shingon/pull/153). Baseline673ebe56e2a61c7852f5a1539f89fe4c2aa57ca0 includes tested code56b7874c4af67cb9103ebf4855a734f76a38b6f8 from merged PR152. Evidence commit2b4dc87 updates only W197/W200; this is the final submission commit. Runtime source and test code are unchanged in this continuation.

The original workspace commands used POSIX stderr/exit syntax and sleep. Focused native reproduction was1pass/2fail. Separately adding a timeout-marker assertion to the original sleep fixture exposed a false positive: a missing executable had counted as the expected timeout failure. Portable Node script fixtures now run through the real Workspace.runTests entry point and preserve exit4/stderr/success/not-configured checks. Both timeout checks require actual timeout output.

Checks on Windows, Node v24.12.0, cwd E:/SHINGON-codex-native-review/conductor:

- `node --test --test-name-pattern='runTests reports|runTests timeout|a timed-out test run' test/workspace.test.js`: after correction3pass/0fail/0skip, exit0.
- `node --test --test-name-pattern='runTests timeout counts as failure' test/workspace.test.js`: strengthened assertion against the original sleep fixture0pass/1fail, exit1; missing sleep no longer satisfies the check.
- `node --test --test-concurrency=4 --test-reporter=tap`: completed1,746tests/1,685pass/60fail/1skip/0cancelled, exit1,708861.819ms. Private native TAP retained outside Git as shingon-native-workspace-command-fixtures-full.tap.
- Exact file/test-name identity comparison to the62 prior OPEN inventory rows: W197/W200 resolved,60 unchanged failures,0new. All201 original rows retained;141FIXED_NATIVE/60OPEN. Only these two inventory rows changed. The comparison ignores line/column shifts and normalizes TAP path escaping; no failure is waived.

Code-head56b7874 all five required checks PASS (CI44941551156 and risk44941551095). Final documentation-head CI is pending and must pass all five checks before readiness. Do not rerun the full native suite for this documentation-only continuation.

Native suite remains red; P07/P08 remain IN_PROGRESS. Existing skip retained and no Windows skip added. Evidence is synthetic local command execution, not live model, worker, remote, credential or release acceptance. No runtime, host setting or policy change was made.

Next action: current chat owns final-head CI/readiness, then await Malcolm merge of this final submission before another product task. No automatic/immediate merge or repository-settings workaround. Remaining FIX-REMOTE and shell-fixture failures are next candidates after approval; Claude UI/live ownership and all separate gates remain preserved.
