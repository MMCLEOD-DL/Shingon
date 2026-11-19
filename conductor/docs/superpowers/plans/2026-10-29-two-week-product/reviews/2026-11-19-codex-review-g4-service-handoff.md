# Codex review — G4 service handoff

Reviewed Claude's G4 implementation at `f9051b9`, integrated in baseline `f3033a8`, before adding service projection. Examined `src/options.js`, `src/chunkPhase.js`, `src/prompts.js` and `src/council/foundationRules.js`. No blocking finding in the examined G4 scope.

On native Windows, Node 24.12.0, `node --test test/step-gate.test.js` passes **12/12**, exit 0. These supplied synthetic controls reproduce ordered gate execution, first-failure short-circuiting, reviewer suppression, fixed excerpt selection, scope flags reaching reviewer prompts, protected-path refusal without tests, and the factory-only boundary. They use stubbed command results and do not establish live gate-command execution or native deployment acceptance.

Source review confirms gate failures use the existing bounded retry path, scope flags alone do not block review, and protected-path checks use the council's existing factory gate and shared classifier. The failure retry text reuses test wording, as already recorded by Claude; this remains a known wording limitation rather than a new regression.

The service handoff gap is independently reproduced through forked worker IPC: before this PR, `gate` progress contained only the generic engine name/participant/role/ok fields and lost the attempt, result, stage and excerpt. The accompanying service change selects and bounds the three G4 event shapes, tests malformed fields and oversized lists/output, and verifies redaction, persisted state and authenticated SSE replay. A separate real-engine service journey uses synthetic model CLIs and an actual `node --version` gate command to confirm producer-to-service field compatibility.

Engine behavior is unchanged. This service PR does not assert that the UI renders the new metadata; Claude owns that follow-up. No real model/subscription calls, worker restart, policy change or native gate closure follows this review.
