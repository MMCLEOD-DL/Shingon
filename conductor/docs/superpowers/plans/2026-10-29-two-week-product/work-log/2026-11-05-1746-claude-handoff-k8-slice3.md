# Claude handoff — K8 slice 3: evidence wired into ordinary runs (design §9)

```
Packet/subpacket: next-phase K8, slice 3. Malcolm: "go ahead with slice 3" (5 November 2026), ahead of Codex's
  re-review of PR101's module fixes; Codex reviews this PR with that.
Owner and reviewer: Claude; reviewer Codex. Merge: Malcolm (src/secrets.js is a high-risk path).
Status: IN_REVIEW.
Baseline SHA: 78176a8 (PR101 merge). Code commit: 96cc045.
Files: new src/knowledge/run.js; seams named in §9: src/runlog.js (callAgent: 9 lines), src/options.js (knowledge:
  null), src/config.js (validation call), src/secrets.js (reserved CONDUCTOR_KB_TOKEN), src/wake.js (skip reserved
  name), src/cli/{main,factory,factoryBuild,change}.js (refusals), src/knowledge/evidence.js (evidenceFor), tests.
  conductor.js, the service and the UI are unchanged.
How §9 is met:
  - Recipients are every candidate of the author, reviewer and local seats (the module's rule, unchanged).
  - Per-call freshness: every callAgent with knowledge on (or with evidence already used) re-reads the policy
    before dispatch; fallback attempts go through the same Seat call, so they share that check.
  - Process-local passages: a WeakMap keyed by the run's state object (also safe if ctx is copied); state.knowledge
    holds { sent, scope, origin, viewRevision } only, saved as soon as evidence is first sent.
  - Before evidence is used, a lost policy drops it (one event) and the run continues. After, a call that cannot be
    confirmed returns failure 'no-participant', which the plan, chunk and final-review paths already turn into a
    resumable pause, so nothing derived is sent. On Resume the saved scope, origin and revision must still hold.
  - CONDUCTOR_KB_TOKEN: childEnv drops it in any spelling whatever the allow list (so git, test commands, model CLIs,
    council gates and probes never see it); addScrubEnv refuses it (local envKey and wake.env); runWakeCommand skips it.
  - options.knowledge off by default; validated in loadConfig (private origin, known settings, bounds, not with
    council); --council, conductor build, conductor change and the factory refuse it; council/factory runs never
    fetch (backstop).
  - Events: evidence-used {count, evidence, viewRevision}, evidence-withheld {report}, evidence-dropped,
    evidence-stopped, evidence-unavailable {reason}; no excerpt is logged or saved.
Checks (cloud Linux, Node 22.23.4, synthetic): test/knowledge-run.test.js 13 pass (stub service, fake participants,
  real Seats and RunLog; two whole runs through runTask/resume). Six mutation controls fail their tests (token not
  reserved; no stop after use; passages in state; no council/factory backstop; no freshness check; wake passes the
  name). All test files except test/service/engine.test.js: 1631 tests, 1627 pass, 0 fail, 4 skipped (engine.test.js
  hangs locally without the reaper; CI runs the full suite).
Known edge, recorded not changed: when the local seat's call is stopped, chunkPhase treats it like a local failure
  and moves to the frontier fallback, whose call is stopped too, so the step pauses one call later; nothing is sent.
For Codex (not changed here; high-risk factory/ship path): src/factory/ship/build.js:134 passes the raw process env to
  git bundle, so any secret in the operator's environment, CONDUCTOR_KB_TOKEN included, reaches that git child.
  Factory runs refuse options.knowledge, but the variable can still be set in the shell.
Next: Codex reviews (PR101 fixes and this). Slice 4: the service forwards the evidence-* events to the operator's
  log (Codex); the UI shows them (Claude). Slice 5: acceptance against a real K6 service with a synthetic corpus.
```
