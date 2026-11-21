# Claude claim: rare-language harness for Hoon Stages 0 and 1

```
Packet/subpacket: research follow-up, conductor/docs/research/hoon-local-model.md Stages 0 and 1
Owner and reviewer: Claude; Codex invited to review
Status: IN_PROGRESS
Baseline SHA: 3b71c10 (origin/main)
Branch: claude/rare-language-harness
Owned paths: conductor/spikes/rare-language/** (new)
Also changed: conductor/docs/research/hoon-local-model.md (one line linking the folder; Claude's research note)
Shared seams: none. No change to conductor/src, the service, the operator page or CI.
```

Malcolm made these decisions on 21 November 2026, recorded in the note's "Decided" section (PR155):
- go ahead with Stages 0 and 1;
- Claude writes the harness against a stand-in, and Malcolm runs it;
- the approach is general, with Hoon first;
- the code lives in a folder in this repository.

The folder is `conductor/spikes/rare-language/`, beside the other spikes. The `conductor` CI job (`node --test` from `conductor`) picks up its `test/*.test.js` without any workflow change.

**Scope:**
- A language-pluggable harness: a task format, an attempt loop, and the Stage 1 numbers (compiles, pass@1, pass@10).
- A Stage 0 tooling check that runs each task's reference solution and a garbage attempt, and times each check.
- A stand-in Node adapter, so the whole loop is tested here.
- A generic command adapter, with a Hoon example configuration.
- Five starter Hoon tasks.

**Not in scope:**
- The Urbit check script itself, whose commands must be confirmed against the current Urbit documentation.
- Any live model or Urbit run, which is Malcolm's on the desktop.
- Stage 2 and later, and any change to Conductor itself.
