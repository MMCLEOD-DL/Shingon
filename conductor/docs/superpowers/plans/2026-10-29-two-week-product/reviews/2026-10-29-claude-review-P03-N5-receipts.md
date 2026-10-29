# Claude review: P03 N5 decision-receipt keys (PR #14, Codex)

**Reviewer:** Claude. **Date:** 29 October 2026. **Reviewed:** `88b8a07` on `codex/decision-receipt-keys` (code), with ledger commit `68f4d07`. The PR was not merged at review time.

**Verdict: approved.** N5 is fixed for every request ID the service accepts, with no change to the ID syntax or the state format. Merging it is Malcolm's call, because `conductor/src/service/` is a high-risk path. A rebase is not needed, but **the branch currently conflicts with `main`** in `04-work-log.md`: PR #15 appended an entry after Codex branched. Codex should merge `main` in and keep both entries.

**Update (23:15 UTC):** Codex merged `main` in (`03b0468`), and #14 was merged as `01350f7`. `git diff 88b8a07 01350f7 -- conductor/src/service conductor/test/service` is empty, so the code on `main` is the code reviewed here.

## Correction to my own N5 note

My note said the plain assignment `receipts['__proto__'] = …` silently drops the receipt, so idempotency is lost after a restart. Codex's reproduction shows that the failure comes earlier, and it is wider than `__proto__`:
- The **read** `run.decisionReceipts[id]` returns an inherited member for `__proto__` (`Object.prototype`), `constructor`, `toString` and `hasOwnProperty`.
- That member is truthy, and its `.identity` is `undefined`, so the **first** valid answer with any of those IDs is refused as `409 conflict`.
- The unsafe write is never reached.

So the defect was a false refusal of four valid IDs, not only lost idempotency for one. Codex fixed both reads and the write together. I reproduced this below.

## Reproduced (cloud Linux, Node 22.22.0)

- `node --test test/service/*.test.js` at `88b8a07`: **45/45 passed.**
- The same tests with `runs.js` from `main` (`d9e88e2`): **9 fail.**
  - 8 HTTP cases: `__proto__`, `constructor`, `toString` and `hasOwnProperty`, each with approve and reject.
  - The real-engine case "concurrent `__proto__` approvals and a restart retry create only one real result branch".
  - The 2 `prototype` cases pass before and after. They are the controls: a plain object inherits no `prototype` member.
- This matches Codex's "8/10 HTTP cases fail, 2 controls pass" plus the engine case.
- Not re-run by me: the full Conductor suite (Codex reports 1,559) and the UI journey. CI runs both on the PR.

## Code read

- Both receipt reads (before and after the asynchronous evidence check) now use `Object.hasOwn`. That second read closes the race between two concurrent same-ID approvals.
- The write `run.decisionReceipts = { ...run.decisionReceipts, [id]: … }` uses a computed key. That always creates an own data property, including for `__proto__`. Spreading also copies an own `__proto__` key as data, and `JSON.parse` on load produces own keys. So receipts round-trip through `service-state.json`, which the tests check directly in the saved file.
- `recover()` already used the same pattern. No other service map is keyed by a caller-supplied ID. Run creation looks requests up with `Array.find`, and decision IDs are compared, not used as keys.
- Copying the receipts object on every answer is O(receipts per run). It is negligible at one decision per step.

## Notes

| # | Severity | Location | Finding | Suggestion |
|---|---|---|---|---|
| N7 | optional | `test/service/server.test.js` | Recovery receipts use the same own-key pattern, but no test sends a prototype-named `clientRequestId` to `/recover`. | One case for `__proto__` on `/recover` would keep the two receipt stores from drifting apart. It is not blocking. |
| — | process | `04-work-log.md` | This is the third time two lanes have conflicted on the single shared log. | This supports moving to one file per entry. That decision is Malcolm's and is still open. |
