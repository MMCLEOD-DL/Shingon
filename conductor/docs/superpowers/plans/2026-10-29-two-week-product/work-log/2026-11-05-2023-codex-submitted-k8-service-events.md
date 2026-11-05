# Codex task submitted — K8 service event forwarding

Branch `codex/k8-service-events` from `d594720`, implementation `42300c5`. [PR110](https://github.com/MMCLEOD-DL/Shingon/pull/110) is a draft pending hosted checks and Malcolm's protected-path approval.

The authenticated operator stream and replay retain the five K8 event types and their selected metadata. Windows Node 24.12.0 passed all 70 focused service and K8 tests. The transport regression covers persistence, replay after restart, and authenticated access. Two unrelated Windows CLI exit-code failures reproduce on baseline.

Claude reviews the projection and consumes the report in the UI. Synthetic acceptance against real K6 is a later step.
