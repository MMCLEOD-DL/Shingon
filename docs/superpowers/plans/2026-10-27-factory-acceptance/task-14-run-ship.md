# Task 14: Real run, part 2 — ship to the test box and prove it runs

**Operator-run, with Conductor. The implementer does NOT run this task.**

Spec §2.4: an app without automatic backups, a tested restore, health alerts and safe updates is not finished. This stage ships the approved build to a **throwaway test box**, never the client's box, through Plan 10's `conductor ship`, and proves each of those by doing it. Criteria covered: C7 (on the box), C8, C9, C12 (the box's part), C17 (tag).

**Needs:** Task 13 passed; Plan 10 merged; a test box (CT 111 `hf-build`, or a machine from the `proxmox` provider) with Docker; the Matrix bot and alerts room, and an Uptime Kuma push monitor (Plan 6 and Plan 10 follow-ups); a backup destination for the test (for example an SFTP folder on the operator's NAS, never the box itself); the `BACKUP_PASSWORD` stored in the password manager before the first backup.

**Interfaces:**
- Consumes: `conductor ship <slug> --to <deployment>`, `conductor deployments [status]` (Contract 5, Plan 10); on the box, the foundation's own tools (`docker compose run --rm ops …`, `docs/RUNBOOK.md`).
- Produces: a deployment `deployments/test-box.json` (Contract 4) and the second part of `RESULT.md`.

- [ ] **Step 1: Ship**

```bash
conductor ship <slug> --to test-box
conductor deployments status
```
Answer the plain-English questions (box address, SSH user, secrets). Expected: the app answers on the box; `deployments/test-box.json` exists with the first `history` entry; `conductor deployments status` shows it healthy. Record the version shipped: `ship` first cuts the app's first release with Plan 10's `releaseApp` (bump `first`, tag `v<version>` on `main`; Contract 7.6), and `history` starts with outcome `installed`.

- [ ] **Step 2: The box's settings (C12)**

On the box: `grep -E '^OCR_' <bundleDir>/.env`. Expected: `OCR_ENGINE=local` and no `OCR_AZURE_KEY`. Then `docker compose exec app cat /app/app-profile.json` has `outbound: []`. Paste both outputs (they contain no secrets) into `RESULT.md`.

- [ ] **Step 3: Phones on the real box (C7)**

Sign in from both phones as a member created through an invite (not a demo account). Repeat the C7 checks with two fictional receipts each. Expected: the same results as on the preview, on the box's own CPU. Record each reading's time from upload to fields shown (expected under 15 s with the default `OCR_CONCURRENCY=1`).

- [ ] **Step 4: Backup and restore (C8)**

On the box (runbook sections "Backups" and "Restoring"):

```bash
docker compose run --rm ops backup
docker compose run --rm ops restore-test
```
Expected: both report success in plain English. Then `docker compose exec -T ops node ops/dist/cli.js status --json` (Task 9b) shows both runs as the latest `backup` and `restoreTest`, `ok: true`; paste it (it holds no secrets). Then the drill:
1. Note a count you can check: the number of confirmed readings shown in the app (or `select count(*) from receipt_readings where status='confirmed'` through the runbook's database command).
2. Confirm one more receipt (the count goes up by one).
3. Restore the backup from step 1 by its id, following the runbook's "Restoring the live database" steps.
4. The app comes back with the **original** count.
Paste each command's output into `RESULT.md`. Anything that needs a step not in the runbook is a FAIL for the foundation's docs.

- [ ] **Step 5: Alerts (C9)**

First `docker compose run --rm ops test-alert` (Task 9b): the test alert must arrive in the Matrix room. Then:

```bash
docker compose stop app
```
Start a timer. Expected: a Matrix alert in the alerts room within 5 minutes saying the app is down, in plain English. Then `docker compose start app`; expected: a recovery message. Record both times. Then check the Uptime Kuma heartbeat stays "up" while ops runs (Plan 6 decision for Task 19).

- [ ] **Step 6: Record and decide**

Run the checker with the deployment, to fill C17's tag part:

```bash
node /root/conductor/spikes/acceptance/check-acceptance.mjs ~/highland-projects/<slug> --build <runId> --deployment test-box \
  --out ~/highland-projects/<slug>/acceptance/checker-ship.md
```

Go on to Task 15 only when C7, C8, C9 and C12 pass here. A failure is recorded and fixed in the plan it belongs to (Plan 10 for shipping, the foundation for backups and alerts), then this stage is repeated.
