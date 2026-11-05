# Claude task 39: design note, teaching the local model Hoon

```
Packet/subpacket: none (outside the two-week plan). Malcolm asked for it on 5 November 2026, after a conversation on
  31 October about training a local Qwen on Hoon by compiling and testing its own attempts.
Owner and reviewer: Claude; reviewer Malcolm (a decision, not a code review).
Status: IN_REVIEW (proposal).
Baseline SHA: 820501b (PR 84 merged).
Owned files: conductor/docs/research/hoon-local-model.md (new); conductor/docs/RESEARCH-BACKLOG.md (pointer); this
  entry.
What it says: Conductor is not the training loop (subscription reviews per attempt, human gates, and the vendors'
  terms on training with their outputs); a separate local harness is. Five data rules: reward behaviour not
  compilation, tests frozen apart from attempts, flag shortcuts such as !!, a held-out set, no frontier output in
  training data. Stages with a decision after each: 0 prove headless compile-and-test and its speed; 1 baseline the
  current model on 20-30 tasks (compile rate, pass@1, pass@10); 2 build 200-500 tasks, and teach the basics if the
  baseline is near zero; 3 generate-and-verify loop with error-and-fix pairs. Train a 7-14B Qwen first; the 4-bit
  27B in use cannot be trained as it is. Recommendation: Stages 0 and 1 only, then decide.
Checks: documentation only; git diff --check clean. Not verified here: the exact Urbit commands for a headless test
  ship (named as Stage 0's job), hardware limits (stated as estimates), licences (to be checked per source and model).
```
