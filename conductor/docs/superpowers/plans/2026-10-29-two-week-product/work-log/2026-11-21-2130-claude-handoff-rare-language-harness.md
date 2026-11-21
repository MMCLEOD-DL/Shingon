# Claude handoff: rare-language harness for Hoon Stages 0 and 1

```
Packet/subpacket: research follow-up, conductor/docs/research/hoon-local-model.md Stages 0 and 1
Owner and reviewer: Claude; Codex invited to review
Status: IN_REVIEW
Baseline SHA: 3b71c10 (origin/main)
Result commit(s) / patch artifact: branch claude/rare-language-harness
Owned files and shared seams changed:
  new: conductor/spikes/rare-language/** (harness.js, src/, tasks/node and tasks/hoon, adapters/hoon.example.json,
       test/harness.test.js, README.md, .gitignore)
  also: conductor/docs/research/hoon-local-model.md (one line linking the folder)
  shared seams: none. No change to conductor/src, the service, the operator page or CI.
Contract version: not applicable
```

## What now works

- **`node harness.js tooling --lang <node | adapter.json>`** is Stage 0. Each task gets three probes, and each has one
  right answer:
  - the reference solution must pass;
  - a wrong solution that compiles must come back test-fail, which catches a checker that builds the code and never
    runs the tests;
  - a garbage attempt must come back compile-fail.

  It reports OK or NOT OK and the median check time.
- **`node harness.js measure …`** is Stage 1. Each task is asked N times (10 by default) through an OpenAI-compatible
  chat endpoint, or through a replay file.
  - Every attempt is checked, and the run writes `attempts.jsonl`, each attempt's code and `summary.json` under
    `runs/`, which git ignores.
  - It prints the compile rate, pass@1 and pass@N (unbiased estimator).
  - An attempt whose checker failed, timed out or got an unexpected exit code, or whose model call failed, counts as
    `error`. Errors are left out of the rates.
  - A task with fewer than k counted attempts is left out of pass@k, and the number left out is reported, so one
    error cannot blank the result.
- **Adapters:**
  - `node` is the stand-in: CommonJS checked by this Node.
  - The generic command adapter runs a configured argument list, with no shell, a hidden window and a time limit.
    Exit codes: 0 pass, 1 test-fail, 2 compile-fail, anything else error.
  - `adapters/hoon.example.json` is that adapter's Hoon configuration, with placeholders.
- **Five starter tasks**, the same in both languages: `add-two`, `sum-list`, `count-evens`, `fizzbuzz` and
  `word-count`. Each has a reference solution, a wrong solution and tests.
- **Line endings:** tasks and model replies are read with LF line endings, whatever the checkout did.
- **Checker environment:** the checker gets the path, the temp folders and the home folder, and nothing else. The key
  named by `--key-env` is sent only in the request header, and never written to a record.

## Checks (native Windows 11, Node v24.12.0)

- `node --test spikes/rare-language/test/harness.test.js` from `conductor`: **15/15 pass**.
- `node spikes/rare-language/harness.js tooling --lang node`: **OK, 5 of 5 tasks**. The median check takes 75–125 ms.
- **Full native suite**, `node --test --test-concurrency=4 --test-reporter=tap` from `conductor`, with this branch's
  files in place: **1,763 total; 1,710 pass / 53 fail / 0 skip**, exit 1.
  - All 15 harness tests appear in the TAP output as `ok`. So the default discovery that the `conductor` CI job uses
    picks them up.
  - All 53 failures match OPEN rows in `windows-failure-inventory-2026-11-19.csv`, so none is new. This branch
    changes no shared code, and no failure is in its file.

## Live / fake / skipped / unrun

- Everything ran synthetically: the Node stand-in, a fake command checker, and a local fake chat server on
  127.0.0.1.
- **Unrun:**
  - **The Hoon reference solutions, wrong solutions and tests have never been compiled.** They were written without an
    Urbit ship. Stage 0 on Malcolm's desktop is their first check.
  - The Urbit check script itself does not exist yet. The README gives its contract (input folder, exit codes) and
    deliberately does not guess the Urbit commands.
  - No live model was called.
- Linux CI is unrun until the PR's checks report.

## Open defects or unknowns

- The command adapter's `{dir}` is a Windows path. A WSL-side script must convert it, for example with `wslpath`, as
  the README says.
- Five tasks are fewer than the 20 to 30 Stage 1 asks for. More tasks are added by copying a folder. Stage 0 should
  run first, so the format is proven before more Hoon is written.

## External blocker and exact owner/action

Malcolm, on the desktop:
1. Write the Urbit check script to the README's contract.
2. Fill in `adapters/hoon.local.json`.
3. Run `tooling`, then `measure` against the local model.

## Next packet unblocked

None in Conductor. Stage 1's numbers feed the note's next decision.
