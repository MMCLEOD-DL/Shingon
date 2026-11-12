# Claude: resume journey, Windows' connection reset during the deliberate kill

```
Packet/subpacket: P07 (browser acceptance); finding 1 of the 12 November Windows round 2 session.
Owner and reviewer: Claude (operator-web tests); reviewer Codex.
Status: IN_REVIEW.
Baseline SHA: 1c6fd5b (PR114 merge). Branch: claude/kind-galileo-sxl3dv.
Files: conductor/operator-web/e2e/resume-and-fallback.mjs. No UI, service or engine change.
```

## The failure

At `038289d` on native Windows (Node 24.12), `node e2e\journey.mjs` gave 22/0 and 6/0, then resume-and-fallback gave
3 passed and 1 failed, with exit code 1. The failure was "no browser errors" with one
`Failed to load resource: net::ERR_CONNECTION_RESET`. The group's behaviour checks all passed. The check excuses
only the Linux symptoms of the planned `SIGKILL` (`ERR_CONNECTION_REFUSED` and `ERR_INCOMPLETE_CHUNKED_ENCODING`).
Windows reports the cut connection as a reset.

## The change

Each browser error now records whether the service was deliberately down. That window runs from just before the
kill until the restarted service has shown the run as interrupted. `ERR_CONNECTION_RESET` is excused only inside
that window. Everything else is unchanged: the 401/409 and Linux kill symptoms are excused as before, and any other
error fails the check. A failure message marks errors that came while the service was down.

## Checks

Cloud Linux, Node 22.23.4, Playwright Chromium. Synthetic only (stand-in model CLIs).

- `node e2e/resume-and-fallback.mjs`: 4 passed, exit 0.
- Control, using a temporary copy that adds one `net::ERR_CONNECTION_RESET` error just before the check:
  - marked outside the kill window: "no browser errors" FAILS (3 passed, 1 failed, exit 1);
  - marked inside the window: it passes (4 passed, exit 0).

## Not run

The Windows reproduction is Malcolm's: rerun `node e2e\journey.mjs` in `conductor\operator-web`. It is expected to
give 22, 6 and 4 passed with exit code 0.
