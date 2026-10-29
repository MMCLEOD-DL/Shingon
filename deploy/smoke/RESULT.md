# Foundation smoke — result

**Status:** PASSED on the throwaway build machine (CT 111 `hf-build`) on 28–29 October 2026 (Plan 12 Task 10), twice: a smoke of the `plan12-modules` tree (package version 0.1.0 before the v0.2.0 release commit), that is commit 98d2558 plus the Task 10 changes (the images, compose and ops changes exactly as committed in the Task 10 commit; only the docs, the generated licence file's preamble, the docs tests and these result files were written after the run). The step lines below are from the first run. The second run used `HF_SMOKE_DIR=/tmp/hf-smoke-alt HF_SMOKE_PROJECT=hf-smoke-alt` and passed the same way in 9 min 35 s (step 7a: "back healthy in 13 s, 32 notes kept, every check ✓"). The earlier v0.1.0 runs (26 October 2026, commits 80ecaeb and eef90b6) passed as recorded in git history.

Still to do by the operator:
- the look-and-feel check below;
- the follow-ups that live outside the code.

Anyone can repeat it with `! bash deploy/smoke/run-smoke.sh` on a throwaway VM with Docker. Never run it on a client box or on CT 110. It refuses to start if the machine:
- has an edge-check container or a Compose project called `highland`;
- has any `highland/app` or `highland/ops` image;
- still has a smoke run left behind.

At the end it removes only the images it built.

## Run
- **Date / machine:** 28 October 2026 23:52 to 29 October 2026 00:04 UTC. CT 111 `hf-build` (Debian 12, Docker 29.9.2 with Compose 5.6.1, Node 22.23.4, 4 CPUs, 4 GB). No Matrix, SMTP, Cloudflare or other outside service was contacted: alerts went to the local catcher, mail to a local Mailpit, backups to a local restic REST server (`restic/rest-server:0.14.0`) on Docker's bridge address. The front door was published on 127.0.0.1 only.
- **Version:** 0.1.0 (the `plan12-modules` tree on 98d2558, before the release commit), updated to 0.1.1 (a plain retag, delivered as a `docker save` file and loaded by `update --image-file`), with 0.1.2 built from `deploy/test/broken-image.Dockerfile`. The app image carries `app-profile.json` (no modules on, as in the foundation) and the module builds.
- **Settings:** first run with the defaults (`HF_SMOKE_DIR=/tmp/hf-smoke`, `HF_SMOKE_PROJECT=hfsmoke`, REST server `hfsmoke-rest`); second run with `HF_SMOKE_DIR=/tmp/hf-smoke-alt HF_SMOKE_PROJECT=hf-smoke-alt` (REST server `hf-smoke-alt-rest`): passed. The left-behind guard refused an existing `HF_SMOKE_DIR`: `HF_SMOKE_DIR=/root bash deploy/smoke/run-smoke.sh` printed "A previous smoke run was left behind (/root, /root-cookies, /root-catcher.out, /root-images-*.tar, the hfsmoke-rest container, or containers, volumes or networks of the hfsmoke project). Remove it first." and exited 2, changing nothing.
- **Each numbered step** (first run):
  1. Images: pass. "highland/app and highland/ops 0.1.0 built; 0.1.1 saved to a file; broken 0.1.2 built".
  2. Backup server and alert catcher: pass. "REST server at http://172.17.0.1:8000, catcher at http://172.17.0.1:8099".
  3. Bundle and `ops init --demo --out`: pass. "bundle unpacked (Caddyfile RUNBOOK.md compose.override.yaml compose.yaml images-0.1.1.tar ), .env made by ops init (mode 600)".
  4. `docker compose up -d`, `/healthz`, seed, `/sign-in`: pass. "Demo data added: 2 teams, 10 people, 32 notes, 16 attached photos."
  5. Backup and restore test: pass. "Backup 44824843 saved to rest:http://host.docker.internal:8000/smoke: 0.1 MB." / "Restore test passed: backup 44824843 from 28 October 2026 at 23:55 restored completely."
  6. `ops check`: pass. "every line ✓".
  6a. Restore, then upload: pass. "Safety backup 63ef97c9 holds the data as it was before this restore." … "Backup 44824843 from 28 October 2026 at 23:55 was put back: the database and the uploaded files." Then "restored (32 notes kept); upload after restore works".
  7. App stopped: pass. The front door showed the "being updated" page (status 502); webhook received "[Smoke] Problem: The app is not answering." and, after the app was started, "[Smoke] Fixed: The app is not answering. (now back to normal)."
  7a. Hard kill (`docker compose kill -s SIGKILL db app ops`, then `up -d`): pass. "hard kill of db, app and ops: back healthy in 13 s, 32 notes kept, every check ✓". Before printing it the step checked the notes count, that the photo uploaded in step 6a downloads byte for byte, that the ops daemon started again, that every `ops check` line is ✓ and, two monitor ticks later, that no "app is not answering" alert since the kill was left without its Fixed. Its check that no scheduled-job run recorded before the kill is lost is vacuous in the foundation (no jobs) and meaningful only for client builds with jobs.
  8. Updates: pass. "[Smoke] Updated from 0.1.0 to 0.1.1. A backup (2361ac8b) was taken first.", then "[Smoke] Update to 0.1.2 failed (version 0.1.2 did not become healthy within 3 minutes: the app was not answering), so it was undone automatically. The app is back on 0.1.1 with its data exactly as it was before the update." `APP_TAG=0.1.1`, 32 notes unchanged, and no "not answering" alert during the updates.
  9. Backup and restore test after the rollback: pass. "Backup 0c8bdf07 saved …" / "Restore test passed: backup 0c8bdf07 from 29 October 2026 at 00:04 restored completely."
  - Secrets: pass. "no secret found" (`DB_PASSWORD`, `HEALTH_TOKEN` and `BACKUP_PASSWORD` in neither the alerts nor any container log).
  10. Tear down: pass. "Removed the containers, volumes, network and the highland images this run built." "SMOKE PASSED in 11 min 41 s".
- **Elapsed:** 11 min 41 s (second run 9 min 35 s).
- **Left behind:** each run left one anonymous Docker volume (no project label) after its tear-down; they were removed by hand afterwards. A small follow-up for the smoke script.

Also on the build machine the same night (outside the script), from the same tree: `npm run verify:full` passed with a throwaway PostgreSQL 15 container as `TEST_DATABASE_URL` (password generated on the machine): 1084 unit and integration tests (the real backup and restore tests included, no skips), the Playwright suite (69 passed, 2 skipped) including the mobile-webkit receipt-photo spec ("a sideways phone photo is uploaded upright and smaller"), and the OCR accuracy run (2 passed). The images were then built with explicit tags (`highland/app:0.2.0`, `highland/ops:0.2.0`, and `highland/app:0.1.0` from v0.1.0 as the baseline) for the modest-box OCR check (`deploy/smoke/OCR-RESULT.md`), and removed afterwards.

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
- First release: `npm run release -- first` once the smoke passes and the branch is merged (it tags the 0.1.0 already in `package.json`, `foundation.json` and the dated changelog section as `v0.1.0`; it does not raise the version, and is refused once any `v*` tag exists). Then tell Conductor's Phase 5 plan which tag to build from (`v0.1.0`). Later releases use `npm run release -- patch|minor|major`.
- v0.2.0 (Plan 12): `npm run release -- minor` after the operator approves; then set Conductor's `factory.foundation.tag` to `v0.2.0`.
- Receipts: photograph a few printed fictional receipts into `modules/ocr/test/fixtures/receipts/photos/` (still empty) and run the modest-box check again; on a real iPhone, check a 48 MP HEIC photo through the receipt page, and that a long till roll downscaled to 2000 px still reads.
- Count cloud-OCR fallbacks for the ops monitor (a later foundation release), for boxes that use `OCR_ENGINE=azure`.
