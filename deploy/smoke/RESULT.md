# Foundation smoke — result

**Status:** PASSED on the throwaway build machine (CT 111), run by the implementer on 26 October 2026, three times. The latest run used the script as committed in eef90b6, the review round 1 fix with the new guards. The step lines below are from the second run (80ecaeb). The third run gave the same results in 10 min 17 s, with backups 2e323fcb, e4b9d001 (safety), a265677b (pre-update) and 36d002da.

Still to do by the operator:
- the look-and-feel check below;
- the follow-ups that live outside the code.

Anyone can repeat it with `! bash deploy/smoke/run-smoke.sh` on a throwaway VM with Docker. Never run it on a client box or on CT 110. It refuses to start if the machine:
- has an edge-check container or a Compose project called `highland`;
- has any `highland/app` or `highland/ops` image;
- still has a smoke run left behind.

At the end it removes only the images it built.

## Run
- **Date / machine:** 26 October 2026, 22:55–23:03 UTC. CT 111 `hf-build` (Debian 12, Docker Engine with Compose v2, Node 22.23). No Matrix, SMTP, Cloudflare or other outside service was contacted: alerts went to the local catcher, mail to a local Mailpit, backups to a local restic REST server (`restic/rest-server:0.14.0`) on Docker's bridge address. The front door was published on 127.0.0.1 only (`HF_SMOKE_BIND`, default 127.0.0.1).
- **Version:** 0.1.0 (commit 80ecaeb), updated to 0.1.1 (a plain retag, delivered as a `docker save` file and loaded by `update --image-file`), with 0.1.2 built from `deploy/test/broken-image.Dockerfile`.
- **Each numbered step** (second run; the first run gave the same results in 9 min 51 s):
  1. Images: pass. "highland/app and highland/ops 0.1.0 built; 0.1.1 saved to a file; broken 0.1.2 built".
  2. Backup server and alert catcher: pass. "REST server at http://172.17.0.1:8000, catcher at http://172.17.0.1:8099".
  3. Bundle and `ops init --demo --out`: pass. The bundle holds Caddyfile, RUNBOOK.md, compose.yaml (plus the smoke's override and image file); `.env` mode 600.
  4. `docker compose up -d`, `/healthz`, seed, `/sign-in`: pass. "Demo data added: 2 teams, 10 people, 32 notes, 16 attached photos."
  5. Backup and restore test: pass. "Backup b3263774 saved to rest:http://host.docker.internal:8000/smoke: 0.1 MB." / "Restore test passed: backup b3263774 from 26 October 2026 at 22:56 restored completely."
  6. `ops check`: pass. 12 lines, every one ✓ (app, app:database, app:storage, app:migrations, app:email, app:backups, app:restore-test, app:update, disk:/data/uploads, disk:/state, update-record, backup-location).
  6a. Restore, then upload (`docker compose stop app ops`, `docker compose run --rm ops restore latest --yes-replace-live-data`, start): pass. "Safety backup cc31da9b holds the data as it was before this restore." … "Backup b3263774 … was put back: the database and the uploaded files." Then sign-in as the demo admin and an upload: "UPLOAD-AFTER-RESTORE-OK"; 32 notes kept.
  7. App stopped: pass. Webhook received "[Smoke] Problem: The app is not answering." and, after the app was started, "[Smoke] Fixed: The app is not answering. (now back to normal)."
  8. Updates: pass. "[Smoke] Updated from 0.1.0 to 0.1.1. A backup (603f8f67) was taken first." (exit 0), then "[Smoke] Update to 0.1.2 failed (version 0.1.2 did not become healthy within 3 minutes: the app was not answering), so it was undone automatically. The app is back on 0.1.1 with its data exactly as it was before the update." (exit 1). `APP_TAG=0.1.1`, `/api/version` reports 0.1.1, 32 notes unchanged, and **no** "app is not answering" alert during either update.
  9. Backup and restore test after the rollback: pass. "Backup a4da3c8b saved …" / "Restore test passed: backup a4da3c8b from 26 October 2026 at 23:03 restored completely."
  - Secrets: pass. `DB_PASSWORD`, `HEALTH_TOKEN` and `BACKUP_PASSWORD` appear neither in the alerts nor in any container log.
  10. Tear down: pass. Containers, volumes, network and the highland images removed. "SMOKE PASSED in 7 min 49 s".
- **Elapsed:** 7 min 49 s (first run 9 min 51 s, including image pulls).

The guards were proven on the build machine with eef90b6. Each case exited 2 with a plain refusal and left everything untouched:
- a local `highland/app:9.9.9` image;
- a `registry.example.com/highland/ops:9.9.9` image;
- an `edge-check`-labelled container in a project named `acme`.

`ops help` in the built ops image prints the command list (exit 0).

Also checked on the build machine the same evening (outside the script): the full Playwright suite with all three projects including mobile-webkit, 49 passed and 1 skipped, 39 screenshots; and the runbook's recipes (`tls internal` with `skip_install_trust` on the read-only front door, copying Caddy's root certificate out and verifying HTTPS with it, the `restic snapshots` / `key add` / `key list` commands through the ops image, `chown` through the updater, `COMPOSE_PROFILES=tunnel`, and that `ops init` run without `-u` leaves a root-owned mode-600 `.env`).

## Look and feel (operator's eye, spec §2.3)
- Opened reports/screenshots: do the phone pages look finished? Any page that looks amateur?
- (For the operator. The implementer looked at the WebKit phone shots of notes, a note, people and sign-in: clean and consistent, nothing clipped or overlapping, no WebKit-only problems found.)

## Operator follow-ups (outside the code)
- Matrix: a bot account plus a private alerts room; MATRIX_* recorded per deployment.
- External heartbeat watcher (Uptime Kuma push monitor) for "box is off"; HEARTBEAT_URL per deployment.
- Per-client backup destination and BACKUP_PASSWORD stored in the password manager, never only on the box.
- Image delivery choice (private registry, or docker save/load over the tunnel).
- Cloudflare tunnel token (or Tailscale key) per deployment.
- Solicitor review of the §5a terms; give them docs/LICENCES.md.
- First release: `npx tsx scripts/release.ts minor` once the smoke passes, then tell Conductor's Phase 5 plan which tag to build from.
