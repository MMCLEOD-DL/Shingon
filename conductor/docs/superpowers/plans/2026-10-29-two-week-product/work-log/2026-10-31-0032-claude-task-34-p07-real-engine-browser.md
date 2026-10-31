# Claude task 34: P07, the browser against the real engine (Claude's part)

```
Packet/subpacket: P07 (integration and adversarial checks). Codex coordinates; Claude reviews and fixes UI-owned
  files. Malcolm chose this on 31 October 2026 as Claude's next task, on the path to his first hands-on test.
Owner and reviewer: Claude (UI-side checks); reviewer Codex.
Status: IN_REVIEW. P07's row stays Codex's to update.
Baseline SHA: 7ea29d0 (K6 fixes merged).
Owned files: conductor/operator-web/e2e/{real-engine.mjs (new), journey.mjs (runs it at the end)}; this entry.
  No service, engine or workflow file changed. Reads conductor/test/helpers/stubCli.js, as the service tests do.
What it proves (built UI + real service + REAL engine, stand-in claude/codex CLIs and a local endpoint, as in
  test/service/engine.test.js; Chromium):
  1. A task started in the browser is planned, edited by the local model and tested by the real engine; coverage
     shows local used and both vendors.
  2. Approve lands a real branch whose head is exactly the reviewed commit, with the change; main and the
     operator's checkout are untouched.
  3. Files changed after review: approval refused, the UI shows the stale-decision message, no new branch.
  4. A page on another origin (127.0.0.1, another port, so same-site) in the signed-in browser cannot start a task:
     JSON fetch, no-cors text/plain fetch and a text/plain form post all fail, and every request that reaches the
     service gets 403 from the origin rule.
  5. A planted GITHUB_TOKEN that the stand-in models print back is in no browser response, page, UI bundle file,
     service data file or Git history/message; the stored transcript reads "Plan using [redacted]". A planted
     ANTHROPIC_API_KEY never reaches a model CLI (subscription mode strips it).
Checks (cloud Linux, Node 24, Playwright Chromium): node e2e/journey.mjs: 19 passed + real engine 6 passed, exit 0.
  npm test: 59 passed. git diff --check clean.
  Mutations (local only, reverted): removing the service's three origin checks fails check 4 (requests then reach
  the JSON-type rule, 400, instead of 403); making redact() a no-op fails check 5.
Finding for the record (not a defect): three layers each stop a cross-origin start (origin/fetch-site rules, the
  JSON-only body rule, the browser's CORS preflight). Model text is kept in transcripts, not shown in the browser.
No service defect found. Not here: stale SSE replay beyond the existing two-tab check; native Windows; live models
  (P08). Codex: the remaining P07 matrix and the Windows windowsHide fix in src/exec.js stay yours.
```
