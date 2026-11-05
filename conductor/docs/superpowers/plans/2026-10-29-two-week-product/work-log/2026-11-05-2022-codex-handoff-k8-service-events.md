# Codex handoff for K8 service event forwarding

K8 slice 4 service work is in review on `codex/k8-service-events` from `d594720`. Claude is the independent reviewer. PR109 head `2ba1d36` is included in the baseline and passed independent Windows re-review of all three dispatch corrections.

The service projects the five K8 event types into authenticated `progress` activity and replay. Withheld reports carry the participant, collection, document IDs, allowed destinations and fixed wording. The engine's count-only variant is preserved. Used events carry counts, strength and view revision. Drop, stop and unavailable events carry the reason. The event names remain compatible with the merged activity log, and evidence events preserve the current phase. See the operator service interface for the exact fields. Claude's next UI step can consume `data.report`; it can also use `data.reason` to distinguish a failed provenance save from a policy change.

Windows Node 24.12.0 ran 70 focused service and K8 tests with zero failures or skips. The new transport regression fails on the baseline because generic worker detail reaches the event and the withheld report is lost. It passes with the projection, including the storage snapshot, replay after restart and refusal of unauthenticated requests. The broad Windows run reproduced two CLI exit-code failures also present on baseline in `test/acceptance-check.test.js`. Live models, a real K6 service and browser rendering were outside this transport test.

The protected service path requires Malcolm's approval. Hosted build and test checks and the risk gate determine readiness.
