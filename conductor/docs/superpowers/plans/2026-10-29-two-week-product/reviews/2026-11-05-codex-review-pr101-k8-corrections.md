# Codex review of PR101 and slice 3 handoff

Reviewed `9d8e3bc927f278ebc50c659bcff9382e6fc42ad4` (code `8137898`) on its merge `78176a8`. The four module findings from PR100 are closed. **Claude can start slice 3 using §9 and the integration conditions below.** This is a review of the isolated module and agreement on the implementation interface.

## Module verification

- Candidate expansion is applied at both selection and formatting. The real Seat test takes the infrastructure failure path, reaches its API stub, and verifies the excerpt is absent. The second check handles an excluded candidate added after selection.
- A request uses a fresh HTTP or HTTPS agent and refuses redirects. The environment proxy fixture starts a separate Node process, asserts zero bytes at the proxy and one request at the target, and passes on native Windows. The previous positive proxy exposure was reproduced independently in PR100.
- A nonempty search marked `none` produces abstention. The budget check includes the rendered citations, locators, envelope and notice, and drops whole passages.
- From `conductor/`, `node --test test/knowledge-evidence.test.js` passed **20/20** on Windows and Node 24.12.0. All five required checks passed on PR101's final head. These runs use synthetic providers and loopback fixtures.

## Integration conditions

**Validate the effective destination before classifying a candidate.** The module's `destinationOf` maps adapter kinds to policy labels. An independent offline control constructed a local adapter configured with `https://example.invalid/v1` and a frontier Codex adapter with a provider override. They still classify as `local-model` and `codex-subscription`. No request was sent. The engine must supply trusted destination identities for the configured endpoint and authentication route, or withhold evidence for an unverifiable candidate. In particular, account for provider overrides and the existing Claude API-key billing route. A private endpoint can itself forward to a different provider, so eligibility must reflect the operator-approved backend rather than address syntax alone. Cover unsupported routes with synthetic cases.

**Place the dispatch check inside the retry boundary.** Prepare evidence lazily in `callAgent` and use the existing context channel. Check the pinned revision and candidate scope immediately before each actual dispatch, including retries inside `Seat.run`. The router's adapter-error handling must preserve a policy stop as a stop. A change in scope after evidence use also blocks forwarding in the task text, such as plans, notes or diffs.

**Persist the provenance before dispatch.** Passages and the client stay on the process-local context. Save the minimal scope, origin, revision and exposure marker before the first call that can consume passages. This lets an interrupted run fail closed even if a candidate received the prompt before returning a result. On Resume, validate that provenance against the rebuilt team and service before sending saved artifacts. An unavailable policy before exposure can drop optional evidence. An unavailable or changed policy after exposure pauses before further forwarding.

**Keep the reserved token within trusted engine processes.** Apply the §9 restrictions to model, Git, test and wake children, including Windows case variants and explicit environment allowlists. The trusted worker needs the service-to-worker handoff. Keep factory and council entry points outside this slice and keep operator evidence events separate from model context.

Acceptance for slice 3 should exercise the ordinary run entry point with the flag off, a successful synthetic evidence run, an excluded fallback, revocation between attempts, interruption and Resume after exposure, and the reserved credential across child boundaries. Claude owns the engine implementation using the named shared seams in §9. Codex owns later service event forwarding. Review the actual wiring and protected changes through the existing gates before any real evidence run.
