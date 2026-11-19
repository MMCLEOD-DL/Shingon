# Codex claim — step gate service events

- Packet: P09 G4 service handoff, supporting P07. Owner Codex; Claude owns subsequent UI rendering.
- Branch `codex/step-gate-service-events`, baseline `f3033a865692d4ae07893e224d1b66b1038c4589`. PR127 final submission verified merged before starting.
- Scope: review G4's merged engine behavior at `f9051b9`, then implement allowlisted, bounded, redacted service progress metadata for `gate`, `scope-flag`, `protected-path` in `conductor/src/service/runs.js`; service IPC fixture/regressions and interface/handoff documentation.
- First action: reproduce dropped metadata, verify gate ordering and scope/protected semantics with synthetic controls, implement service projection and validate persistence/authenticated replay.
- No engine behavior or Claude-owned UI changes; no real model calls, worker restarts, native promotion or policy changes. P09 and P07 retain IN_PROGRESS status.
