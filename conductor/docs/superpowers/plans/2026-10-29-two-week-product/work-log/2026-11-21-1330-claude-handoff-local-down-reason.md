# Claude handoff: say why the local model is down on the fallback question (next.md item 7.1)

```
Packet/subpacket: P09 next.md item 7, proposal 1 ("Show the reason on every local-down question")
Owner and reviewer: Claude; Codex invited to review, especially the two service lines
Status: IN_REVIEW
Baseline SHA: 85c7154 (origin/main, PR138 merge)
Result commit(s) / patch artifact: a5bd742 on claude/local-down-reason
Owned files and shared seams changed:
  operator-web: src/views/RunView.jsx, tests/views.spec.jsx, tests/fixtures/contract-v1.json
  shared engine seam: src/chunkPhase.js (localWentDown keeps the recheck's {reason, detail}; the
    confirmLocalFallback payload gains localDown when it is known)
  Codex-owned service, named handoff in the claim entry: src/service/worker.js (prepare's fallback ask also sends
    localDown), src/service/runs.js (localDownData: copy onto the decision only for kind fallback and a known code)
  contract: test/fixtures/operator-app/contract-v1.json and fake-worker.cjs, docs/operator-app/interface.md
Contract version: v1, additive optional field `decision.localDown`
```

## What now works

- A `fallback` decision may carry `localDown: {reason, detail}`.
  - `reason` is `unauthorized`, `model-missing`, `worker-offline` or `unavailable`.
  - `detail` is the probe's sentence, scrubbed like other service text and capped at 300 characters, or null.
  - Any other code, or the field on another kind of decision, is dropped. Extra fields are never copied.
- **Before the run:** the reason and detail come from `buildTeam`'s probe. The detail used to be dropped in `worker.js`.
- **Mid-run:** they come from the fresh recheck in `localWentDown`. A probe that throws gives `unavailable` with no
  detail. When the step failure was already classed as unreachable, no probe runs, so the field is absent rather than
  guessed. `payload.reason`, the step's failure text used as the question's prompt, is unchanged.
- **The run page** shows one sentence per code, then "Details: …" through `plain()`:
  - `worker-offline`: "The local model server is running, but its GPU worker is not connected."
  - `unauthorized`: "The local model server refused the key. Check the key in the window that started the app."
  - `model-missing`: "The local model server does not have the model named in your settings."
  - `unavailable`: "The local model server could not be reached, or did not answer in time."

  An absent or unknown code shows the current text only.

## Checks (native Windows 11, Node v24.12.0)

- `conductor`: `node --test test/service/server.test.js test/service/engine.test.js test/chunkPhase.test.js`.
  - On `main` before the change: **96/96 pass**.
  - With the new tests and the old code: **97 pass / 5 fail**. The two that already passed are the unknown-code
    case and the no-probe case, because nothing was passed through before.
  - After the change: **102/102 pass**, exit 0.
- `conductor/operator-web`:
  - `tests/views.spec.jsx`: the 4 new reason-sentence tests failed first, then passed.
  - `npm test`: **113/113 pass**, 4 files (108 before).
  - `npm run build`: pass.
  - `node e2e/journey.mjs` (global Playwright on `NODE_PATH`): **22/22, 6/6, 4/4**, exit 0.
- **Full native suite:** `node --test --test-concurrency=4` from `conductor`: **1,744 total; 1,679 pass / 65 fail /
  0 skip**, exit 1.
  - 64 failures match OPEN rows in `windows-failure-inventory-2026-11-19.csv`, and none matches a FIXED_NATIVE row.
  - The other one, `test/keyleak.test.js` "a key leaking through test output is redacted…", is not in the
    inventory. It fails the same way on clean `main` at `85c7154` (`status` is `stopped`, expected `landed`). It is
    the Windows `leak-check.cmd` branch of a test last changed in PR116 `56c52ce`, so it predates this change and is
    not touched here.

## Live / fake / skipped / unrun

- All results use synthetic participants and a stub LocalAI HTTP server. Nothing was rechecked against the live
  LocalAI server or a stopped GPU worker.
- Linux CI is unrun until the PR's checks report.

## Open defects or unknowns

- The keyleak native failure above needs an inventory row. Its owner is Codex (native fixture inventory).
- In the mid-run unreachable case (`infrastructure` or `no-participant` failure), the page claims no reason. Showing
  one there would need an extra probe, which was left out on purpose.

## External blocker and exact owner/action

- `conductor/src/service/` is on the risk-gate list. The PR needs Malcolm's merge or his `malcolm-approved` label.
- A live check of the `worker-offline` sentence needs Malcolm's desktop worker stopped during a run. It is optional
  and owned by Malcolm.

## Next packet unblocked

Items 7.2 onward (the Start action and the `local.worker` config) still wait on W1–W8.
