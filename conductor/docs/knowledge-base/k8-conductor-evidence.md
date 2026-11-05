# K8 design: knowledge-base evidence in a Conductor run

**Status:** proposal, 5 November 2026. Nothing here is built. It needs Codex's agreement on the shared seams (§6) and Malcolm's decision on the forwarding rule (§3) before any engine code. **Packet:** next-phase task K8 ([migration plan](migration-plan.md#implementation-tasks-each-one-separately-reviewable)); it implements D5, which Malcolm accepted ([recommendation](recommendation.md)). **Depends on:** K6 (HTTP API), which is merged.

## 1. What K8 must do (fixed by retrieval contract v1)

From [retrieval-contract.md](retrieval-contract.md) §2, §5, §6, §7 and §11:

- **Credential:** Conductor calls the KB with a project-scoped read token. It is kept with Conductor's secrets, and never put in a workspace, a generated repository or a transcript. The token reaches `reference` collections only; the service refuses to issue one over `client-runtime` data.
- **Destination check before every passage:** before any passage goes into a prompt, Conductor checks the collection's `destinations` (`local-model`, `claude-subscription`, `codex-subscription`). Every hop that could forward evidence applies the rule again: planning, review, fallback, retries and onward forwarding.
- **Fresh policy:** the policy must be current when evidence is assembled. K8 defines how it is re-checked and what happens when it cannot be.
- **Withheld report:** when passages are withheld, the operator gets `withheld_report()`, one per collection and participant. The participant gets only `PARTICIPANT_NOTICE`.
- **Prompt form:** passages go into a delimited, labelled, untrusted evidence block that cites `documentId@versionId` and the locator. Instructions inside evidence are reported, never followed.
- **Context budget:** at most 8 passages and 12k characters per call to a local model; the subscription limit is set by configuration.
- **Evidence never decides anything:** retrieved text never approves a plan, waives a check or changes a test command.
- **Off by default:** with the flag off, no KB request is made ([next.md §3](../operator-app/next.md)).

## 2. Where evidence would enter

The engine has one chokepoint: `callAgent` in `src/runlog.js`. Every agent call goes through it: plan author and reviewer (`planPhase.js`), chunk execution and review (`chunkPhase.js`), final review (`conductor.js`) and council (`council/interpret.js`). Evidence is fetched **once**, for the request, at the start of planning. It is attached per call at the chokepoint, so no phase can forget the destination check.

## 3. The forwarding problem, and the rule I propose

A check on each call alone is **not enough**. Text a participant produces is forwarded onward:
- the plan goes to the rival reviewer;
- the chunk diff, which the local model writes into files, goes to both vendors' reviewers and to the final review;
- reviewer notes go back to producers.

A local-only passage shown to the local model can therefore reach Claude or Codex inside the diff it writes. Taint-tracking model output is not reliable: paraphrase defeats it.

**Proposed rule (run-wide):** a collection's passages may be used in a run only if **every participant who can receive text in that run** is an allowed destination. That set is the author, reviewer and local seats from `buildTeam`. A chunk's fallback is always one of the first two (`chunkRoles`), and the council calls the reviewer seat. Anything else is withheld from the whole run. Each excluded participant is reported to the operator once per collection, with `withheld_report()`. Every participant that could have seen the evidence receives `PARTICIPANT_NOTICE`. The per-call check in §2 stays as a second layer, so a seat added later, for example a fallback the operator approves mid-run, cannot receive evidence it was not cleared for.

**Consequence for Malcolm to accept.** A `local-model`-only collection is never usable in an ordinary run. Ordinary runs always include a subscription reviewer, so such a collection only helps a run whose every seat is local. For D5's first use (Foundation and Conductor docs, coding standards), the collections would allow all three destinations, so nothing changes. The alternative is per-call filtering only, which would leak through diffs and plans. I don't recommend it.

## 4. Policy freshness

- At assembly, Conductor calls `GET /collections`, keeps the `viewRevision` and each collection's `destinations`, then calls `POST /search`.
- Before each `callAgent` that would carry evidence, it calls `GET /collections` again; this is cheap and audited. If the `viewRevision` changed, the KB cannot be reached, or the answer is invalid, the evidence is **dropped for the rest of the run**: fail closed. The operator gets a single event, "Knowledge evidence was removed from this run because its policy could not be confirmed". The call goes ahead without evidence, and the run never pauses for this, because evidence is optional.
- Nothing is cached across runs. Within a run, one snapshot is used, and any revision change ends it.

## 5. Configuration and credential

- `options.knowledge` (off by default) holds:
  - `url`: loopback or private-network only, refused otherwise;
  - `tokenEnv`: the name of the variable holding the project token;
  - `collections`: an optional subset;
  - `maxPassages`, defaulting to 8 for a local model.
- The token variable joins the scrubbed environment list, so no model CLI inherits it. It is passed only to Conductor's own KB client, a small Node `fetch` wrapper with timeouts and a 64 KB body cap that follows the contract's strict response shapes.
- The service's operator UI (P04) shows the setting read-only. Configuring a token through the browser is out of scope.

## 6. Seams and owners

| Seam | File(s) | Owner | Change |
|---|---|---|---|
| KB client + evidence assembly + destination rule | new `conductor/src/knowledge/*.js` | Claude | New module, with no engine imports beyond `options`/`secrets` |
| Attach evidence per call | `src/runlog.js` (`callAgent`) | shared engine | One call to `evidenceFor(ctx, participant)`, which adds the block or notice |
| Fetch once at planning | `src/planPhase.js` | shared engine | One call at the start of planning, only when the flag is on |
| Options and scrubbed env | `src/options.js`, `src/secrets.js` (**high-risk**) | shared; `secrets.js` needs Malcolm | Add `knowledge` to the options; add the token variable name to the scrub list |
| Operator report in the transcript and events | `src/service/runs.js` (**high-risk**, Codex) | Codex | Forward `evidence-withheld` engine events as operator-only run events, never into a participant's prompt |
| Show the report | `conductor/operator-web/**` | Claude | Activity-log line and a run-page note naming the collection and the allowed destinations |

`conductor.js` should not need a change. If the final review needs evidence, it gets it through `callAgent` like every other call.

## 7. Delivery in slices (one PR each)

1. **This note**, with Codex's seam agreement and Malcolm's decision on §3.
2. **KB client and evidence module, unit-tested against the contract fixtures (`knowledge/contract/kb-contract-v1.json`) served by a stub HTTP server in contract shapes.** The real K6 service (Python and PostgreSQL) is exercised in slice 5. The flag doesn't reach the engine yet. Tests:
   - destination rule;
   - run-wide intersection;
   - freshness loss;
   - injection-like passages kept as quoted text;
   - token never in a prompt, log or transcript (keyleak-style).
3. **Engine wiring behind the flag:** `planPhase`, `callAgent`, options, and the `secrets.js` scrub (high-risk, Malcolm merges). Tests:
   - with the flag off, no KB request is made;
   - a synthetic run cites passages;
   - a local-only collection is withheld, and the operator report is emitted.
4. **Service forwarding (Codex) and UI display (Claude).**
5. **Acceptance:** a synthetic end-to-end run against a real K6 service with a synthetic corpus, using stand-in CLIs, covering the contract's `destination-withheld` fixture, which is authored in this slice.

## 8. Out of scope

Hybrid retrieval and reranking (K3/K4); live connectors (K13); client runtime (K12); writing to the KB; evidence in council-only commands; any change to the contract's wire shapes.
