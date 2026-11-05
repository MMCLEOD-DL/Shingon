# Claude: browser acceptance review of the operator app, and one run-page fix

```
Packet/subpacket: P07, Claude's UI-side part (browser acceptance review). Claim: 2026-11-05-1403 entry.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW (P07's row stays Codex's to update).
Baseline SHA: 820501b (PR84 merge). Result commit: aa033b6 (code); this entry is the branch's last commit.
Owned files changed: conductor/operator-web/{src/views/RunView.jsx, tests/views.spec.jsx, e2e/journey.mjs,
  e2e/resume-and-fallback.mjs (new)}. No service, engine, worker, CLI, setup or workflow file changed.
Contract version: v1, unchanged.
```

## Defect found and fixed (reproduced first)

- **D1, low (misleading text).** After an accepted answer, `RunView` kept the note "Answer saved. Waiting for
  Conductor to continue — this does not yet mean the work is finished." on screen next to "Branch created", next to
  "Paused", and above the *next* fallback question. Nothing cleared it. Seen in the browser with the real engine
  after Resume → approve, after fallback → Pause, and after fallback → Use subscriptions. It is now shown only
  while the run is still working on that answer. It stays hidden once the run has settled or a new question is
  on screen.
- **D2, low (missing next step).** A run paused at the fallback question before any work was saved
  (`resumable: false`) showed only "Paused." Now: "Paused. It has no saved work to resume: start the task again
  when you are ready." No Resume button, as before.

## Checks (cloud Linux, Node 22.23.4, Playwright Chromium; all synthetic: stand-in model CLIs, no models)

| Check (cwd `conductor/operator-web`) | Before fix | After fix |
|---|---|---|
| `npx vitest run` | 3 of 4 new tests fail (the "note stays while working" control passes) | 71 passed |
| `npm run build` | ok | ok |
| `node e2e/resume-and-fallback.mjs` (new) | 0/4: the three defect checks fail on D1/D2, plus the console check | 4 passed |
| `node e2e/journey.mjs` (also runs real-engine and resume-and-fallback) | 19 + 6 passed at baseline | 19 + 6 + 4 passed, exit 0 |

`git diff --check` clean. The baseline (`820501b`) itself passed 67 unit tests, the build, 19 journey steps and 6
real-engine steps before any change. Not run: the Foundation and Conductor suites (no file of theirs changed).
Required PR checks are the CI record.

## Coverage map (verified by reading and running, not by description)

- **Approve/reject with the displayed diff and test evidence.** Covered.
  - Browser: journey "start → decision with the actual evidence", approve, reject with feedback.
  - Real engine: the branch lands at exactly the reviewed commit, and main is untouched.
  - New: after Resume, the same diff and passing tests are shown again before approval.
  - Unit: R1 (450,000-character diff) and R2 (mismatched or slow review evidence).
- **Reload and connection loss while a decision is pending.** Covered.
  - Browser: the reload step; the two-tab step with the live stream cut; the kill step.
  - Unit: a lost stream shows "reconnecting" and leaves the run state unchanged.
  - Residual gap, not a reproduced defect: no test sends an answer whose *response* is lost after the service
    recorded it, then retries. By reading, the retry reuses the per-decision request id and the service answers
    from its receipt. The recovery panel has this test; the decision panel does not.
- **Stale or competing decisions.** Covered.
  - Browser: two tabs (only the first answer counts, one `decision-resolved`); files changed after review
    (refused, no branch).
  - Unit: a stale answer is explained after the reload removes the question.
- **Service restart, inspection and Resume.** Covered.
  - Browser: kill during a question (withdrawn, sign-in-again message); Stop never offered during landing; worker
    lost after approval (inspection required, no Resume); inspection refused without a workspace; inspection then
    Resume reconciles without a second branch.
  - New gap closed: restart → Resume with the real engine. A new question (new id, same saved commit) appears, and
    approving lands exactly one branch.
- **U1/U2 wording and the fallback choice.** Covered.
  - Unit: text.spec, plus the U2 class test on the contract fixture.
  - New gap closed: the real worker's fallback question in a browser. Neither choice is highlighted, the "never
    paid API keys" sentence is shown, Pause leaves no branch, and the log reads "You chose to use your
    subscriptions."

## Observation for Codex (backend, not changed here)

With the local model down, the run starts with a fallback question. After "Use subscriptions", the stand-in run
asks a **second** fallback question at the coding step. Its prompt is the engine's "could not produce a result:
local failed: no AI model is available for local (local: not reachable)". This appears to be the per-chunk
`confirmLocalFallback` hook, kept on by `confirmLocalFallback: true` in `src/service/worker.js`. Whether to ask
again after an explicit "continue" is a backend and product decision. The new browser check accepts either a
second question or a settled run, so it does not pin this behaviour.

## Not done here, and remaining Windows-host checks (owner: Malcolm's host, with Codex for native fixtures)

None of the browser evidence above ran on Windows or with live models. On the native Windows acceptance host:
- restart during a pending question, then Resume, in Edge or Chrome;
- the fallback question with the configured LocalAI worker actually stopped;
- kill semantics there (`taskkill /F` rather than SIGKILL) for the withdrawn-question and inspection paths;
- the journeys themselves, which are unrun on Windows; this depends on Codex's fixture-portability work.

Live and subscription runs stay P08. No deployment or credential use.
