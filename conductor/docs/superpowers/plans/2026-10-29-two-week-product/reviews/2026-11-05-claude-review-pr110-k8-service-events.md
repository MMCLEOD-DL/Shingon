# Claude review: PR110, K8 evidence events in the operator service

- **Reviewed (merged; post-merge review):** [PR110](https://github.com/MMCLEOD-DL/Shingon/pull/110), merged as `0288411`, implementation `42300c5`. Codex named Claude as the independent reviewer in `work-log/2026-11-05-2022-codex-handoff-k8-service-events.md`.
- **Scope:** `conductor/src/service/runs.js` (`knowledgeEventData` and its call in the worker message handler), `test/service/server.test.js`, `test/fixtures/operator-app/fake-worker.cjs`, `docs/operator-app/interface.md`.
- **Disposition: no defects.** One low note on the engine side (mine), and one presentation note for the UI step that follows.

## What holds (verified)

- **The fields match what the engine emits.** `knowledge/run.js` and `evidence.js` at `0288411` emit:
  - `evidence-used` with `{count, evidence, viewRevision}`;
  - `evidence-withheld` with `{report}`, where the report comes from `withheldReport()`, or the count-only `{collectionId, documents, allowedDestinations: []}`;
  - `evidence-dropped`, `evidence-stopped` and `evidence-unavailable` with `{reason}`.

  The projection keeps exactly these fields and nothing else.
- **Real engine events reach it.** `RunLog.event` spreads the fields at the top level and calls `onEvent`, and the worker forwards every entry (`src/service/worker.js:65`). So the projection sees the real engine's shape, not just the fake worker's.
- **Only the projection is saved or sent.** Anything else on the event never reaches `service-state.json`, the stream or the replay. This covers excerpts, titles, tokens and generic detail or message fields. The report is rebuilt through `withheldReport()` from checked fields, so its message is the fixed wording, not whatever text the event carried.
- **Validation agrees with the engine:**
  - participant names use the same pattern as `evidence.js`;
  - destinations are limited to the contract set;
  - counts are bounded by `MAX_RESULTS`;
  - a view revision must be 64 lower-case hex characters.
- **No participant prompt is touched.** The service only records these events; prompts still come from the engine's evidence policy.
- **Checks** (cloud Linux, Node 22.23.4, synthetic fake worker):
  - `node --test test/service/server.test.js test/service/runs.test.js`: 30 pass, 0 fail.
  - Control: the new transport test, run against `runs.js` from `d594720` (before PR110), **fails**. It passes on `0288411`.

## Notes

- **N1 (low, engine, Claude's):** `selectEvidence` skips a withheld report for a recipient whose name does not match the participant pattern. That happens, for example, with upper-case letters or a name over 64 characters. It is not counted in `unreported` either. Such a participant gets nothing, so the rule holds, but the operator is not told why for that participant. A follow-up could add these to `unreported` so the count-only event covers them.
- **N2 (UI, for the next step):** the service sets the event's top-level `participant` to the excluded participant. The activity log prints it after the line ("… kept from the models by its data policy. — codex"). That reads well enough, but the run-page note should say "kept from codex" plainly, and name the collection and the allowed destinations from `data.report`.

## Not verified here

Native Windows (Codex: 70 focused tests pass), a real K6 service, and browser rendering of the new data. The UI step that follows covers the rendering.
