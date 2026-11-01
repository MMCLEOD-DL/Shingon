# Claude task 37: plain words in the run page, and no highlighted spend button (U1, U2)

```
Packet/subpacket: P04 follow-up from the first live run (task 36 findings U1 and U2). Malcolm asked for it on
  31 October 2026.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 789c6a2 (PR 66 merged).
Owned files: conductor/operator-web/src/{text.js, views/RunView.jsx}; conductor/operator-web/tests/{text.spec.js
  (new), views.spec.jsx}; this entry. No service or engine file changed: the service still sends internal names
  when the engine gives no sentence, and the UI translates them.
U1: the activity log, the latest-step line and the status line showed engine names (start, phase, chunk,
  plan-agreed, approve, finish, landed, "checking"). Now: known names become sentences ("Started the next coding
  step."), answers read as what happened ("You approved it."), outcomes too ("The branch was created."), an unknown
  name is shown as words ("Council base tests."), and the status line names the stage ("coding", "final review",
  "creating the branch") or says nothing. Sentences from the service are kept exactly. A lone lowercase hyphenated
  word in a progress event counts as an internal name, because the contract fixture sends "chunk-done" without
  data.engineType.
U2: on the local-model fallback question, Use subscriptions is no longer the highlighted button; Pause and it look
  the same. Only approving a reviewed result stays highlighted.
Checks (cloud Linux, Node 24), from conductor/operator-web/: npx vitest run 67 passed (8 new); npm run build;
  node e2e/journey.mjs 19 passed + real engine 6 passed. The journeys caught a clash first: the log line "Branch
  created." duplicated the status label, so it now reads "The branch was created." and the label stays unique.
  git diff --check clean.
Not here: no live re-run on Windows (next time Malcolm runs the checklist, U1/U2 are visible in Task 3's log and
  Task 4's question).
```
