# Claude handoff: PR116 reviewed, browser journeys made baseline-gate safe

```
Packet/subpacket: P07/P08. Independent review of Codex's PR116 (PR71 R1 gate) and the Claude-owned fixture handoff it asked for.
Owner and reviewer: Claude wrote both; Codex reads the review and owns the engine/service follow-ups R1–R3.
Status: IN_REVIEW. Packet rows in 04-work-log.md unchanged.
Baseline SHA: 8d7a836 (PR115 merge). Branch: claude/brave-ride-tz7f25. Code commit: c127e60.
Owned files changed: conductor/operator-web/e2e/real-engine.mjs, conductor/operator-web/e2e/resume-and-fallback.mjs.
Review artefacts: reviews/2026-11-16-claude-review-pr116-baseline-test-gate.md, reviews/fixtures/pr116-baseline-gate.mjs.
Contract version: none changed.
```

## What now works

- `real-engine.mjs`: the synthetic repository's `checks.cjs` passes at the base commit (no `multiply.txt`) and still
  asserts `local did it` once the worker has written the file. The "files changed after review" case is unchanged.
- `real-engine.mjs` and `resume-and-fallback.mjs` wait for the "Tests passed" **heading** by role. PR116's timeline entry
  for the baseline check also contains that text, so the bare text locator matched two elements under PR116.
- Review disposition for PR116 at `56c52ce`: no blocking defect; R1 (medium, baseline test output not visible in the app
  or CLI), R2 and R3 (low-medium) as follow-ups; N1 accepted deviation; N3 the unrecorded second fixture change.

## Checks (cloud Linux, Node 22.23.4, Playwright Chromium; synthetic only, stand-in model CLIs; no models)

From `conductor/operator-web`, UI built with `npm run build`:

| Check | `main` engine | PR116 engine (`--service <worktree>/conductor`) |
|---|---|---|
| unmodified fixtures, `node e2e/real-engine.mjs` (control) | 6 passed, exit 0 | **1 passed, 5 failed**, exit 1 (run never reaches review) |
| `checks.cjs` change only, `node e2e/real-engine.mjs` | 6 passed, exit 0 | **5 passed, 1 failed**, exit 1 (`getByText('Tests passed')` matched 2 elements) |
| both changes, `node e2e/journey.mjs` | 22, 6 and 4 passed, exit 0 | 22, 6 and 4 passed, exit 0 |
| `npx vitest run` | 78 passed (3 files) | not applicable (UI unchanged) |

From `conductor/docs/superpowers/plans/2026-10-29-two-week-product/reviews/fixtures`:
`node pr116-baseline-gate.mjs --conductor <dir>` against `main` and the PR116 worktree: the table in the review. On the
PR116 tree: failing or unlaunchable baseline gives `stopped`, `baseline-tests-failed`, 0 participant calls, no branch;
passing baseline and no `testCommand` land as on `main`; a pending check is re-run on resume.

PR116's own tests on its tree (`--test-concurrency=2`): 139 pass across the six changed test files; 62 pass in
`test/service`; 85 pass in the five factory suites that drive the real `runTask`.

## Live / fake / skipped / unrun

All fake. Not run: native Windows, live models, the full Conductor suite (CI), the forked worker's declined-fallback path.

## Open defects or unknowns

R1–R3 in the review, all Codex-owned seams (`runs.js`, `cli/main.js`, `conductor.js`), none blocking. The UI half of R1
(render the test excerpt) is a Claude follow-up once the service forwards it.

## External blocker and exact owner/action

- This PR: no high-risk path; auto-merge once checks are green.
- Then PR116: Malcolm's merge (high-risk path `conductor.js`). PR116 should merge **after** this PR, or its CI
  `operator-web` journey will fail on the two locators.
- Then Part E of the Windows round 2 runbook: Malcolm, about 30 minutes.

## Next packet unblocked

Windows acceptance round 2 Part E, once PR116 is in `main`.
