# Claude review: P01 and P03 (with P00 interface acknowledgement)

**Reviewer:** Claude. **Date:** 29 October 2026. **Reviewed:**
- P01 on `codex/update-settings-safety` @ `b25e2bfcafd33112ef8260f48ecb96f4edc90400`
- P03, plus the P00 interface it publishes, on `codex/operator-app-v1` @ `a8c97bc597f1b04919dc790d165f264d4dfb7d15`

Known deferrals read first: `2026-10-27-factory-acceptance/FOLLOW-UPS.md`. Nothing below repeats an item from that list.

Severity scale: **blocking** = must be fixed or explicitly waived by Malcolm before integration; **should-fix** = fix in this packet unless the owner argues otherwise; **note** = optional.

## P01: updater after a post-rename settings failure

**Verdict: approve once R1-1 is answered (no blocking findings).**

**Reproduced (cloud Linux, Node 22.22.0, local PostgreSQL 16 for `TEST_DATABASE_URL`):**
- Focused ops files (`update-settings-safety`, `update`, `compose`, `set-env`, `journal`, `update-cli`): **125/125 passed** on `b25e2bf`.
- With `update.ts` reverted to `a8ffb91`, the new file fails **4 of 5** (directory-open, directory-sync, restore-sync, unreadable tag). Only "before-rename" passes, which is correct because that path was already safe.
- Without `TEST_DATABASE_URL`, `update-cli.test.ts` fails 5 tests both with and without the change, so those failures are environmental. The handoff's "110 focused tests" is a smaller file set, not a contradiction.

The fix does what the packet asks:
- The read-back distinguishes pre-rename failure from post-rename uncertainty.
- The new image is never started without migrations.
- The rollback message no longer claims `.env` "still names" a tag it could not read.
- The journal survives `rollback-failed`.

| # | Severity | Location | Finding | Suggested change |
|---|---|---|---|---|
| R1-1 | should-fix (owner's call) | `update.ts` writeTag catch → `rollback(...)` | After a post-rename failure **nothing has migrated and the app has been stopped since the backup**, yet recovery runs the full `restoreDb` (database **and** uploads) from the backup just taken. It is safe, but it is redundant work on the slowest path. It also adds a failure point that can turn a harmless state (only `.env` uncertain) into `rollback-failed` / URGENT / "the app may be down". | A settings-only undo first: `writeTag(from)`, then `readTag() === from` → start the old app and report "update cancelled; settings restored; backup <id> kept". Fall back to the full `rollback` only if that fails. If you keep the full restore deliberately (one well-tested path), say so in a code comment and I'll accept it. |
| R1-2 | note | `runUpdate` journal clear | Keeping the journal after `rollback-failed` means `ops check` then reports "stopped part-way (step undo-failed)" alongside the URGENT alert. That is consistent with the runbook table and `--mark-recovered`, so this is acceptable. It does change existing behaviour, though: previously the stored URGENT row replaced the journal. | Add a line to `foundation/CHANGELOG.md` [Unreleased]. The other Foundation fixes record behaviour changes there (P02 does). |
| R1-3 | note | test | The `restore-sync` case fails every directory sync, including the forward write's, so it also exercises "forward write uncertain → rollback". | Optional: a case where only the *restore* write's directory sync fails, to pin "forward OK, migration fails, restore write uncertain". |

## P00 interface (as published in `interface.md` and `contract-v1.json`)

**Acknowledged as the UI's working contract for P04.** I'll build the UI against `contract-v1.json` at `a8c97bc` and raise any change through the work log rather than diverging. The two points below need agreement before the fixture set is called frozen.

| # | Severity | Finding | Proposal |
|---|---|---|---|
| I-1 | should-fix | The contract promises "a successful engine result racing ahead of cancellation remains a known completed result". The implementation does the opposite (P3-1). | Fix the implementation (preferred) or the sentence. Either way, add a fixture for "cancel requested after approval". |
| I-2 | note | One bootstrap per service start, single use, 5 minutes. If the first POST `/session` is lost (tab closed mid-request), the operator must restart the service. | Acceptable for v1. The UI will say exactly that. Record it in `acceptance.md` as a known limitation. |

## P03: local operator service

**Verdict: changes requested (one blocking finding).** I read every file in the diff: `server.js`, `runs.js`, `state.js`, `worker.js`, `lease.js`, `platform.js`, `exec.js`/`workspace.js` changes and the launcher. I ran one reproduction, below. The full Conductor suite was not re-run here; it would have competed for CPU with the Foundation suite.

The trust boundary is solid:
- exact Host and Origin checks, `Sec-Fetch-Site`, and a fragment bootstrap feeding an HttpOnly/SameSite=Strict cookie;
- timing-safe comparisons;
- a body limit, path confinement for assets, and a strict CSP;
- the decision persisted (`event()` → `save()`) **before** `child.send`;
- approval evidence re-checked against the live workspace (HEAD, clean, redacted diff) in both the service and the worker;
- API keys removed from the worker environment;
- the worker isolated per run, so `killAllChildren` cannot reach another run.

| # | Severity | Location | Finding | Evidence | Suggested change |
|---|---|---|---|---|---|
| P3-1 | **blocking** | `runs.js` `launch()` message handler (`if (finished \|\| run.status === 'cancelling') return;`) + `cancel()` + `worker.js` `on('disconnect')` | **Cancel after approving a result can leave a branch in the source repository while the run says `interrupted`, with `landedBranch: null`.**<br>1. `cancel()` disconnects the worker during landing.<br>2. The worker's disconnect handler kills its children and exits mid-operation.<br>3. Any `finished` message already in flight is dropped because the status is `cancelling`.<br>This breaks the master plan's Cancel row ("outcome and resume options truthful"), the contract's own race sentence, and the related rule in the contract's browser safeguards. With a real workspace, `resumable` may be `true` as well, inviting a resume over a half-landed result. | Reproduction (fixture worker that creates the branch, then reports `finished` 300 ms later; cancel 100 ms after approval). Output: `status: interrupted landedBranch: null branch in source repo: "conductor/landed"`. Test text below. | (a) Once an approved `result` answer has been sent, `cancel` returns 409 "landing in progress"; or it records the request without disconnecting and lets the worker finish.<br>(b) Never drop a `finished` message because of `cancelling`.<br>(c) If the worker exits after an approved result without `finished`, mark the run `interrupted` with `resumable: false`. Add a reason to check the source repository for the expected branch (or check it in the service) before any resume is offered. |
| P3-2 | should-fix | `server.js` static assets | A missing asset (`realpathSync` ENOENT) or a malformed escape (`decodeURIComponent` URIError) becomes **500 "internal"**, not 404. That adds noise to the error log and makes the browser show a server fault. | Read from code. | Catch both and throw `ServiceError(404, 'not-found', …)`. |
| P3-3 | note | `server.js` rate limiter | The 300/min budget is counted before authentication, so any local process can exhaust it and lock the operator's UI out (429) without the cookie. It is local-only and low impact. | Read from code. | Count unauthenticated requests separately, or only after the cookie check (the bootstrap POST has its own single-use gate). |
| P3-4 | note | `runs.js` coverage | `vendors.length < 2` marks every run that didn't use both vendors as weakened, including runs where routing deliberately used one. That is safe (it over-reports), but the reason text "Both subscription vendors did not complete calls" will look alarming on a routine run. | Read from code. | Keep the flag, and word the reason as fact: "Only <vendor> completed calls in this run." |
| P3-5 | note | `interface.md` | `POST /participants/:id/probe` holds the HTTP request open for the whole probe, which can last minutes for authenticated or agentic probes. The UI needs a known upper bound to show progress and avoid a fetch timeout. | Read from code. | State each probe kind's timeout in `interface.md`. The UI will show elapsed time and "this uses subscription allowance". |

### Reproduction for P3-1

Place in `conductor/test/fixtures/operator-app/slow-land-worker.cjs`:

```js
// Review repro: approval lands a branch, then reports "finished" only after a delay (as real landing takes time).
const { execFileSync } = require('node:child_process');
if (process.argv.includes('--operator-worker')) {
let repo;
process.on('message', msg => {
  if (msg.type === 'start') {
    repo = msg.repoDir;
    process.send({ type: 'event', event: { type: 'start' } });
    process.send({ type: 'question', id: 'd1', kind: 'result', payload: { summary: 's', diff: '+x', tests: { ran: true, passed: true, code: 0 } },
      evidence: { commit: 'a'.repeat(40), diffId: 'x', testReportIds: [] } });
  }
  if (msg.type === 'answer' && msg.value === true) {
    execFileSync('git', ['-C', repo, 'branch', 'conductor/landed']);
    setTimeout(() => { process.send({ type: 'finished', outcome: { status: 'landed', branch: 'conductor/landed' } }); process.disconnect(); }, 300);
  }
});
process.on('disconnect', () => process.exit(0));
}
```

Test steps, using the `setup()` pattern from `server.test.js`:
1. Start a run and wait for `awaiting-decision`.
2. POST `approve` with the shown revision and commit.
3. Wait 100 ms, then POST `/cancel`.
4. Wait for a terminal status.
5. Assert that the run does not report `interrupted` with `landedBranch === null` while `git branch --list conductor/landed` is non-empty.

On `a8c97bc` it fails with the output above.

## Disposition

- **P01:** approve, subject to the owner's answer on R1-1. The CHANGELOG line (R1-2) can ride along.
- **P03:** changes requested for P3-1, with the fix verified at a new commit. P3-2 is should-fix; P3-3 to P3-5 are optional.
- **P00:** the interface is acknowledged for UI work. It is not called frozen until I-1 is settled and its fixture added.

Re-review: send the new SHA. I'll re-run the reproduction and the service tests.

## Re-review of P03 at `93e65b3` (Claude, 29 October 2026)

**Verdict: P3-1 resolved. P03 approved.** I/1 is settled too, with fixtures `landingRun` and `uncertainLandingRun` added. P3-2, P3-4 and P3-5 are addressed; P3-3 remains an accepted note.

**Reproduced (cloud Linux, Node 22.22.0, on `main` @ `13a86f7`, which contains `93e65b3`):**
- `node --test test/service/*.test.js`: 29/29 passed.
- **The new regressions fail on the old code.** Codex's four new tests (cancel after approval, worker loss after approval, static-asset 404s, restart during landing) fail 4/4 when run against `a8c97bc`, and pass on `93e65b3`.
- **Code read.** `landingPending` is persisted (through `event()` → `save()`) **before** `child.send(answer)`. `cancel()` refuses with 409 `landing-in-progress` after that boundary. A `finished` message is no longer dropped while cancelling. Worker error, worker exit and service restart all set `recoveryRequired` and disable resume.
- **Browser, in-tree** (the step that was blocked on Codex's host): `operator-web/e2e/journey.mjs` with `--service ..` passed 15/15 in Chromium, including two new landing steps run with `slow-land-worker.cjs`:
  - (a) after approval, Stop is never offered while landing;
  - (b) if the worker is lost after approval, the UI explains that the repository needs inspecting, offers no Resume, and the branch is really there.

**One UI race found and fixed in this PR (Claude-owned file).** Between an accepted approval and the next snapshot, `RunView` still showed Stop and the answered question. A refresh already in flight with the pre-answer snapshot could bring them back. The fix offers no actions from a snapshot until its `lastEventSeq` has passed the answer. A new unit test fails without the fix and passes with it. The service already refused a Stop sent in that window (409), so this was misleading but never unsafe.

**Notes (non-blocking):**
- **N1:** `recoveryRequired` has no way out in the app. Resume is refused permanently, and the text says "inspect its branches before recovering this run", but there is no recovery action and no CLI pointer. Suggest one sentence in `setup.md` on how to recover (for example, the CLI resume path for that workspace), or a later explicit "I have inspected the repository" decision.
- **N2:** a worker that refuses after approval because the evidence changed (it re-checks the digest) also ends as `recoveryRequired`, even though nothing landed. That is conservative and acceptable for v1. A distinct outcome reason would let the UI say "nothing was landed".

## Re-review of P01 at `06678be` on `codex/updater-settings-recovery` (Claude, 29 October 2026)

**Verdict: approved.**
- R1-1 is resolved: a settings-only undo now runs before any full restore.
- R1-2 is resolved: the changelog entry is there.
- R1-3 is resolved: the restore-only and rollback-only flush cases are covered.

This branch supersedes `codex/update-settings-safety`, which should not be merged. PR: MMCLEOD-DL/Shingon#6.

**Reproduced (cloud Linux, Node 22.22.0, local PostgreSQL 16 test role):**
- **Focused files** on `06678be` (`update-settings-safety`, `update`, `compose`, `set-env`, `journal`, `update-cli`): **129/129** passed.
- **Against `main`'s `update.ts`**, the new file fails **8 of 9**. Only "before-rename" passes, which is correct because that path was already safe.
- **Full Foundation lint, typecheck and `npm test`** on the branch's files: see the work-log entry for this review.

**Code read:**
- **Read-back.** After a failed tag write, the updater reads the tag back. If it says the old version, it runs the pre-change restart: nothing changed. Otherwise it durably writes the old tag **and** reads it back before restarting the old app, reported as cancelled with the backup id. Any doubt falls through to the full `rollback`. The target image is never started without migrations, and the database and uploads are untouched on the settings-only path.
- **The cancelled-with-backup-id outcome does not trip the "earlier failed update" guard.** `outstandingUpdate` (`ops/src/runs.ts`) matches only the rollback-failed marker in the run detail, not the presence of a snapshot.
- **Journal.** `rollback-failed` keeps the journal, and the change is now in the changelog. The settings-only path ends with `mark('finishing')` and the normal clear, once the outcome row is stored.

**Notes (non-blocking):**
- **N3.** In the settings-only path, if `mark('finishing')` cannot be written and the outcome row is not stored either, the journal stays at `switching`. The runbook reads that as "`.env` may name either version", which is true and conservative. Nothing to change.
- **N4.** "backup X was kept" means only that it was not deleted. It is not protected from normal pruning. That is fine for a cancelled update, but a reader could take "kept" as "pinned". Optional wording: "backup X (taken before the update) is available".
