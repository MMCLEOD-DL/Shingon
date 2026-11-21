# Codex task submitted — native secret environment fixtures

Owner Codex / BlueLake. P07 native red backlog W189–W192. Branch codex/native-secret-env-fixtures, baseline28334dd (PR144 final185f5a6 verified merged). [Draft PR145](https://github.com/MMCLEOD-DL/Shingon/pull/145). Tested code eadfbb574f7fcc73c41ce6ef1439591c5a88a968; latest evidence6af04e7. This file is the final submission commit.

Four existing tests now observe synthetic environment values with Node through the actual runCommand and Workspace.runTests entry points. The fixtures verify child exit codes, explicit allowed-key delivery, a real child resolving Node through the retained search path, and delivery of the database URL before redacted failure output. Windows PATH-key inspection follows the host's case-insensitive names. Test file and four inventory rows only; runtime source and assertions retained. P07/P08 remain IN_PROGRESS.

Native Windows, Node24.12.0, commands from conductor:
- Before code changes, node --test test/secrets.test.js:12total/8pass/4fail, exit1.
- After code changes, same command:12pass/0fail/0skip, exit0.
- Complete node --test --test-concurrency=4 --test-reporter=tap at eadfbb5:1746total/1683pass/62fail/1skip, exit1,574.763seconds. The native suite remains red. Private log is under the task's TEMP directory, shingon-native-secret-env-fixtures-full.tap.
- Exact file/name comparison against66 OPEN inventory rows resolves only W189/W190/W191/W192,0new failure identities,62stillOPEN. All201 inventory rows preserved; cumulative139FIXED_NATIVE/62OPEN. The first inventory-write attempt used a wrong column name and truncated its intermediate working copy; restored all201 rows from exact committed base before reapplying the four row changes. No partial inventory was pushed.
- git diff --check PASS. Final inventory comparison verifies only those four rows differ from the tested-code base.
- Code-head Linux CI44916368846 is still running at this evidence submission; risk gate44916368872 PASS. Final submission triggers fresh required checks; mark ready only after all five pass. No unobserved Linux success claimed.

Only existing synthetic values and local test processes were used. No actual credential, model, worker, SSH, release or host-policy action. UI/Foundation/browser checks were not rerun locally for this test-only change. Existing skip remains; no assertions or Windows tests were skipped to pass.

Reviewer Claude: check that the Node probes still detect credential inheritance, that failed probes cannot appear successful, and that the database output check proves actual URL delivery before redaction. No runtime contract change.

Next action: complete final-head required CI/review, mark ready, then await Malcolm's merge. Repository auto-merge was previously verified disabled; no immediate-merge or settings workaround. No next product task until final submission included in main. FIX-REMOTE and remaining workspace shell fixtures remain separate native backlog. Existing UI/peer ownership, live gates, h2/j4 reservation and spent legacy bindings persist.
