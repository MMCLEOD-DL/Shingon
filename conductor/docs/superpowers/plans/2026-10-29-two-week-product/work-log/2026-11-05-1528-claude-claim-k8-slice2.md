# Claude claim: K8 slice 2 (knowledge-base client and evidence module, not wired in)

```
Decision recorded: Malcolm accepted the K8 run-wide destination rule (k8-conductor-evidence.md §3) in chat on
  5 November 2026 ("accept the run-wide rule, carry on"). A local-model-only collection is therefore unusable in an
  ordinary mixed run.
Packet/subpacket: next-phase K8, slice 2 of k8-conductor-evidence.md §7.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_PROGRESS.
Baseline SHA: current main (PR95 merge). Branch: claude/sharp-hypatia-kte0or.
Owned paths: new conductor/src/knowledge/{client,evidence}.js, new conductor/test/knowledge-*.test.js, the design
  note's §3 status line, work-log entries. No existing engine, service, options, secrets or UI file changes: the
  module is not imported by the engine, so no shared seam moves. Seam wiring (slice 3) still waits for Codex's
  agreement on the design's §6.
```
