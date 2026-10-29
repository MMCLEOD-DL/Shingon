# Claude review: P03 inspected recovery and refused-review preservation (PR #12, Codex)

**Reviewer:** Claude. **Date:** 29 October 2026. **Reviewed:** `3c3e32a` on `codex/operator-run-recovery`, merged into `main` as `c0795fb` before this review. This is a post-merge review, done because the ledger asked for it.

**Verdict: approved.** N1 and N2 from [the P03 re-review](2026-10-29-claude-review-P01-P03.md#re-review-of-p03-at-93e65b3-claude-29-october-2026) are resolved. One new low-severity note (N5) concerns earlier code.

## Reproduced (cloud Linux, Node 22.22.0, `main` @ `2948677`)

- `node --test test/service/*.test.js`: **34/34 passed.**
- The PR's tests run against the pre-#12 service code (`13a86f7`, with the new tests and fixtures copied in): **5 fail**. The 5 are N2 drift refusal, inspection-before-landing, N1 real landed-branch reconcile, inspection unlocking recovery once, and persistence failure blocking resume. Codex reported two "representative" failures, so the evidence is stronger than claimed.

## Code read

- **N1, recovery path.** `POST /runs/:id/recover` requires all of the following:
  - an explicit `repositoryInspected: true`;
  - `expectedEventSeq` equal to the run's current event number;
  - `reviewedCommit` equal to the approved commit;
  - a workspace;
  - an idle service.

  It is idempotent per request id, with conflicting reuse refused (409). It records the acknowledgement durably, starts no worker, and leaves Resume as a separate explicit step. It keeps `landingPending` set, so a second crash is still treated as uncertain until the engine reconciles or offers a fresh review.
- **N2, refused review.** When the worker's own digest check fails after approval, it no longer rejects the hook, which the engine would have treated as a user rejection and archived the workspace. It reports `failed` with `reasonCode: 'review-changed'` and `landingState: 'not-started'`. The service then does not set `recoveryRequired`, and the run stays resumable for a fresh review.
- **Fresh result question.** A new result question with a commit clears `landingPending`. The next source write still needs a new approval.

## Notes

| # | Severity | Location | Finding | Suggestion |
|---|---|---|---|---|
| N5 | low, earlier code, not from this PR | `state.js` `opaqueId`; `runs.js` `answer()` (`run.decisionReceipts[id] = …`) | `opaqueId` accepts `__proto__`. In `answer()`, a decision receipt stored with plain bracket assignment under that id is not stored as a key: it replaces the receipts object's prototype and is missing from the saved JSON, so idempotency for that id does not survive a restart. Shown with Node: `receipts['__proto__'] = …` leaves `{}` in JSON. The new `recover()` builds receipts with a computed key in an object literal, which does create an own property, so it is not affected. Only the authenticated local operator can reach this, and the UI sends random UUIDs. | Reject `__proto__`, `constructor` and `prototype` in `opaqueId`, or store receipts in `Object.create(null)` or a `Map`. Add one regression. |
| N6 | follow-up, Claude-owned | `operator-web` | The UI has no "I have inspected the repository" control yet. The run page explains the situation but offers no action; Codex documented the API and CLI routes. | Claude's next UI task: add the acknowledgement with the same safeguards (current event number and approved commit, explicit confirmation, then a separate Resume). |
