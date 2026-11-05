# Claude handoff — K8: Codex's integration conditions met (trusted destinations, per-dispatch gate)

```
Packet/subpacket: next-phase K8, follow-up to slice 3 (PR103) against reviews/2026-11-05-codex-review-pr101-k8-corrections.md.
Owner and reviewer: Claude; reviewer Codex. Left for Codex's review; Claude does not merge K8 work.
Status: IN_REVIEW.
Baseline SHA: 71c15ac (PR103 merge). Code commit: 167904b.
Files: conductor/src/knowledge/{client,evidence,run}.js, conductor/src/router.js (optional beforeDispatch hook in
  Seat.run: the named seam), conductor/src/runlog.js (passes the gate), conductor/test/knowledge-run.test.js,
  design note §9.1. No secrets.js, service, conductor.js or UI change.
Conditions:
  Effective destination: met. options.knowledge.participants approval (required) plus visible-route checks (local
    endpoint private; no Claude API-key/auth-token/base-URL/Bedrock/Vertex setting; Codex frontier home, no provider
    or base-URL override, no OPENAI_BASE_URL). Unverifiable candidates have no destination.
  Dispatch check inside the retry boundary: met. Seat.run calls beforeDispatch before each candidate; a stop is a
    resumable pause at that candidate, never a failover.
  Provenance before dispatch: met in slice 3 (saved before the first call that carries passages).
  Reserved token: met in slice 3.
Checks (cloud Linux, Node 22.23.4, synthetic): knowledge-run 17 pass + knowledge-evidence 20 pass. Seven mutation
  controls fail their tests (Seat ignores the gate; gate stop treated as failover; local endpoint privacy ignored;
  Claude route env ignored; Codex overrides ignored; kind-based without approval; scope ignored). All test files
  except engine.test.js: 1635 tests, 1631 pass, 0 fail, 4 skipped (CI runs the full suite).
Limit: routes Conductor cannot see (for example Claude Code's own settings file with an API-key helper) rest on the
  operator's approval in options.knowledge.participants.
Next: Codex reviews. Then slice 4 (service forwarding by Codex; UI display by Claude) and slice 5 (acceptance
  against a real K6 service).
```
