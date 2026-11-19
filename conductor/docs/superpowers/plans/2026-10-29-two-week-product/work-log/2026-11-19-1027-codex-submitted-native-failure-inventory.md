# Codex task submitted — native failure inventory

- Packet: P07/P08 response to PR130 R1, N1 and N2. Owner Codex; Claude cross-review requested. N3 UI remains Claude-owned. Status IN_REVIEW; broad R1 remediation remains OPEN.
- Branch `codex/native-failure-inventory`, baseline `ec3072585b22dff71a0339cb7b78b36c962c3dcc`. [Draft PR131](https://github.com/MMCLEOD-DL/Shingon/pull/131). Last code commit `293eb161b042f27dd092902b1b6e4157c9b32d72`; exact native-failure reconciliation documentation commit `4d2ae94082bfa70d9b20006de7674ff28ac9d70e`.
- Protected platform path requires Malcolm's approval/merge; auto-merge OFF. No approval-label, test-skip, assertion or workflow weakening.

## Result

Classified all201 saved failures at80b90be by test identity, evidenced first blocker, owner and next action in `docs/operator-app/windows-failure-inventory-2026-11-19.{md,csv}`. Categories distinguish native product gaps, POSIX fixture assumptions and environment limitations; first-blocker classification does not prove later code works. The old count is not an accepted baseline.

Independent native reproduction found configured quoted Node tests falsely returned0, including a baseline that reached deferred preparation despite exit2. The minimal named shared seam change in `src/service/platform.js` and `src/exec.js` uses cmd outer quotes and explicit Windows verbatim arguments only for the configured test shell, keeping ordinary subprocess escaping as default. It preserves AutoRun-disabled /d /s /c. Regression tests exercise real commands, literal arguments, short-circuit behavior and runTask baseline refusal.

N2's interface contract now documents archived no-plan preparation refusal on Resume, null workspace, saved-plan/keepWorkspace exceptions and interrupted-baseline recovery. N1: native validation completed before this draft PR opened; source review and approval are still required. No packet is marked DONE.

## Validation

Native Windows, Node24.12.0; existing Playwright1.63.0. Synthetic model CLIs and fixture HTTP servers only.

- Before implementation: **3/3 new controls FAIL**, exit1: failing quoted command returned0, quoted executable did not resolve, and failing baseline called preparation once.
- After implementation: `node --test test/service/platform.test.js`: **5/5 PASS**, exit0. Focused baseline/council/factory command (quoted failing baseline; tests already failed at starting commit; feature whose checks fail): **3/3 PASS**, exit0.
- Full isolated native `node --test --test-concurrency=4` at293eb16: **1,732total; 1,532pass / 199fail / 1skip**, exit1, 440seconds. Private log `%TEMP%/shingon-native-inventory-isolated-full.log`. **Exact file/name-set comparison** with the201 saved failures identifies only W029/W055 as resolved, zero new failure identities and199 still OPEN; CSV statuses reflect this. Native suite is **not green**.
- UI in the isolated clone: `npm ci --no-audit --no-fund`, `npm test`: **86/86 PASS**, 3files; `npm run build` PASS; existing global Playwright on NODE_PATH, `node e2e/journey.mjs`: **22/22 fixture**, **6/6 real engine with stand-in CLIs**, **4/4 restart/Resume/fallback**, exit0.
- Inventory checks:201 unique test identities,201 unique IDs, complete owner/actions, category totals reconcile, and no absolute Windows host paths in CSV. Direct probes confirm bare executable/.exe/mixed-case Path discovery failures and fileURLToPath-readable versus pathname-unreadable fixture reports.
- `git diff --check` PASS. Linux CI is pending on this final submission; no unobserved result is claimed.

## Checkout isolation and limits

Another worker switched the shared checkout to a Claude branch while this task ran. The initial own commit80fc452 consequently landed locally above peer documentation8f8b5e1. Peer branch/history and untracked Windows report were preserved; no reset/force push/rewrite was performed. Only our change was cherry-picked onto the baseline in a separate desktop clone as293eb16. The original shared-checkout suite was stopped through its verified owned Node process and is not used as completed evidence; the full native result above comes from the isolated clone. The peer's documentation is not included in this PR. Private coordination state records exact checkout disposition.

R1 remains open for199 cases. Native tool discovery and synthetic PATH construction are the next concrete repair candidate; native factory support scope remains a separate operator decision. ACL privacy, symlink setup, graceful versus abrupt cancellation and native report-path semantics are explicitly unverified where blocked. No actual SSH/release, credential, live-model, worker, policy or native promotion operation was performed. Claude retains live Part E and richer UI ownership.

Next action: inspect/fix attributable CI or scoped review findings on this branch, obtain cross-review and Malcolm's protected approval/merge. Do not start another product task until this final submission is included in main. After merge, address WIN-TOOLS without skipping its blocked assertions or authorizing live factory operations.
