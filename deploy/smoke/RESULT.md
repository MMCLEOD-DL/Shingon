# Foundation smoke — result

**Status:** NOT YET RUN (operator runs `! bash deploy/smoke/run-smoke.sh` on a throwaway VM with Docker)

## Run
- Date / machine:
- Version:
- Each numbered step: pass/fail and the line printed:
- Elapsed:

## Look and feel (operator's eye, spec §2.3)
- Opened reports/screenshots: do the phone pages look finished? Any page that looks amateur?

## Operator follow-ups (outside the code)
- Matrix: a bot account plus a private alerts room; MATRIX_* recorded per deployment.
- External heartbeat watcher (Uptime Kuma push monitor) for "box is off"; HEARTBEAT_URL per deployment.
- Per-client backup destination and BACKUP_PASSWORD stored in the password manager, never only on the box.
- Image delivery choice (private registry, or docker save/load over the tunnel).
- Cloudflare tunnel token (or Tailscale key) per deployment.
- Solicitor review of the §5a terms; give them docs/LICENCES.md.
- First release: `npx tsx scripts/release.ts minor` once the smoke passes, then tell Conductor's Phase 5 plan which tag to build from.
