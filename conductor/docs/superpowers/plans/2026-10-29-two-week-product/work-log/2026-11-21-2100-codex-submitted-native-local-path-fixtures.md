# Codex task submitted — native local path fixtures

Packet P07; owner Codex / BlueLake, reviewer Claude invited. Branch codex/native-local-path-fixtures, [PR157](https://github.com/MMCLEOD-DL/Shingon/pull/157). Baseline3b71c10521dd9344d021f73c4a08be5af78c087f includes PR156 final913c0d1, verified merged. Tested codeb45bf886c61dc75f1302a5ba256575543670f422; inventory evidence819c46c. This is the final submission commit.

Test-only changes in cli-factory-build, cli, factory-cli, factory-config and factory-projects: construct native absolute local fixture paths and exact path/message expectations; persist run fixture repository identities in the absolute form produced by real run logging. Existing filtering/newest-first/traversal/config/message checks remain. Config tests distinguish local synthetic key-path expansion from remote POSIX workRoot. No real key/file is read, and no runtime source or host configuration changes.

Native Windows, Node v24.12.0, cwd E:/SHINGON-codex-native-review/conductor:

- `node --test --test-reporter=tap --test-name-pattern='^build outcome text|^listRuns: unfinished|^project new / list|^a bad factory section|^a static host is completed|^factoryConfig: default root|^slugify and validateSlug' test/cli-factory-build.test.js test/cli.test.js test/factory-cli.test.js test/factory-config.test.js test/factory-projects.test.js`: before0pass/7fail/0skip, exit1; after7pass/0fail/0skip, exit0.
- `node --test --test-concurrency=4 --test-reporter=tap`:1,748tests/1,700pass/47fail/1skip/0cancelled, exit1,762335.5775ms. Private TAP shingon-native-local-path-full.tap retained outside Git.
- Exact file/test-name comparison to53prior OPEN identities resolves W006/W009/W061/W062/W063/W108/W109.46prior failures remain; one additional service failure was observed, described below. All201original inventory rows retained;155FIXED_NATIVE/46OPEN. Only seven verified rows changed. Line/column shifts and TAP escaping normalized, no failure waived.

## Additional full-run failure remains unresolved

`test/service/server.test.js`: `decision receipt prototype: approve replays once after restart (N5)` failed with code `data-in-use`, from local service lease acquisition. The lease implementation maps listen failures to a message saying the data directory is in use or its local lease port is occupied. The underlying listen error/port ownership was not captured, so collision, access denial or another cause is not established. The path-fixture changes do not modify this source or test. Root cause and reliable full-suite behavior remain OPEN; do not classify this as an accepted baseline or erase it based on rechecks.

- Exact isolated recheck: `node --test --test-reporter=tap --test-name-pattern='^decision receipt prototype: approve replays once after restart' test/service/server.test.js`:1pass/0fail/0skip, exit0,745.197ms.
- Whole service group recheck: `node --test --test-reporter=tap test/service/server.test.js`:36pass/0fail/0skip, exit0,20514.144ms. Both use synthetic fake-worker/loopback service fixtures; no live model or subscription request.
- This newly observed failure is outside the original201-row inventory cohort and is tracked here separately. Codex / BlueLake owns a diagnostic lease-acquisition follow-up after this task merges; capture the actual listen error with synthetic fixtures and preserve singleton ownership/refusal semantics. No service/lease change was folded into this path-fixture task.

All five required code-head checks PASS: CI44948114825 and risk44948114737. Final submission-head CI pending; mark ready only after all five pass. No full native rerun for documentation-only changes; completed full result remains47fail, not replaced by passing focused rechecks.

Native suite remains red. Existing skip retained, no Windows skip added; P07/P08 remain IN_PROGRESS. No model, worker, actual credential, remote/SSH, release or host policy operation. Claude UI/reserved ownership and other live gates preserved. Next action current chat owns final-head checks/readiness, then await Malcolm merge of final submission before another task. No automatic merge or repository-settings workaround.
