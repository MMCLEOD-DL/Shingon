# Claude: a lost decision reply and its retry, covered; changed answers get the plain message

```
Packet/subpacket: P07 (Claude's UI part), follow-up from both PR86 reviews.
Owner and reviewer: Claude; reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 0b7276a (main after PR92/93). Result commit: 265e788.
Owned files changed: conductor/operator-web/{src/views/RunView.jsx, tests/views.spec.jsx, e2e/journey.mjs}.
  No service, engine or worker change.
Defect (low): after a lost reply, a different answer (or an edited rejection note) reused the question's request id,
  so the service refused it as a conflict and the page showed the raw "Request ID conflict." The first answer had
  counted, but the page did not say so. Now the id belongs to the exact answer: an identical retry is confirmed from
  the service's receipt; a changed answer gets a new id and the plain "This question changed or was already
  answered" message, then the page reloads to the outcome.
Checks (cloud Linux, Node 22.23.4, Chromium; synthetic: fixture worker / stand-in CLIs, no models):
  npx vitest run 73 passed (changed-answer test fails on the previous build; same-answer retry passes on both);
  npm run build ok; node e2e/journey.mjs 21 + 6 + 4 passed, exit 0. On the previous build the new browser step
  "lost reply, then a different answer" fails (no plain message) and the same-answer step passes.
  In both browser steps the first answer really reaches the service (Playwright route.fetch, then the reply is
  aborted); exactly one decision-resolved event is recorded and one branch lands.
Not run: native Windows browser; live models.
```
