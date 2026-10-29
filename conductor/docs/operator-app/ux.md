# Operator UI (P04): design and evidence

**Owner:** Claude. **Reviewer:** Codex. **Package:** `conductor/operator-web/`. It has its own manifest and lockfile. Its only runtime dependencies are React and react-dom 19.3.1 (MIT). Build and test tools are pinned to Foundation's versions: Vite 7.3.7, Vitest 5.0.5, jsdom 29.1.1, Testing Library.

**Contract:** `interface.md` and `contract-v1.json` from `codex/operator-app-v1` @ `a8c97bc`. The fixture is copied into `operator-web/tests/fixtures/`. A test fails if that copy differs from `conductor/test/fixtures/operator-app/contract-v1.json` once both are in the same tree.

## Build, test, run

```
cd conductor/operator-web
npm ci
npm test
npm run build
node e2e/journey.mjs --service <conductor dir containing src/service>
```

- `npm test` runs the unit and render tests against the contract fixtures.
- `npm run build` produces `dist/`, which the service serves from the same origin.
- `e2e/journey.mjs` runs the browser journey against the real service. The `--service` option defaults to `..`, which works once P03 is integrated.

The UI tests live in `operator-web/tests/*.spec.*`, deliberately outside Node's default `node --test` patterns, so Conductor's own suite never picks up Vitest files. The service serves `operator-web/dist`. There is no development proxy and no simulated transport, so the production UI cannot pretend. If the service is missing or the session has ended, the UI says so and stops.

## The five views

| View | Path | What the operator can do |
|---|---|---|
| Connections | `/setup` | See each participant's program, sign-in, endpoint and coding status. Run an explicit check: installation, sign-in or "can code". Set the local model endpoint and name. See which test command will be used. |
| New task | `/` | Choose or add a repository (an absolute path, added only after an explicit confirmation of what access it grants). Describe the change. Start. |
| Current run | `/runs/:id` | See what is happening, who is working and whether local or subscription models did the work. Stop the run (two-step). Resume it. Open the activity log (secondary). |
| Review / decision | inside the run view | Result review shows the actual diff, files, reviewed commit and test outcome. The plan, chunk, escalation and fallback decisions each show their own wording and choices. |
| History | `/history` | Past runs and their outcomes, landed branch names, Resume where the service says a run is resumable, and pagination. |

## Rules the UI follows

- **Sign-in.**
  - The `#bootstrap=` fragment is read once and removed with `history.replaceState` before the token is sent.
  - The token is never stored in localStorage or sessionStorage, and never logged.
  - A reused or expired link shows the service's reason and how to get a new link.
- **No secrets.** There are no password, token or API-key fields anywhere. Claude Code and Codex sign-in is explained as a terminal step on the same computer.
- **Status words mean what they say.**
  - "verified" appears only when the service reports a real check. A check result shows when it was made, and that it is history, not live status.
  - "Branch created" appears only for `completed`, and names the branch. A rejected run says "Rejected — no branch created".
  - "Stopping (not yet confirmed)" is shown until the service reports `interrupted`.
- **Answers.**
  - Every answer sends the shown `revision` and reviewed commit, plus one client request id per decision, so a retry after a lost response cannot answer twice.
  - Approving a result is impossible until the review for **that exact commit** is on screen.
  - A refused (stale) answer explains itself and reloads the run.
  - "Answer saved" says the work is **not** finished yet.
- **Evidence.** Tests count as passed only if they ran and passed. Failed, not-run, missing and unknown results each have their own wording and colour, with a warning next to Approve. The approve button says "create a branch". The panel states that nothing is merged, pushed or deployed.
- **Untrusted text.**
  - Model output, prompts, diffs, file names and logs are React text only. There is no `dangerouslySetInnerHTML` in the source, no autolinking, and terminal escapes and bidi or control characters are stripped.
  - The bundle is served under the service's `script-src 'self'` CSP and needs nothing inline.
- **Connection loss.** A lost stream shows "Connection lost — reconnecting. The run itself is unaffected; nothing is answered while you are away". It reconnects from the last applied event, and on a refused cursor it reloads the run snapshot. Run status always comes from the snapshot, never inferred from the stream.
- **Accessibility.**
  - Keyboard: native buttons, links and form controls, with a visible focus ring. Focus moves to a newly pending question.
  - Status changes use `role=status` and live regions.
  - Touch targets are at least 44 px.
  - Light and dark colour schemes.
  - At phone width there is no horizontal scrolling; tables become stacked rows.

## Evidence (29 October 2026, cloud Linux, Node 22.22.0)

| Check | Result |
|---|---|
| `npm test` (unit and render, against `contract-v1.json`) | 46/46 passed (re-run 29 Oct on `main` with the P3-1 fixtures). Also covers landing and uncertain-landing states, and no stale question or Stop after an accepted answer. Covers every fixture run state, each decision kind, stale decisions, failed/unrun/missing checks, malicious content, focus, reconnect and resync, cancel wording, setup probes and saving, new-task idempotency, repository confirmation, history, and the signed-out state. |
| `npm run build` | Passed. 250 kB JS, 79 kB gzipped. The bundle contains no "Simulated" or fake transport. |
| `e2e/journey.mjs` in Chromium (Playwright 1.63.0) against the **real P03 service** at `a8c97bc` (13/13), then in-tree on `main` with `93e65b3` (15/15), with Codex's deterministic fixture workers | 15/15 passed: bootstrap and fragment removal; single-use link; repository confirmation; start; decision with evidence; literal untrusted text with nothing executed; focus; reload without answering; approve → branch created; reject → no branch; history; Connections with no "verified" and no secret fields; phone width; no Stop offered during an approved landing; worker lost after approval → inspect-repository message with no Resume; no console errors or CSP violations. |

**Not shown by this evidence:**
- The fixture worker reports a branch without running Git, so this is not a real coding run. The real engine, live models and native Windows belong to P07 and P08.
- No automated accessibility audit (axe) was run; the checks above are manual.
- Stale-answer and reconnect behaviour were tested in unit tests only, not in the browser journey.

## Known limitations and dependencies

- **Repository choice is a typed absolute path.** A browser folder picker does not give the service any access, so the plan rejects it.
- **Probes hold their HTTP request open.** The UI shows "Checking…" with no time limit until the service documents per-kind timeouts (review P3-5).
- **Cancel after approval** depends on the P03 fix for review finding P3-1. Until then, the UI shows whatever the service reports.
- **The session lasts as long as the service process.** After a service restart, the UI shows the sign-in instructions, which ask the operator for the new link.
