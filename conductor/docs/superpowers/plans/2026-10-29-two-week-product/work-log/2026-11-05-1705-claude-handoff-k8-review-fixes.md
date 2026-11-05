# Claude handoff — K8 module fixes for Codex's PR96 findings, and the revised integration interface

```
Packet/subpacket: next-phase K8. Responds to reviews/2026-11-05-codex-review-pr96-k8-evidence.md (PR100 at 10fd752).
Owner and reviewer: Claude; reviewer Codex (re-review requested before any engine wiring).
Status: IN_REVIEW. The PR is left for Codex's re-review; Claude does not merge it.
Baseline SHA: d7f73e4. Code commit: 8137898. Owned files: conductor/src/knowledge/{client,evidence}.js,
  conductor/test/knowledge-evidence.test.js, conductor/docs/knowledge-base/k8-conductor-evidence.md (§9 added; §2,
  §4-§6 marked superseded in part), work-log entries. Still isolated: nothing in the engine imports the module.
Findings and dispositions:
  P1 fallback candidates: fixed. Recipients are every candidate of every Seat (router Seat.run hands the same task
    and context to each); the run-wide rule and the per-call layer use them. Test with a real Seat whose Claude Code
    candidate fails over to an Anthropic API stub: the stub's context carries no excerpt.
  P1 proxy transport: fixed. node:http/https with a fresh agent per request (no global fetch, no global agent).
    Reproduced first (CONNECT to the proxy, zero direct requests); after: zero proxy bytes, one direct request.
    Reverting to the global agent or to fetch fails the test. Redirects refused with an explicit error.
  P1 abstention: fixed. Hits with evidence "none" are never sent; participants get the no-support wording.
  P2 rendered budget: fixed. maxChars bounds the whole rendered block (header, citations, locators, markers,
    notice); whole passages only; maxPassages 1-20 and maxChars 2000-64000 validated.
Interface decisions: all accepted and recorded in design §9 (candidates as recipients, per-dispatch freshness,
  process-local passages with persisted provenance only, stop-before-forwarding after consumption, reserved
  CONDUCTOR_KB_TOKEN that no allow-list can restore, factory/council refusal, structured operator events).
Checks (cloud Linux, Node 22.23.4, synthetic): node --test test/knowledge-evidence.test.js 20 pass (15 + 5 new);
  the 5 new tests fail on the previous module; reverting each fix alone fails its test; earlier controls (every
  seat, end-marker, fresh-on-error, client-runtime, redirect) still fail when reverted. Full Conductor suite: CI
  (a local full run hangs in engine.test.js in this container without its reaper).
Next: Codex re-reviews this PR. Slice 3 (engine wiring per §9; touches secrets.js, so Malcolm merges) starts only
  after that.
```
