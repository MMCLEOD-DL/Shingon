# Highland deployment runbook

This is the operator's guide to one Highland deployment: one client, one box. It covers putting a new box in, what to do when an alert arrives, backups, updates, remote access and secrets. Every command is run in the deployment's bundle folder on the box (the folder that holds `compose.yaml` and `.env`, written into `.env` as `HF_BUNDLE_DIR`), as a user who may run Docker.

A short-hand used throughout: **"run `ops <command>`"** means

```bash
docker compose run --rm ops <command>
```

which starts a one-off copy of the ops container with the deployment's own settings. `docker compose run --rm ops` with no command prints the full list of ops commands.

## What this is

A Highland deployment is a staff web app for one company, running on one small machine (the "box") at the client's premises or in a data centre. Docker runs a handful of containers on it: the **app** (the web app staff use), a **database** (PostgreSQL), a **front door** (Caddy, which answers web requests and handles HTTPS), and **ops**, a watchman that takes an encrypted backup every night, tests once a week that a backup can really be restored, checks the box every minute and sends you an alert (Matrix and/or a webhook) when something is wrong. Two more pieces run only when wanted: the **updater**, started by hand to move the app to a new version safely, and the **tunnel**, an outbound-only connection that lets you reach the box from outside without opening the client's network. Backups always go to a second place set by the client's data policy, never only onto the box itself.

### Good to know before you start

- **Accounts.** There is no public sign-up. The first admin is created with a one-off command (below); everyone else is invited by an admin. People are switched off ("disabled"), never deleted, because the activity log keeps a reference to them.
- **The activity (audit) log** cannot be edited or deleted by the app's normal code paths: it protects against bugs in the app, not against someone who has taken over the app's own process (that would need the separate database role planned as later work). The nightly tidy-up removes entries older than `AUDIT_RETENTION_DAYS` (default 730 days).
- **Demo boxes stay demo boxes.** A database that has ever held demo data (made-up people, published demo password) can never be switched to `INSTANCE_MODE=production`. Start a live box from a fresh, empty database.
- **Nothing here is shared between clients.** Each box has its own secrets, its own backup destination and its own backup password.

## Setting up a new deployment

You need: a Linux machine with Docker Engine and the Compose plugin; the release bundle (`highland-bundle-<version>.tar.gz`, made by `npm run bundle`); and the two images for that release, either as a file made with `docker save` or in your private registry. Have the client's data policy to hand: it decides where backups go and which outside services may be used.

1. **Make the bundle folder and unpack the bundle.** One folder per deployment, for example:

   ```bash
   sudo mkdir -p /opt/highland/acme && sudo chown "$USER" /opt/highland/acme
   cd /opt/highland/acme
   tar -xzf ~/highland-bundle-0.1.0.tar.gz      # compose.yaml, Caddyfile, .env.example, RUNBOOK.md
   ```

2. **Load the images.** From a file (kept in the bundle folder, so later updates can use the same place):

   ```bash
   docker load -i images-0.1.0.tar     # made on the build machine with: docker save highland/app:0.1.0 highland/ops:0.1.0 -o images-0.1.0.tar
   ```

   The default image names (`highland/app`, `highland/ops`) are **local only**: they are never downloaded, because those names on Docker Hub belong to someone else. To use a private registry instead, set `APP_IMAGE` and `OPS_IMAGE` to the full names (such as `registry.example.com/highland/app`) and `IMAGE_PULL_POLICY=missing` in `.env` (see "Updating").

3. **Make the settings file with `ops init`.** It writes a new `.env` with strong random secrets and prints a checklist. Run it from the ops image, as your own user so that you own the file:

   ```bash
   docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/out" highland/ops:0.1.0 \
     init --client "Acme Ltd" --origin https://staff.acme.co.uk --site staff.acme.co.uk --dir "$PWD" --out /out/.env
   ```

   - `--client` is the client's name (shown in the app, in emails and at the start of every alert). `--origin` is the web address staff will type. `--site` is what the front door answers to (see "HTTPS on a client's network"). `--dir` is the full path of this folder.
   - `--out .env` writes the file readable only by its owner (mode 600) and **refuses to overwrite** an existing file. Without `--out`, the settings go to standard output, and `ops init` refuses to print them on a screen (secrets would sit in scrollback); redirect them to a file and run `chmod 600 .env`.
   - If you leave out `-u "$(id -u):$(id -g)"`, the file is created on the host as **root**, mode 600, and you cannot read it. Fix it with `sudo chown "$USER": .env`.
   - `--tunnel` is for a box reached through the outbound tunnel: it sets `SITE_ADDRESS=:80` (and `TUNNEL_ENABLED=true`) whatever `--site` says, and `--site` may be left out.
   - `--demo` makes a demonstration box (`INSTANCE_MODE=demo`) for made-up data only.

4. **Fill in `.env`** from the checklist and the client's data policy:
   - **Save `BACKUP_PASSWORD` in your password manager now.** Without it the backups cannot be read, and it must never live only on the box.
   - `APP_TAG`: remove the `# ` in front of the line and write the release, for example `APP_TAG=0.1.0`. The updater needs this line to exist.
   - `SMTP_URL` and `EMAIL_FROM`: the mail server and sender address for invitations and password resets.
   - `BACKUP_REPOSITORY` (plus its sign-in details, if any): the destination named in the data policy. It must not be on this box: ops refuses a local folder or a `localhost` address.
   - The alert channel: `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` and `MATRIX_ROOM_ID` (all three, or none), and/or `ALERT_WEBHOOK_URL`. A live box will not start ops without at least one.
   - `HEARTBEAT_URL`: the push address of your outside watcher (an Uptime Kuma push monitor). Optional in the code, but treat it as required: it is the only thing that notices when the whole box is off.
   - For the tunnel, `TUNNEL_TOKEN` (see "Remote access").
   - Never commit `.env` or copy it to a shared drive.

5. **Start it:**

   ```bash
   docker compose up -d                       # add --profile tunnel when the tunnel is used
   docker compose ps                          # db, app, ops and proxy running; migrate and edge-check exited 0
   ```

   On first start the `migrate` container builds the database and exits; the app starts once it has finished; the front door starts once the app is healthy and `edge-check` has passed.

6. **Create the first admin:**

   ```bash
   docker compose run --rm app node apps/server/dist/auth/bootstrap-admin.js --email jo@acme.co.uk --name "Jo Bloggs"
   ```

   It prints a link. Send it to that person (it works for 7 days); they open it and choose their own password. Running it again for the same address issues a fresh link.

7. **Check the box and take the first backup:**

   ```bash
   docker compose run --rm ops check          # one line per check; ✗ app:backups and ✗ app:restore-test are expected until step 7 is done
   docker compose run --rm ops backup
   docker compose run --rm ops restore-test
   docker compose run --rm ops check          # now every line should start with ✓
   ```

8. **Record the deployment** in your own notes: client, box address, bundle folder, version, backup destination, where the backup password is kept, the Matrix room, the heartbeat monitor and the tunnel name.

A demonstration box can be filled with made-up data with `docker compose exec app node apps/server/dist/seed/cli.js` (refused on a production box). The demo accounts all use the published password `demo-password-1`, which is why such a database can never go live.

## Where data goes

Every outbound connection the app and ops can make, and the `.env` setting that controls it. This is the list to check against the client's data policy. Nothing else leaves the box: the app loads no fonts, scripts or trackers from other sites, and the client's data is never sent to the factory's AI models.

| Destination | Who connects | Setting | What is sent |
|---|---|---|---|
| **SMTP server** | app | `SMTP_URL`, `EMAIL_FROM` | Invitation, password-reset and password-changed emails: the person's name and email address, and a one-time link. |
| **Backup destination** | ops (and the updater, for the pre-update backup) | `BACKUP_REPOSITORY`, plus `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, `B2_ACCOUNT_ID`/`B2_ACCOUNT_KEY` or `RESTIC_REST_USERNAME`/`RESTIC_REST_PASSWORD` | A full copy of the database and the uploaded files, **encrypted on the box** with `BACKUP_PASSWORD` before it leaves. The destination cannot read it. |
| **Matrix homeserver** | ops (and the updater) | `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_ROOM_ID` | Alert text: the client label, a plain-English problem, version numbers, backup ids, disk figures and counts. No client records. Secrets are removed from every alert. |
| **Alert webhook** | ops (and the updater) | `ALERT_WEBHOOK_URL` | The same alert text, as JSON `{"text": "…"}`. |
| **Heartbeat (outside watcher)** | ops, every minute | `HEARTBEAT_URL` | `status=up` and a short message: `OK`, or the number of problems and the first one (at most 100 characters). |
| **Tunnel provider (Cloudflare)** | tunnel | `TUNNEL_TOKEN` (only with `--profile tunnel`) | All web traffic that comes in through the tunnel, and SSH sessions routed through it. Cloudflare ends the HTTPS connection at its edge, so it can see that traffic. Say so in the data policy, or use the Tailscale alternative. |
| **Certificate authority (Let's Encrypt or ZeroSSL)** | front door | `SITE_ADDRESS`, when it is a public name | The site's name, to obtain and renew its HTTPS certificate. No client data. |
| **Image registry** | updater | `APP_IMAGE`, `OPS_IMAGE`, `IMAGE_PULL_POLICY=missing` | Downloads of new app and ops images, only when you use your own registry. No client data. |
| **Docker Hub** | Docker, when you install or update | the image tags in `compose.yaml` | Downloads of the PostgreSQL, Caddy and cloudflared images. No client data. |

Inbound: the front door listens on `HTTP_PORT` and `HTTPS_PORT` (80 and 443) on the box. With the tunnel nothing needs to be opened on the client's router. The app's own port is never published.

## What the alerts mean

Ops checks the box every minute. A problem is sent on the **second** failed check in a row (so a blip pages nobody), repeated every 6 hours while it lasts, and followed by a **Fixed** message after two good checks in a row. "Critical" problems (wrong settings, an update left half done) are sent on the first sighting. Every alert starts with the client label in square brackets:

- `[Acme Ltd] Problem: …` a new problem.
- `[Acme Ltd] Critical problem: …` a settings or update problem that will not go away on its own.
- `[Acme Ltd] Still a problem since 14:05: …` the 6-hourly reminder.
- `[Acme Ltd] Fixed: … (now back to normal).` It quotes the problem **as first alerted**, numbers included (a disk alert that first said 1.2 GB free says 1.2 GB in its Fixed message, even if it got worse in between).

To see the current state at any time: `docker compose run --rm ops check`. The ops log is `docker compose logs --tail 200 ops`.

### The box and the app

- **"The app is not answering."** Ops cannot reach the app at all. Run `docker compose ps`: if the app has stopped or keeps restarting, read `docker compose logs --tail 100 app`, then `docker compose up -d`. If the box was rebooted and the app did not come back, check that Docker starts at boot. You will not get this alert during a planned update: the updater stops ops along with the app.
- **"The app says it is down (its database is not answering)."** / **"The database is not answering."** The app runs but PostgreSQL does not. Check `docker compose ps db` and `docker compose logs --tail 100 db`; a full disk is the usual cause.
- **"The app reports a problem, but ops cannot see which: HEALTH_TOKEN is not set for ops or does not match the app."** Both read `HEALTH_TOKEN` from the same `.env`. Make sure it is set, then `docker compose up -d` so both containers pick it up.
- **"Uploaded files cannot be saved (storage is not writable)."** The uploads volume is full or has the wrong owner. Check disk space; to reset the owner run `docker compose run --rm --entrypoint chown updater -R 1000:1000 /data/uploads`.
- **"The database is missing 1 update."** (or more) The app is newer than its database. This normally appears only during or after a failed update: run `docker compose run --rm updater update --status` and see "Recovering from a failed update".
- **"Disk space is low on /data/uploads: 1.2 GB free (4%)."** (or `/state`) Less than 2 GB or less than 10% is free. Find what is using it (`df -h`, `docker system df`). Do **not** run `docker image prune -a` (see "Updating"); `docker builder prune` and old log files are safe to clear. **"The free disk space on … could not be checked: the disk did not answer in time."** usually means a network mount has hung; see the note on hung disks below.
- **"The remote-access tunnel is down, so the operator cannot reach this box."** The tunnel container is not connected. Check `docker compose --profile tunnel ps tunnel` and `docker compose logs --tail 50 tunnel`. An empty or revoked `TUNNEL_TOKEN` makes cloudflared stop at once. The box still serves staff on the LAN meanwhile.
- **"The health checks could not run."** Ops itself has a problem. Restart it with `docker compose restart ops` and read its log.

### Email

- **"3 emails are waiting to be sent (the oldest for 42 minutes)."** Mail has been queuing for more than 15 minutes: the SMTP server is unreachable or refusing. Check `SMTP_URL` (address, port, user name, password) and that the box can reach the server. Queued mail is retried automatically (after 1, 5, 30, 120 and 360 minutes) and nothing is lost while it waits.
- **"2 emails could not be sent in the last day."** These gave up after the last retry. The people concerned did not get their invitation or reset link: fix the mail settings, then send the invitation again from the People page (or ask the person to use "Forgot your password?").

### Backups

- **"The last backup failed: …"** followed by the reason, or **"Problem: the scheduled backup failed. …"** (sent at once, with no two-strike rule). The common reasons:
  - **"The backup destination is busy with another backup or check (…). Try again in a few minutes."** Another restic run holds the destination's lock: usually a backup still running from this box, or something you are doing by hand. Wait and run `ops backup`. If it keeps happening and nothing else is using the destination, a crashed run left a stale lock: see "Backups and restoring".
  - **"The backup destination did not answer within …"** / **"could not be reached (…)"** The destination is off or unreachable from the box (network, firewall, DNS). Check it, then run `ops backup`.
  - **"The backup password does not match the backup destination."** `BACKUP_PASSWORD` in `.env` is not a key of that repository. Put back the right one from your password manager.
  - **"There is not enough disk space for the backup, …"** Either the destination is full or the box's `/state` folder is. Free space, then run `ops backup`.
  - **"The backup destination refused the sign-in details (…)"** Check the destination's user name and password settings in `.env`.
  - **"The backup destination had a fault of its own (HTTP 5xx)"**, or **"… some of the saved data could not be read back …, so the copy there may be damaged."** A problem at the destination. Check it; if the repository is damaged, start a new one for this client and keep the old one until a new backup has passed a restore test.
  - **"There is no backup repository at …"** The address is wrong, or the destination was emptied.
  - **"The database looks empty, so I did not back it up."** `DATABASE_URL` points at the wrong database, or migrations have not run. Treat it as urgent.
  - **"Backup … was saved, but old backups could not be tidied away."** The backup is safe; only the pruning failed. It will be tried again tomorrow.
- **"No backup has succeeded yet."** Normal on a new box until the first `ops backup`.
- **"The last successful backup was 31 hours ago."** No good backup for 26 hours or more. Look at `docker compose logs ops` around 02:30 and run `ops backup` by hand.
- **"Backups are being kept on this box only. This is a development setting and must be changed before real use."** (critical) `BACKUP_ALLOW_LOCAL=true` is set. Never on a live box: set a real `BACKUP_REPOSITORY`, remove the flag and run `docker compose up -d`.
- **"Backups are paused because an update could not be undone: backup … holds the data from before it and must be kept as it is. …"** Sent instead of each scheduled backup (so every night) until the failed update is sorted out. Nothing is backed up or pruned meanwhile, on purpose: see "Recovering from a failed update". **"Backups are paused for now because the ops log in the database could not be read …"** means the database is down; fix that first.

### Restore tests

- **"The last restore test failed: …"** or **"Problem: the restore test failed. …"** The weekly test restored the newest backup into a scratch database and something did not match or could not be read. The reason follows, for example "There are no backups yet.", "The newest backup is 40 hours old (expected one every day).", a missing backup record, or table and file counts that differ. Run `ops restore-test` to see it again. A backup that cannot be restored is as bad as no backup: fix it the same day.
- **"No restore test has passed in the last 8 days."** The weekly test did not run or did not pass. Run `ops restore-test`.

### Updates

- **"Updated from 0.1.0 to 0.1.1. A backup (1a2b3c4d) was taken first."** Done; nothing to do. It may add a warning about the front door, see "Updating".
- **"Update to 0.1.1 cancelled: …"** Nothing was changed; the reason says what to fix.
- **"Update to 0.1.1 failed (…), so it was undone automatically. The app is back on 0.1.0 with its data exactly as it was before the update."** Nothing to recover. Find out why the new version failed before trying again.
- **"URGENT: update to 0.1.1 failed (…) and the automatic undo also failed (…)."**, **"URGENT: update to 0.1.1 (from 0.1.0, started …) stopped part-way while …"**, the critical problem **"The update to … stopped part-way …"** and the app check **"An update failed and its automatic undo failed too, …"** The box may be down or on the wrong data. Go straight to "Recovering from a failed update".

### Settings

- **"TUNNEL_IP (…) is not inside EDGE_SUBNET (…). … The front door stays down until this is fixed."** (critical; also "is the gateway address", "is the network's own address", "is the broadcast address"). See "Remote access". Backups and the rest of ops carry on; only the front door is held back.

### Things the alerts cannot tell you

- **Alert state lives in ops' memory.** After ops restarts (an update, a reboot, `docker compose up -d`), a problem that is still there is announced again as new; a **Fixed** can be lost if the problem cleared while ops was restarting; and a critical settings problem that you fix by changing `.env` stops being reported rather than sending Fixed (the restart that applies the change also clears the memory).
- **The heartbeat is a dead-man's switch.** While ops is alive it always reports `status=up`, even when there are problems (those go to Matrix or the webhook). The outside watcher (an Uptime Kuma push monitor set to alert after, say, 5 minutes of silence) is what tells you the **box is off, its network is down, or ops itself has stopped**. Nothing on the box can report its own death.
- **A crash while ops is already stopped** (for example the box loses power in the middle of an update, after the updater has stopped ops) is caught only by the outside heartbeat. Ops stays stopped after such a crash, because the update stopped it on purpose.
- **A hung disk.** If a network mount stops answering, each disk check gives up after 5 seconds and reports it, but the stuck request can keep one of Node's few background threads busy. Several hung checks in a row can slow ops down until the mount recovers or ops is restarted.

## Backups and restoring

**What a backup holds:** the whole database (a consistent copy taken while the app keeps running), the uploaded files, and a small record of what they contain (rows per table, number and size of files), which the restore test checks against. Backups are made with restic, encrypted on the box with `BACKUP_PASSWORD`, and stored at `BACKUP_REPOSITORY`. Backups from different boxes can share one destination safely: each box only ever lists, restores and prunes its own (they are grouped by a short name made from `CLIENT_LABEL`, so do not change `CLIENT_LABEL` on a box that already has backups, or its older backups stop counting as "latest" and are no longer pruned).

**The destination is per client and set by the client's data policy.** Ops refuses a folder on the box or a `localhost` address (`BACKUP_ALLOW_LOCAL=true` exists for development only and raises a standing critical alert). Supported destinations include `sftp:user@host:/path`, `rest:https://host:8000/repo`, `s3:…` and `b2:…`.

**`BACKUP_PASSWORD` is stored off the box**, in your password manager, under the client's name. If the box is lost, the password from your password manager plus the destination are everything needed to get the data back. If the password is lost, the backups are unreadable: no one, including us, can open them.

**Schedule** (UK time, set in `.env`):

| What | When | Setting |
|---|---|---|
| Backup | every day at 02:30 | `BACKUP_SCHEDULE` (default `30 2 * * *`) |
| Restore test | Sundays at 04:30 | `RESTORE_TEST_SCHEDULE` (default `30 4 * * 0`) |
| Audit-log tidy-up | every day at 03:15 | fixed |

**Retention:**
- **Daily and manual backups:** 7 daily, 5 weekly and 12 monthly (`BACKUP_KEEP`). Only the nightly scheduled backup prunes.
- **Pre-update backups** (taken by every update): always the last 5, and every one within 30 days. They are outside the daily rule, because a failed update's alert names one.
- **Safety backups** (taken by `ops restore` just before it overwrites anything, tagged `safety`): **never pruned**, never counted as "latest", and restored only by naming their id. Delete them by hand once you are sure you will not need them.

**Commands:**

- **Back up now:** `docker compose run --rm ops backup`. It waits up to 2 minutes for a running backup, restore test or restore to finish, then gives up in plain English. While backups are paused after a failed update it refuses, because the new backup would become "latest" in place of the one the alert names; `ops backup --force` takes it anyway (a manual backup never prunes, so the named one is still kept).
- **Test the newest backup:** `docker compose run --rm ops restore-test`. It restores into a scratch database and folder, compares them with the backup's record, and cleans up. The live data is never touched.
- **Put a backup back over the live data:**

  ```bash
  docker compose stop app ops
  docker compose run --rm ops restore latest --yes-replace-live-data      # or a backup id instead of latest
  docker compose start app ops
  ```

  It refuses while the app is still answering. It first takes a **safety backup** of the current data and prints its id: write it down. If anything goes wrong after that point, `restore <that safety id>` (not `latest`) takes you back.
- **List the backups:** restic is in the ops image:

  ```bash
  docker compose run --rm --entrypoint sh ops -c 'RESTIC_REPOSITORY="$BACKUP_REPOSITORY" RESTIC_PASSWORD="$BACKUP_PASSWORD" RESTIC_CACHE_DIR=/state/restic-cache restic snapshots'
  ```

  The tags say what each one is: `hf scheduled`, `hf manual`, `hf pre-update` or `safety`. Add `--tag pre-update` to see only pre-update backups. The same form runs any restic command; `restic unlock` clears a stale lock left by a crashed run (only when you are sure nothing is backing up).

**How a restore swaps the database in.** The backup is first restored into a new database called `app_incoming`. Only when that has fully worked is the live database renamed to `app_old`, `app_incoming` renamed to `app`, and `app_old` dropped. So there is never a moment without a complete database under a known name. Then the uploads folder is replaced and handed back to the app's user. If the restore stops, the message says exactly where things are:

| Message | What it means and what to do |
|---|---|
| "The safety backup failed, so nothing has been changed. …" | The current data could not be backed up first, so the restore did not start. Fix the backup problem it names, then run the restore again. |
| "The saved database could not be put back. The live database app has not been changed." | Restoring into `app_incoming` failed (often disk space). Nothing changed. Free space and try again. |
| "The live database could not be moved aside, so it has not been changed: …" | Something is still connected to the live database. Check `docker compose ps` (the app and ops must be stopped), then run the restore again. |
| "The restored database could not be put in place, so the live database was put back as it was: app holds the data from before the restore. The restored copy is kept as app_incoming." | Nothing changed. Run the restore again; ops removes the leftover `app_incoming` at its next start. |
| "The restored database could not be put in place, and the old one could not be put back. app_old holds the data from before the restore and app_incoming holds the restored copy; rename one of them to app by hand." | Rare. Choose which data you want, then rename it: `docker compose exec db psql -U app -d postgres -c 'ALTER DATABASE app_incoming RENAME TO app'` (to finish the restore) or the same with `app_old` (to go back). Then `docker compose start app ops`. |
| "The restored database could not be put in place. It is kept as app_incoming; rename it to app by hand." | There was no live database. Rename it as above. |
| "The restore stopped before changing anything because ops lost its lock …" | Its database connection dropped. Nothing changed. Run the restore again. |
| "The database was put back, but ops lost its lock before the uploaded files, so they have not been touched. Run the restore again." | Run the restore again. |
| "The uploaded files were put back, but the app may not be able to save new ones: their owner could not be set." | Run `docker compose run --rm --entrypoint chown updater -R 1000:1000 /data/uploads`. |
| "The restore worked, but the copy of the database from before it (app_old) could not be removed." | Harmless. Drop it when convenient: `docker compose exec db psql -U app -d postgres -c 'DROP DATABASE app_old'`. |
| In the ops log at start-up: "Warning: the app database app is missing, but app_old … still exists. Nothing has been removed." | A restore was interrupted between the two renames. Rename the copy named in the message to `app` as above. |
| Any failure that ends "The data as it was before this restore is in safety backup 1a2b3c4d: restore that id (not latest) to go back." | Fix the cause and run the restore again, or restore the safety id to go back to where you started. |

## Updating

Updates are run by hand, in a quiet hour, with the **updater**: the only container that is given the Docker socket, and it runs only while you run it.

```bash
docker compose run --rm updater update --to 0.1.1
```

What it does, in order: stops the app **and the monitor (ops)**, takes an encrypted pre-update backup, switches `APP_TAG` in `.env`, updates the database, starts the new version and waits up to 3 minutes for it to report the new version and a healthy database. If anything fails after the backup, it puts the backup and the previous version back by itself. Then it starts ops again. Because ops is stopped for the whole update, **no "app is not answering" alert is sent for a planned update**. Staff see a few minutes of downtime; no write can be lost, because the app is stopped before the backup is taken.

**Getting the new images onto the box:**
- **From a file** (the default, local-only image names): copy the `docker save` file into the bundle folder and add `--image-file`: `docker compose run --rm updater update --to 0.1.1 --image-file images-0.1.1.tar`. The file must be inside the bundle folder.
- **From your private registry:** set `APP_IMAGE=registry.example.com/highland/app`, `OPS_IMAGE=registry.example.com/highland/ops` and `IMAGE_PULL_POLICY=missing` in `.env`. Sign the box in once with `docker --config "$PWD/.docker" login registry.example.com` (the updater uses that folder; the password never goes on a command line). Use `IMAGE_PULL_POLICY=missing` **only** with full registry names, never with the default `highland/*` names. Image names that point at Docker Hub (`docker.io/…`) are refused.

**The outcomes** (the same message goes to your alert channel):

| Exit code | Message starts | Meaning |
|---|---|---|
| 0 | "Updated from 0.1.0 to 0.1.1. A backup (…) was taken first." | Done. If it adds "Warning: TUNNEL_IP and EDGE_SUBNET in .env do not match, so the front door … was not restarted" or another front-door warning, the app itself is updated and healthy; fix what the warning says and run `docker compose up -d`. |
| 1 | "Update to 0.1.1 cancelled: …" | Nothing was changed (for example the new images are not on the box, the backup failed, or the current version's images are missing so an undo would be impossible). The app is running the old version again. |
| 1 | "Update to 0.1.1 failed (…), so it was undone automatically." | The new version did not work; the backup and the old version were put back. The data is exactly as before. |
| 1 | "Already on 0.1.1.", "Another update is already running.", "A backup or restore is still running, so the update … did not start." | Nothing was done. |
| 2 | a usage or settings message | Fix the command or `.env`. |
| 3 | "URGENT: update to …" | The update failed **and** could not be undone, or it was refused because an earlier update stopped part-way. See "Recovering from a failed update". |

`docker compose run --rm updater update --status` shows the last 5 updates.

**Things that keep updates safe:**
- **Keep the previous version's images.** The undo needs them, and an update refuses to start if they are gone. Never schedule `docker image prune -a` (or `docker system prune -a`) on a box. Remove an old version's images by hand only once a newer update has been running happily for a while.
- **The updater is the current version's ops image** (`UPDATER_TAG` defaults to `APP_TAG`). So a fix to the update process itself takes effect from the update *after* the one that installs it. If a release note tells you to use the new updater straight away: load the new images first (`docker load -i images-0.1.1.tar`), set `UPDATER_TAG=0.1.1` in `.env`, run the update, then remove the `UPDATER_TAG` line again.

### Keeping a deployment patched

Until Phase 7 automates it, patching is the operator's job. **Once a month**, and also whenever a `[security]` entry appears in the foundation's `CHANGELOG.md` or a security release of Node, PostgreSQL, Caddy or cloudflared is announced:

1. On the build machine, raise the pinned tags to the newest patch release of the same version: `postgres:17.x-bookworm`, `caddy:2.x.y-alpine` and `cloudflare/cloudflared:<date>` in `deploy/compose.yaml`; `RESTIC_VERSION` (with its SHA-256) in `deploy/ops.Dockerfile` if restic has a fix. Never change PostgreSQL's major version (17) this way.
2. Run `npm audit --omit=dev` and update any shipped package with a known problem.
3. Release a patch version (`npx tsx scripts/release.ts patch`; it refuses while `npm audit` finds high-severity problems in shipped packages), then `docker pull node:22-bookworm-slim` (so the rebuild picks up the newest Node 22 and Debian fixes), `npm run images` and `npm run bundle`.
4. On each box, ship it through the normal update path above (`update --to <new version>`). If the new bundle changed `compose.yaml` (new PostgreSQL, Caddy or cloudflared tags), copy the new `compose.yaml` and `Caddyfile` into the bundle folder after the update (keep `.env`), then `docker compose pull db proxy` (add `tunnel` with the tunnel) and `docker compose up -d` (with `--profile tunnel` if used). That restarts those containers with a few seconds' interruption.

**Host operating-system updates** (`sudo apt update && sudo apt upgrade` on the box itself) are done over the tunnel in a quiet hour, after a manual `docker compose run --rm ops backup`. If a reboot is needed, expect the outside watcher to report the box silent for a few minutes. After the reboot, check `docker compose ps` and `docker compose run --rm ops check`.

## Recovering from a failed update

You are here because of an **URGENT** alert, a critical "stopped part-way" problem, or update exit code 3. Until you finish this section, backups are paused (the backup the alert names must not be pruned or pushed out of "latest"), no further update will run, and the app may be down.

**1. Read the alert.** It says which update (from and to), the **backup id** (8 characters) that holds the data from before the update, and how far things got. For an automatic undo that failed, it says whether the database and the uploads were put back and which version `.env` names now. For an update that stopped part-way (a crash, a power cut, a killed container), it names the step it was in. The updater keeps a record of the update in progress (`update-in-progress.json` in the ops state volume), written before each step:

| Step in the record | What the box may look like |
|---|---|
| stopping | Nothing had changed, but the app and ops may be stopped. No backup taken yet. |
| backing-up | Nothing had changed; the app and ops are stopped. A pre-update backup may or may not exist. |
| switching | `.env` may name either version; the database had not been changed. |
| migrating | The database may be partly updated; `.env` names the new version. |
| starting | The database was updated; `.env` names the new version. |
| undoing | The automatic undo was under way: database, uploads and `.env` may each be either version. |
| undo-failed | The undo failed: database, uploads and `.env` may each be either version. |
| finishing | The update had finished and ops was being started again. |
| uncertain | The record could not be kept up to date after the backup: assume anything after the backup. |

If the alert does not give a backup id, list the pre-update backups (see "Backups and restoring", add `--tag pre-update`) and use the newest one from the time of the update.

**2. If nothing had changed** (step `stopping` or `backing-up`): make sure `APP_TAG` in `.env` names the old version, run `docker compose up -d`, check `docker compose run --rm ops check`, then go to step 4.

**3. Otherwise, put the old version and its data back:**

```bash
docker compose stop app ops
# Edit .env: set APP_TAG back to the version you were updating FROM, if it names the new one.
docker compose run --rm ops restore <backup id from the alert> --yes-replace-live-data
docker compose up -d                     # up -d, not start: the app must be recreated on the old version
docker compose run --rm ops check
```

The restore takes its own safety backup first and prints its id (write it down), then swaps in the database and uploads from the pre-update backup. If it stops, its message says what to do (see the table in "Backups and restoring").

**4. Tell ops the box is recovered:**

```bash
docker compose run --rm updater update --mark-recovered
```

It refuses (exit 1, nothing changed) if an update is running right now, if there is no failed update to clear, or if the app is not healthy on the version `.env` names within 15 seconds (it checks the app reports that version and that its database and database updates checks pass). When it succeeds (exit 0) it records that you recovered the box, removes the update record, ends the standing alert and lets backups run again. Take a fresh backup straight away: `docker compose run --rm ops backup`.

**5. Afterwards:**
- If you had set `UPDATER_TAG`, remove that line from `.env`.
- Keep both versions' images on the box (no `docker image prune -a`).
- If you use a registry, `IMAGE_PULL_POLICY=missing` is for fully named registry images only.
- Find out why the update failed before trying it again.

## Remote access

Remote access uses an **outbound-only tunnel**: the box connects out to the tunnel provider, so nothing is opened on the client's router. The foundation ships Cloudflare's `cloudflared` as the `tunnel` service.

**Cloudflare tunnel:**
1. In the Cloudflare dashboard (Zero Trust, Networks, Tunnels), create a tunnel for this client and copy its token into `TUNNEL_TOKEN` in `.env`. Set `TUNNEL_ENABLED=true`, so the monitor watches it.
2. Add its routes in the dashboard: the staff web address (for example `staff.acme.co.uk`) to **`http://proxy:80`**, and, if you want SSH, a second name to **`ssh://host.docker.internal:22`** (the box's own SSH server).
3. `SITE_ADDRESS` must be `:80` (Cloudflare provides the HTTPS). Keep `APP_ORIGIN` as the `https://` address staff use. `ops init --tunnel` sets this for you; any other `SITE_ADDRESS` with the tunnel makes visitors loop forever.
4. Start with the profile, every time you run `up`: `docker compose --profile tunnel up -d`. (You can put `COMPOSE_PROFILES=tunnel` in `.env` instead, so a plain `docker compose up -d` includes it.)

Remember Cloudflare can see the traffic that passes through it (see "Where data goes").

**Real visitor addresses.** Behind the tunnel, the front door believes the `Cf-Connecting-IP` header (the visitor's real address, used for sign-in rate limits and the activity log) **only** from the tunnel's fixed address, `TUNNEL_IP` (default `172.30.250.10`) on a small private network, `EDGE_SUBNET` (default `172.30.250.0/28`). Leave both alone unless that range clashes with a network the client uses. If you change them:
- change **both together**;
- `TUNNEL_IP` must be inside `EDGE_SUBNET`, and not its first address (`.0`, the network), its second (`.1`, the gateway, where traffic from the box itself arrives) or its last (broadcast);
- the `edge-check` service checks the pair before the front door starts. On a mismatch the front door stays down (`docker compose up -d` reports that `edge-check` did not complete successfully), while ops keeps running, keeps backing up and sends a critical alert. Fix `.env` and run `docker compose up -d` again.

**Tailscale instead of Cloudflare.** If the data policy rules Cloudflare out, replace the `tunnel` service with Tailscale, which is also outbound-only and does not see the traffic. Leave out `--profile tunnel`, keep `TUNNEL_ENABLED=false` (the monitor's tunnel check is cloudflared's), and add a `compose.override.yaml` in the bundle folder. This is a starting point; it is not covered by the foundation's smoke test, so try it on a spare box first and pin an exact `tailscale/tailscale` version tag (never `latest`):

```yaml
services:
  tailscale:
    image: tailscale/tailscale:<exact version>
    restart: unless-stopped
    hostname: acme-highland
    environment:
      TS_AUTHKEY: ${TS_AUTHKEY:?}          # a one-off or tagged auth key from the Tailscale admin console, in .env
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "true"
      TS_SERVE_CONFIG: /config/serve.json
    volumes: ["tailscale:/var/lib/tailscale", "./tailscale-serve.json:/config/serve.json:ro"]
    networks: [edge]
volumes: { tailscale: {} }
```

with `tailscale-serve.json` sending the box's tailnet name to the front door:

```json
{ "TCP": { "443": { "HTTPS": true } }, "Web": { "${TS_CERT_DOMAIN}:443": { "Handlers": { "/": { "Proxy": "http://proxy:80" } } } } }
```

Visitors coming through Tailscale all appear to the app as one address (the Tailscale container's), so use it for your own access, not as the staff's way in. For SSH over Tailscale, install Tailscale on the box itself and use Tailscale SSH.

## HTTPS on a client's network

`SITE_ADDRESS` in `.env` tells the front door what to answer to. Set `APP_ORIGIN` to match what staff type (`https://…` or `http://…`), then `docker compose up -d`.

| `SITE_ADDRESS` | Use it when | What happens |
|---|---|---|
| `:80` | The tunnel is used, or a plain-HTTP LAN box | Plain HTTP on port 80. With the tunnel, Cloudflare adds HTTPS outside. Without it, traffic on the LAN is unencrypted: acceptable only if the data policy says so. |
| `staff.acme.co.uk` | The name is in public DNS, pointing at the box, and ports 80 and 443 reach it from the internet | Caddy gets and renews a free certificate automatically (Let's Encrypt or ZeroSSL) and redirects HTTP to HTTPS. |
| `staff.acme.lan` or `192.168.1.50`, with `tls internal` | A LAN-only box that should still use HTTPS | Caddy acts as its own small certificate authority. Staff devices must trust its root certificate once (below). |

**The `tls internal` recipe.** Edit the `Caddyfile` in the bundle folder:

```caddyfile
{
	# Do not try to add the root certificate to the read-only container's own trust store (it is not needed there).
	skip_install_trust
	servers {
		trusted_proxies static {$TUNNEL_IP}
		client_ip_headers Cf-Connecting-IP
		protocols h1 h2
	}
}

{$SITE_ADDRESS} {
	tls internal
	encode zstd gzip
	reverse_proxy app:3000 {
		header_up X-Forwarded-For {client_ip}
	}
}
```

That is the shipped file with two lines added: `skip_install_trust` in the top block and `tls internal` in the site block. Without `skip_install_trust` Caddy tries to add its root certificate to the container's own trust store, which fails because the front door's file system is read-only, and fills its log with "failed to install root certificate" errors (checked on the build machine). Keep a note that this box's `Caddyfile` is changed, so a later bundle's `Caddyfile` is merged rather than copied over it. Then set `SITE_ADDRESS=staff.acme.lan` (make sure the client's router or DNS server points that name at the box) and `APP_ORIGIN=https://staff.acme.lan`, and run `docker compose up -d`.

**Trusting Caddy's root certificate on staff devices.** Copy it off the box once:

```bash
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./acme-highland-root.crt
```

It is public (not a secret) and stays the same for years; it lives in the `caddy_data` volume. Then on each device:
- **iPhone / iPad:** send the file by email or AirDrop and open it; then Settings, General, VPN & Device Management, install the profile; then Settings, General, About, Certificate Trust Settings, and switch on full trust for it.
- **Android:** Settings, Security (or Security & privacy), More security settings, Encryption & credentials, Install a certificate, CA certificate, and pick the file. The menu names vary by maker.
- **Windows:** double-click the file, Install Certificate, Local Machine, "Place all certificates in the following store", Trusted Root Certification Authorities.
- **Mac:** double-click to open Keychain Access, add it to the System keychain, open it and set "When using this certificate" to Always Trust.

**Rate limits and the box's own address.** Sign-in rate limits count per visitor address. Visitors who reach the box through Docker's own port forwarding from the box itself (`localhost`) or over IPv6 can all appear as one address (Docker's gateway), and so share one limit. Staff on the LAN using the box's IPv4 address are counted separately.

## Rotating secrets

Rotate a secret when someone who knew it leaves, when it may have been exposed, or as routine. Use long random values that are safe inside a web address, for example from `openssl rand -hex 32`. Do it in a quiet hour.

**`DB_PASSWORD`** (the database password). PostgreSQL keeps its own copy, set when the database was first created, so change both:

```bash
docker compose exec db psql -U app -d app
#   at the app=# prompt type:  \password app   then the new password twice, then  \q
# Put the same new value in .env as DB_PASSWORD, then:
docker compose up -d                                             # recreates the app and ops with the new value
docker compose run --rm ops check
```

**`HEALTH_TOKEN`** (lets ops read the app's detailed health and version). Put a new value in `.env` and run `docker compose up -d`: the app and ops both read it from there. If an outside monitor also uses it, update it there too.

**`MATRIX_ACCESS_TOKEN`** (the alert bot's token). Sign the bot in afresh to get a new token (for example sign in as the bot in Element, then Settings, Help & About, Access token), put it in `.env`, and run `docker compose up -d ops`. Check `docker compose logs ops` shows no "alert could not be sent" lines at the next problem. Then sign out the bot's old session, which makes the old token useless.

**`BACKUP_PASSWORD`** is the key to every existing backup, so **never just edit the variable**: ops would then be locked out of its own backups ("The backup password does not match the backup destination"). Add a new key to the repository, switch, prove it, then remove the old key:

```bash
# 1. Add the new password as a second key (restic asks for the new password twice).
docker compose run --rm --entrypoint sh ops -c 'RESTIC_REPOSITORY="$BACKUP_REPOSITORY" RESTIC_PASSWORD="$BACKUP_PASSWORD" RESTIC_CACHE_DIR=/state/restic-cache restic key add'
# 2. Save the new password in your password manager, put it in .env as BACKUP_PASSWORD, then:
docker compose up -d ops
docker compose run --rm ops backup
docker compose run --rm ops restore-test
# 3. List the keys (the one in use now is marked *) and remove the old one by its id.
docker compose run --rm --entrypoint sh ops -c 'RESTIC_REPOSITORY="$BACKUP_REPOSITORY" RESTIC_PASSWORD="$BACKUP_PASSWORD" RESTIC_CACHE_DIR=/state/restic-cache restic key list'
docker compose run --rm --entrypoint sh ops -c 'RESTIC_REPOSITORY="$BACKUP_REPOSITORY" RESTIC_PASSWORD="$BACKUP_PASSWORD" RESTIC_CACHE_DIR=/state/restic-cache restic key remove <old key id>'
```

All existing backups stay readable with the new password. Keep the old password in the password manager (marked as retired) until step 3 is done.

The backup destination's own sign-in details (`AWS_SECRET_ACCESS_KEY`, `B2_ACCOUNT_KEY`, `RESTIC_REST_PASSWORD`), `SMTP_URL`'s password and `TUNNEL_TOKEN` are changed at the provider first, then in `.env`, followed by `docker compose up -d` (with `--profile tunnel` for the tunnel token).
