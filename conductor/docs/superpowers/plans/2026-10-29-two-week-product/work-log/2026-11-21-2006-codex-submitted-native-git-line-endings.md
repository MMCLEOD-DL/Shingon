# Codex task submitted — native Git fixture line endings

Packet P07; owner Codex / BlueLake, reviewer Claude invited. Branch codex/native-git-line-endings, [PR154](https://github.com/MMCLEOD-DL/Shingon/pull/154). Baseline34d6ff732c69905ec8e7806d6898600692a6da92 includes PR153 final924c2e6, verified merged. Tested code0fcc658893bdd2c35403b15a8b71ddf52cf3a6b3; inventory evidence7f95aa7. This is the final submission commit.

Shared test/helpers/gitRepo.js and factoryFixtures.js now seed a default `.gitattributes` with `* -text`, preserving declared fixture bytes through real Git clone/checkout/reset independently of host conversion settings. Explicit supplied attributes still override the default. New test/git-fixtures.test.js checks both helpers with LF text, intentional CRLF text and binary data, under autocrlf=true/false with core.eol=crlf. This does not normalize away intentional CRLF input or change user/global Git configuration. Runtime source and original content/lifecycle/ignored-file assertions are unchanged.

Checks on native Windows, Node v24.12.0, cwd E:/SHINGON-codex-native-review/conductor:

- Before: seven original focused tests in factory-app, factory-build-state, factory-change-mainline and workspace:0pass/7fail/0skip, exit1. Both new byte-preservation controls also fail against original helpers:0pass/2fail/0skip, exit1.
- After: `node --test --test-reporter=tap --test-name-pattern='^nameApp rewrites|^mergeFeature: one squashed|^mergeFeature after a crash between moving|^advanceMain with main checked out: an ignored file|^advanceMain: an ignored file elsewhere|^create clones HEAD|^resetHard drops|fixture keeps exact bytes' test/factory-app.test.js test/factory-build-state.test.js test/factory-change-mainline.test.js test/workspace.test.js test/git-fixtures.test.js`:9pass/0fail/0skip, exit0.
- Full: `node --test --test-concurrency=4 --test-reporter=tap`:1,748tests/1,694pass/53fail/1skip/0cancelled, exit1,695605.0791ms. Two new tests explain the total increase from1,746. Private TAP retained outside Git as shingon-native-git-line-endings-full.tap.
- Exact file/test-name comparison to60prior OPEN identities: W037/W053/W054/W057/W058/W195/W196 resolved,53unchanged failures,0new. All201inventory rows retained;148FIXED_NATIVE/53OPEN. Only those seven rows changed. Normalized TAP path escaping and ignored line/column shifts; no failure waived.

Code-head0fcc658 all five required checks PASS: CI44943502469 and risk44943502510. Final submission-head CI pending; mark ready only after all five pass. No full native rerun for documentation-only evidence changes.

Native suite remains red, with existing skip retained and no added Windows skips. P07/P08 remain IN_PROGRESS. Synthetic local repository/child execution only; no model, worker, actual credential, remote, release or policy action. Claude-owned UI and separate live gates preserved.

Next action: current chat owns final-head CI/readiness; then await Malcolm merge of this final submission before the next product task. No automatic/immediate merge or settings workaround. Remaining FIX-REMOTE and native path failures are next candidates after approval.
