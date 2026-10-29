# Ship smoke result

Not run yet.

Run it with: `bash spikes/ship-smoke/run-ship-smoke.sh <project> <deployment>` (see the script's header for what it needs).

- Phase 1, first ship:
- Phase 2, later ship (after Plan 11):
- Phase 3, Ctrl-C while updating (after Plan 11):

## Follow-ups from the Plan 10 final review (2026-10-28)

- `deployments status` confirms a box that shows the new version and passes its checks even when no update record exists for the run (an update that never started, or an old record). Gate that path on the foundation's own recovery record too, as the urgent path already is. Today the box's own checks cover an unrecovered urgent update.
- When status sees an update finished, it does not refresh the box's compose file and Caddyfile (status never changes a box); the next ship does. The note should name `.conductor/bundle-<v>/`.
- Status stores the version the box reports without re-checking its format.
- A Ctrl-C while a ship is building leaves the factory machine for `conductor machines sweep`.
- Tests for kill paths only check the exit code, not that children were killed.
- Smoke phases 2 and 3 (updates through `conductor change`) need Plan 11.
