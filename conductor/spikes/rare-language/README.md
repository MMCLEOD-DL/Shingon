# Rare-language harness (Hoon first)

This harness carries out Stages 0 and 1 of [`docs/research/hoon-local-model.md`](../../docs/research/hoon-local-model.md),
which Malcolm approved on 21 November 2026:

- **Stage 0:** prove that a script can check code with no person at the keyboard, and time one check.
- **Stage 1:** measure today's local model on small tasks with tests.

It works for any language. A language is an **adapter** that checks one attempt: does it compile, and do its tests
pass. Hoon is the first real language. A stand-in Node adapter lets the whole loop run and be tested on any machine.

Nothing here trains a model or changes Conductor. Run output goes to `runs/`, which git ignores. Attempt records,
model code and datasets never go into the repository.

## Layout

| Path | What it is |
|---|---|
| `harness.js` | The command line: `tooling` (Stage 0) and `measure` (Stage 1). |
| `src/` | The shared parts: tasks, adapters, the attempt loop, the numbers, the model client. |
| `tasks/<adapter name>/<task id>/` | `task.json` (`id`, `title`, `prompt`), the tests file, a reference solution, and a wrong solution (`wrong.<ext>`) that compiles but fails the tests. |
| `adapters/hoon.example.json` | The Hoon adapter's configuration, with placeholders to fill in. |
| `test/harness.test.js` | Tests. The `conductor` CI job runs them with the rest of the Conductor suite. |

There are five starter tasks, the same five in each language, so the numbers compare directly: `add-two`,
`sum-list`, `count-evens`, `fizzbuzz` and `word-count`. Stage 1 asks for 20 to 30. Add more by copying a folder.

**The Hoon reference solutions, wrong solutions and tests have not been compiled yet.** They were written without an Urbit ship to
hand. Stage 0 is their first check, and fixing any that fail is part of Stage 0.

## Stage 0: prove the tooling

### 1. The stand-in, to check the harness itself

```powershell
node conductor\spikes\rare-language\harness.js tooling --lang node
```

Each task gets three probes, and each probe has one right answer:
- the reference solution must **pass**;
- the wrong solution must come back **test-fail**, which proves the checker really runs the tests and does not just
  build the code;
- a garbage attempt must come back **compile-fail**.

It prints `Stage 0, node: OK` and the median time per check. Stage 0 is OK only when every task gets all three
answers right.

### 2. Hoon

Copy `adapters/hoon.example.json` to `adapters/hoon.local.json`, which git ignores. Point `command` at a check script
you write on the machine with Urbit. The harness runs that command **without a shell**, once per attempt.

It replaces `{dir}` with the attempt's own folder, a Windows path. That folder holds:
- `solution.hoon`: the attempt;
- `tests.hoon`: the task's tests.

The script must:
1. Install `solution.hoon` as `/lib/task.hoon` and `tests.hoon` as a test file in a desk on a local fake ship (no
   network), then commit them. A script under WSL can turn `{dir}` into a Linux path with `wslpath`.
2. Build and run the tests. Every test file starts `/+  *test, *task`, and each test arm is named `test-<task id>`.
3. Exit **0** when the tests pass, **1** when the code built but a test failed, and **2** when it did not build. Use
   any other exit code when the script itself went wrong, for example when the ship is down. That attempt is then
   recorded as `error` and left out of every number, so a broken checker never looks like a bad model.

The exact Urbit commands (committing to a desk, and running `-test` in a form a script can read) must be confirmed
against the current Urbit documentation. This README deliberately does not guess them. Keep the ship running
between checks, because starting one per attempt would dominate the timing.

Then run:

```powershell
node conductor\spikes\rare-language\harness.js tooling --lang conductor\spikes\rare-language\adapters\hoon.local.json
```

**Stage 0's decision** comes from the median check time. A few seconds means brute force is practical. Minutes means
fewer, better attempts.

## Stage 1: measure today's model

```powershell
node conductor\spikes\rare-language\harness.js measure --lang conductor\spikes\rare-language\adapters\hoon.local.json --model-url http://<localai-host>:<port> --model <model name> --key-env LOCALAI_API_KEY --attempts 10
```

- Each task is asked `--attempts` times, 10 by default, at temperature 0.8 (`--temperature` changes it).
- The model server must speak the OpenAI chat API, as LocalAI does.
- `--key-env` names the environment variable that holds the key. The key is sent only to `--model-url`, and is never
  written to a record or printed.

The run writes three things to `runs/measure-<adapter>-<time>/`:
- `attempts.jsonl`: one line per attempt, written as it finishes;
- `code/`: each attempt's code;
- `summary.json`: the totals.

It prints the three Stage 1 numbers:
- how often an attempt **compiles**;
- **pass@1**;
- **pass@10**, from the unbiased estimator. With 10 attempts this is the share of tasks solved at least once.

An attempt whose checker failed or timed out, or whose model call failed, counts as an `error`. Errors are reported,
but left out of the rates. A task that loses attempts to errors has fewer than `--attempts` counted attempts. pass@k
then leaves that task out, and the summary says how many tasks it left out (`passAtExcluded`).

`--replay <file.json>` uses saved replies instead of a model, in the form `{"<task id>": ["reply", ...]}`. Use it to
re-check old replies against a fixed checker.

## Safety

- **Model-written code runs on the machine that runs the checker.** For Hoon it runs inside the fake ship. The Node
  stand-in runs JavaScript directly, so use it with the replay files and reference solutions here, not with a live
  model, unless the run is on a throwaway machine.
- The checker gets a cut-down environment: the path, the temp folders and the home folder. It gets no keys or tokens.
- Commands run without a shell, with a hidden window and a time limit (5 minutes by default for the command adapter).
- Nothing here calls a paid API, connects to another machine or starts a model. The model server and the Urbit ship
  are the operator's own.
