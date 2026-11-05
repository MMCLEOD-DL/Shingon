# Teaching the local model Hoon: design note

Status: **proposal, for Malcolm's decision.** Nothing here is built or approved.
Written 5 November 2026 by Claude, from a conversation with Malcolm on 31 October 2026.

## The goal

Malcolm wants a local Qwen model to write Hoon, the language of the Urbit project, well enough to do real work
through Conductor. Public Hoon code is scarce, so the model cannot learn it the usual way, from a large body of
examples. The idea is to manufacture the experience instead: let the model write Hoon, check every attempt against the
compiler and tests, and train it on what works.

This is a sound idea with a well-known shape: **generate attempts, keep the ones a checker accepts, train on them,
repeat.** It is variously called rejection sampling, expert iteration or self-training. With the checker's verdict used
directly as a score, it is reinforcement learning from verifiable rewards. This note sets out how to do it so the
result is a model that writes *correct* Hoon, not just Hoon that compiles. It also says what to measure first, before
any money or weeks go into training.

## What Conductor is, and is not, for here

Conductor can already put a compiler in its loop: its test command can be any command, so a script that compiles the
Hoon and runs its tests makes "does not compile" count as a failing test. With the P08 F8 change (merged 1 November
2026), a failing test now blocks a step by itself, and the coder retries with the error.

Conductor is **not** the training loop, for three reasons.

- **Cost:** every attempt gets a review from a subscription model. Training needs tens of thousands of attempts.
- **Attention:** every result waits for your approval.
- **Terms:** Anthropic's and OpenAI's terms restrict using their models' outputs to develop competing models. That
  rules out Claude or Codex reviews or fixes as training data. Check the current terms before relying on this summary.

So there are two separate tools:

1. A **training harness**: local model, compiler and tests only, unattended, no subscription calls.
2. **Conductor**, which uses the improved model afterwards, with the Hoon compiler and tests as its test command, on
   real Urbit projects.

## Five rules that make the data trustworthy

1. **Reward behaviour, not compilation.** A model rewarded for "it compiles" learns to satisfy the compiler. Hoon
   makes this easy: `!!` (crash) type-checks anywhere, and stubbing out the hard part often compiles. Every task needs
   tests that check what the code *does*. A pass means "compiles and passes its tests".
2. **Tests are written before, and apart from, the model's attempts.** The model never sees or edits them. A task's
   tests are frozen when the task is added.
3. **Flag shortcuts.** Reject or inspect passing attempts that contain `!!` where a value is expected, that are
   suspiciously short, or that hard-code test inputs. Keep a sample for human spot checks.
4. **Keep a held-out set.** About 20% of tasks are never trained on. Progress is measured only on them.
5. **Only the local model's own attempts and the compiler's output go into training data.** Real Hoon written by
   people (see Stage 2) can be added, under its own licence. No Claude or Codex output goes in.

## The stages, with a decision after each

### Stage 0: prove the tooling (a few hours)

Show that a script can compile one Hoon file and run its tests **without a person at the keyboard**, and measure how
long one check takes.

- **What to verify:** Hoon is normally built inside a running Urbit ship. The expected route is a local test ship (a
  "fake ship", started with no network) kept running, with the script copying code in, committing it and reading the
  result. The exact commands, and whether Urbit's test runner can report pass or fail in a way a script can read, are
  to be confirmed against the current Urbit documentation. This note does not assume them.
- **Decision:** if one check takes seconds, brute force is practical. If it takes minutes, the number of attempts per
  night drops by two orders of magnitude, and the plan has to lean on fewer, better attempts.

### Stage 1: measure today's model (a day)

Write **20 to 30 small Hoon tasks with tests**: the kind of exercises Hoon School teaches, from simple arithmetic up to
list and map handling and one small app. Ask the current Qwen to solve each task **10 times**.

Record three numbers:

- how often an attempt compiles;
- how often it passes its tests (pass@1);
- how many tasks it solves at least once in 10 tries (pass@10).

**Decision:**

- **pass@10 is almost zero:** the model knows too little Hoon for brute force to find anything. Go to Stage 2 first.
- **pass@10 is useful (say 20% or more), even if pass@1 is low:** brute force has something to work with. Go to Stage 3.
- Either way, this baseline is what every later stage is judged against.

### Stage 2: build the task set, and teach the basics if needed (weeks of part-time work)

- **The task set is the real bottleneck.** Attempts are cheap; tasks with good tests are not. Aim for 200 to 500.
  Sources to mine:
  - Urbit's own open-source code: the Hoon standard library and its tests, and the system's apps;
  - Hoon School and the other exercises on Urbit's documentation site;
  - small tasks written by hand.

  Check each source's licence before copying anything into a dataset.
- **Teaching the basics (only if Stage 1 said so):** fine-tune on real Hoon code first, so the model learns the
  language's shape. This is ordinary supervised training, and short.

### Stage 3: the generate-and-verify loop (overnight runs)

For each training task:

1. Sample several attempts (say 8).
2. Compile and test each one.
3. Keep:
   - attempts that pass, filtered by the five rules;
   - **error-and-fix pairs**: an attempt that failed, the compiler's error and a later attempt that passed. These teach
     the model to use the compiler's feedback, which is how it will work inside Conductor.
4. Fine-tune on what was kept.
5. Re-measure on the held-out set.
6. Repeat while the held-out score keeps rising.

A later step, if this works, is reinforcement learning with the test result as the reward. It is more effective, but
more work to set up.

## Hardware and models

- **The current local model cannot be trained as it is.** It is a 27-billion-parameter model in compressed 4-bit form,
  which is fine for running it and unsuitable for training. Fine-tuning needs the original-precision weights, using a
  memory-saving method (LoRA, or QLoRA on a 4-bit copy).
- **On one 24 GB graphics card,** a 27B model is at the edge of what QLoRA can train, with short examples only. That is
  an estimate, to be confirmed.
- **Recommendation:** prove the whole loop on a **smaller Qwen (about 7B to 14B)** first. If the curve rises there,
  scale up. If it does not, nothing much was spent finding out.
- **Licences:** confirm the licence of the exact Qwen release being trained, and that it allows fine-tuning and use.
- **Sharing the GPU:** training and Conductor's local model both need the graphics card, so they cannot run at the
  same time. Overnight training means no local model for Conductor overnight.

## What could go wrong

| Risk | Effect | Guard |
|---|---|---|
| The model learns to game the checks | High pass rate, useless code | Rules 1–3; human spot checks on a sample of passes |
| Too few, too easy tasks | It overfits the task set | Held-out set (rule 4); grow and vary tasks before scaling |
| It forgets other languages | Worse at everything else Conductor asks | Mix some general code into each training round; re-check a few non-Hoon tasks |
| One check is slow | Too few attempts per night | Measured in Stage 0; keep the test ship warm, run checks in parallel |
| Hoon changes underneath | Trained on an old version | Pin the Urbit version per run; record it with the data |

## Where this would live

This is a separate project from Conductor. It needs a GPU and a running Urbit test ship, so the harness would run on
the Windows desktop (or a Linux machine with the card), and its datasets and checkpoints would never go into the
Shingon repository.

Conductor's only changes would come at the end: a Hoon project template whose test command runs the compiler and
tests, and the improved model as the local participant.

## Recommendation and next step

Do **Stage 0 and Stage 1 only**, then decide. Together they cost a few days of part-time work and no training. The
Stage 1 numbers say whether to build the task set, teach the basics, or go straight to the loop, and they are the
baseline every later claim is measured against.

**What Malcolm needs to decide:**

1. Go ahead with Stages 0 and 1?
2. Who builds it?
   - Claude can write the harness and the first tasks here, against a stand-in.
   - Running it needs the desktop, Urbit and the local model, so the runs are yours, or Codex's on that machine.
3. Is Hoon the real target, or a test of the approach that could apply to other rare languages too? This affects how
   general to make the harness.
