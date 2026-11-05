# Claude handoff — K8 slice 2 for Codex's review, and the engine interfaces proposed for slice 3

```
Packet/subpacket: next-phase K8 (D5). Malcolm accepted the run-wide destination rule on 5 November 2026, and asked
  that slice 2 stay an isolated module, be left ready for Codex's review, and that the engine interfaces be agreed
  with Codex before any integration PR.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW (PR96, ready for review, not merged by Claude).
Baseline SHA: 3842218 (PR95 merge). Code commit: 633f559.
Owned files: new conductor/src/knowledge/{client,evidence}.js and conductor/test/knowledge-evidence.test.js; the
  K8 design note's status line; work-log entries. No existing engine, service, options, secrets, UI or workflow file
  changed, and nothing imports the new module.
Checks: node --test test/knowledge-evidence.test.js 15 pass (contract fixtures from a stub HTTP server). Six
  mutation controls each fail the intended test (some-seat rule, unneutralised end marker, followed redirects,
  fresh-on-error, no second layer, client-runtime allowed). JS withheld_report matches Python
  contract.withheld_report() and passes check_withheld_report for three cases. CI conductor on the PR head
  (633f559): 1639 tests, 1636 pass, 0 fail, 3 skipped. A local full-suite run hung in test/service/engine.test.js
  after 12 minutes and was stopped: this container has no orphan-reaping wrapper, the known 05-validation.md trap;
  CI is the full-suite evidence. All synthetic: no knowledge service, no model.
Review asks (Codex): the client's trust boundary (private-origin check, token handling, redirect refusal, body cap,
  strict parsing) and the evidence rule (run-wide intersection, per-call second layer, end-marker neutralising,
  fail-closed freshness).
```

## Proposed engine interfaces for slice 3 (please agree, amend or refuse before any integration PR)

Narrower than design note §6. Evidence is fetched lazily on the first agent call, not in `planPhase`, because a
resumed run does not re-plan. That removes the `planPhase` seam.

1. **`src/options.js`** (shared): `DEFAULT_OPTIONS.knowledge = null`. When set:
   `{ url, collections?, maxPassages?, maxChars? }`. Validated in `config.js`; `url` through `checkKbUrl`.
2. **`src/secrets.js`** (high-risk; Malcolm merges): add the fixed name `CONDUCTOR_KB_TOKEN` to `SCRUB_ENV`. No model
   CLI then inherits it, and `redact()` scrubs its value from every prompt. The token lives only in that variable:
   there is no `tokenEnv` option, so the scrub list stays static.
3. **`src/runlog.js` `callAgent`** (shared), only when `ctx.options.knowledge` is set:
   - Once per run, a new `assembleEvidence(ctx)` in `src/knowledge/` sets `ctx.state.evidence`. It reads the token,
     takes the seats `[team.author, team.reviewer, team.local]`, then calls `collections()`, `search({ query:
     ctx.request })` and `selectEvidence`. Any error sets it to `{ unavailable: true }` with one event; the run
     continues without evidence.
   - Before each call carrying evidence, `stillFresh()`. If it is false, the evidence is dropped for the rest of the
     run, with one event.
   - The block goes in `callRole`'s existing `context` argument, which is `''` today. `callRole` already redacts it,
     and the adapters already put it after the task.
   - Not persisted: `ctx.state.evidence` holds passages for this process only, and Resume re-fetches.
4. **Engine events** (shared):
   - `evidence-used` `{ count, viewRevision, evidence }`, with no excerpts.
   - `evidence-withheld` `{ report }`, one per `withheld_report()`.
   - `evidence-dropped` `{ reason }`.
5. **`src/service/runs.js`** (Codex, high-risk): map those engine events to run events for the operator's log
   only. They never become prompt text, which engine events are not today. No API shape change beyond the event
   messages.
6. **UI** (Claude, slice 4): activity-log sentences for the three events, and a run-page note naming the withheld
   collection and its allowed destinations.

Questions for Codex:
- Is `callAgent` the right place for the freshness call, given its added latency (one `GET /collections` per call)?
  The alternative is one check per phase.
- Should `config.js` refuse `knowledge` in factory/council runs for now?

Next: after Codex's review of PR96 and agreement on the above, slice 3 is one PR. It touches `secrets.js`, so
Malcolm merges it.
