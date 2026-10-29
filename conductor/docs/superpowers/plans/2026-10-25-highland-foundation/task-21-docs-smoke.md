# Task 21: Docs & operator smoke

The foundation is the factory's most important asset (spec §5). It is finished only when:
- the operator can install, run, recover and update a deployment from the runbook alone, in plain English;
- the next builder (a person in Phase 5, or the factory) can start a client app from it by following one guide;
- a full smoke run on a throwaway machine has proved the whole bundle end to end. That run covers backup to a separate destination, the restore test, an alert when the app dies, an update, and a rollback.

**Files:**
- Create: `README.md`, `docs/RUNBOOK.md`, `docs/BUILDING-ON.md`, `docs/LICENCES.md` (generated)
- Modify: `scripts/check-licences.ts` (add `--markdown <file>`), root `package.json` (`"licences:doc": "tsx scripts/check-licences.ts --markdown docs/LICENCES.md"`)
- Create: `deploy/smoke/{run-smoke.sh,catcher.mjs,RESULT.md}`
- Test: `scripts/check-licences.test.ts` (append), `deploy/test/docs.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces:
  - `docs/LICENCES.md`, a table generated from the installed packages, `| Package | Version | Licence |`, sorted by name. It is followed by a fixed section listing the container images and their licences: PostgreSQL (PostgreSQL), Caddy (Apache-2.0), cloudflared (Apache-2.0), restic (BSD-2-Clause), Node.js (MIT), Debian base (mixed free licences; see the image), Docker CLI and Compose (Apache-2.0).
  - `deploy/smoke/run-smoke.sh`: operator-run only. It needs a disposable Linux machine with Docker and is **never** pointed at a client box.

**`docs/RUNBOOK.md` sections** (exact headings; the docs test checks them):
1. `## What this is`: one paragraph, plain English.
2. `## Setting up a new deployment`: copy the bundle, `ops init`, fill `.env` from the client's data policy, `docker compose up -d`, then the first admin with `docker compose run --rm app node apps/server/dist/auth/bootstrap-admin.js --email … --name …`.
3. `## Where data goes`: every outbound connection the app and ops make (SMTP server, backup destination, Matrix homeserver, alert webhook, heartbeat URL, tunnel provider), with the `.env` variable for each. This is the list the Legal/data council member checks against the data policy (spec §6).
4. `## What the alerts mean`: one entry per alert text from Task 19, saying what to do.
5. `## Backups and restoring`: schedule, retention, where `BACKUP_PASSWORD` must be kept, `ops backup`, `ops restore-test`, `ops restore latest --yes-replace-live-data`.
6. `## Updating`: `docker compose run --rm updater update --to <version>`, and what each outcome means. Say that the update stops the monitor (`ops`) along with the app and starts it again afterwards, so no "app is not answering" alert is sent for a planned update. Include **keeping a deployment patched**, the operator's half of spec §4.6 until Phase 7 automates it (index Ruling 9): once a month, and whenever a `[security]` foundation entry or a Node, PostgreSQL, Caddy or cloudflared security release appears, rebuild the images on the newest patch tags, run `npm audit --omit=dev`, and ship through this same update path. Host operating-system updates (`apt upgrade` on the box) are done over the tunnel in a quiet hour, after a manual `ops backup`.
7. `## Recovering from a failed update`: the steps after a `rollback-failed` alert. Stop the app, `ops restore <snapshot from the alert> --yes-replace-live-data`, set `APP_TAG` back, start.
8. `## Remote access`: the Cloudflare tunnel (dashboard routes to `http://proxy:80` and `ssh://host.docker.internal:22`), `--profile tunnel`, and the Tailscale alternative (replace the `tunnel` service with `tailscale/tailscale` using `TS_AUTHKEY`, still outbound-only).
9. `## HTTPS on a client's network`: the `SITE_ADDRESS` forms, including the `tls internal` recipe and how to trust Caddy's root certificate on staff phones.
10. `## Rotating secrets`: `DB_PASSWORD`, `HEALTH_TOKEN` and `MATRIX_ACCESS_TOKEN`. `BACKUP_PASSWORD` is rotated with `restic key add` / `key remove`, never by editing the variable alone.

**`docs/BUILDING-ON.md` sections** (exact headings):
1. `## Starting a client app`: clone the foundation at a release tag into a new repo, keep `foundation.json` untouched, add the `foundation` git remote for later merges.
2. `## Making it theirs`: edit `apps/web/src/brand.ts` and the palette, and nothing else, for the look.
3. `## Adding a feature (follow notes)`: a checklist mirroring Task 10 and Task 13:
   - shared schema (`z.strictObject`);
   - table with `owner_id` and `team_id`;
   - actor-first repo with `visibleTo`;
   - `defineRoute` with a permission;
   - audit in the same transaction;
   - crossing cases, the route's roles typed by hand into `EXPECTED_ROLES`, plus a resource seeder with canaries;
   - **the update schema is built from a base with no defaults** (`Fields.partial()`), and only the create schema adds defaults. In Zod 4, `.partial()` keeps defaults, so `CreateX.partial()` would make a one-field edit silently reset every other defaulted field (see `packages/shared/src/schemas.ts`, notes, and the partial-update test in `notes.test.ts`);
   - pages built from house components, plus `PAGES` entries;
   - a demo seeder.
4. `## Numbers people rely on`: spec §2.2. Every total, VAT or report figure gets a test built from the brief's worked examples **before** the feature counts as done. Use integer pence, never floating-point pounds.
5. `## Permissions`: how to add roles or permissions to `PERMISSIONS`, and why the crossing harness's two tables must be updated **by hand**: `oracle.ts` (who can see which rows) and `EXPECTED_ROLES` in `test/crossing/cases.ts` (which roles may call each route). Both are deliberately independent of the app's own `PERMISSIONS` and `can()`. If a route's declared permission lets in more roles than `EXPECTED_ROLES` says, the harness fails with a plain sentence naming both, so a too-broad permission cannot pass. Also state that users are disabled, never deleted (the audit log keeps a reference to them).
6. `## Taking foundation fixes`: `git fetch foundation --tags && git merge v<x.y.z>`; read `CHANGELOG.md` for `[security]` entries; ship through the normal change-request path (spec §4.8).
7. `## The quality gates`: `npm run verify:full`, plus what `reports/crossing.md` and `reports/screenshots/manifest.json` are for.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/check-licences.test.ts`:

```ts
import { renderMarkdown } from './check-licences.js';
test('the licence document lists packages and the fixed image section', async () => {
  const root = fakeRepo({ b: { license: 'ISC' }, a: { license: 'MIT' } });
  const md = renderMarkdown(await collectLicences(root));
  expect(md).toContain('| Package | Version | Licence |');
  expect(md.indexOf('| a | 1.0.0 | MIT |')).toBeLessThan(md.indexOf('| b | 1.0.0 | ISC |'));
  expect(md).toContain('## Container images');
  expect(md).toContain('| restic | BSD-2-Clause |');
});
```

`deploy/test/docs.test.ts`:

```ts
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const doc = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

test('the runbook has every section the operator needs', () => {
  const headings = [...doc('docs/RUNBOOK.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual(['What this is', 'Setting up a new deployment', 'Where data goes', 'What the alerts mean', 'Backups and restoring',
    'Updating', 'Recovering from a failed update', 'Remote access', 'HTTPS on a client\'s network', 'Rotating secrets']);
});
test('every alert the monitor can send is explained', () => {
  const runbook = doc('docs/RUNBOOK.md');
  for (const phrase of ['The app is not answering.', 'Disk space is low', 'Backups are being kept on this box only', 'The remote-access tunnel is down',
    'emails are waiting to be sent', 'The last successful backup was', 'The last restore test failed', 'URGENT: update',
    'The backup destination is busy'])
    expect(runbook, phrase).toContain(phrase);
});
test('every outbound destination variable is listed under Where data goes', () => {
  const section = doc('docs/RUNBOOK.md').split('## Where data goes')[1]!.split('\n## ')[0]!;
  for (const v of ['SMTP_URL', 'BACKUP_REPOSITORY', 'MATRIX_HOMESERVER', 'ALERT_WEBHOOK_URL', 'HEARTBEAT_URL', 'TUNNEL_TOKEN']) expect(section, v).toContain(v);
});
test('the building guide has its sections', () => {
  const headings = [...doc('docs/BUILDING-ON.md').matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  expect(headings).toEqual(['Starting a client app', 'Making it theirs', 'Adding a feature (follow notes)', 'Numbers people rely on', 'Permissions', 'Taking foundation fixes', 'The quality gates']);
});
test('LICENCES.md is current', async () => {
  const { renderMarkdown, collectLicences } = await import('../../scripts/check-licences.js');
  expect(doc('docs/LICENCES.md')).toBe(renderMarkdown(await collectLicences(new URL('../../', import.meta.url).pathname)));
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project scripts --project deploy`
Expected: FAIL. The docs do not exist and `renderMarkdown` is missing.

- [ ] **Step 3: Write `renderMarkdown`, the docs and `README.md`**

- `README.md` is a short front page: what the foundation is, the quality bar it meets, the commands (`verify`, `verify:full`, `images`, `bundle`, `release`), and links to the three docs.
- Write `RUNBOOK.md` and `BUILDING-ON.md` with the sections above, in plain UK English, with no unexplained jargon.
- Run `npm run licences:doc`.

- [ ] **Step 4: Write the smoke script**

`deploy/smoke/catcher.mjs`: a 15-line `node:http` server on `:8099` that appends each POSTed JSON body as a line to `/tmp/hf-smoke-alerts.log`. It stands in for the alert channel.

`deploy/smoke/run-smoke.sh` (`set -euo pipefail`, every step announced with `echo "== …"`):
1. Build the images for the current version `V`. Tag `V+patch` as a plain retag, and build a broken `V+2` from `deploy/test/broken-image.Dockerfile` (as in Task 20).
2. Start a restic REST server as the off-box destination: `docker run -d --name hf-smoke-rest -p 8000:8000 restic/rest-server:<pinned> --no-auth` (BSD-2-Clause). Start `node deploy/smoke/catcher.mjs &`.
3. Make `/tmp/hf-smoke` from the bundle and run `ops init --client Smoke --origin http://localhost:8080 --site :80 --dir /tmp/hf-smoke --demo`. Demo mode with `ALERT_WEBHOOK_URL` set still sends real alerts to the webhook (Task 19: configured channels are always used). Append: `BACKUP_REPOSITORY=rest:http://host.docker.internal:8000/smoke`, `ALERT_WEBHOOK_URL=http://host.docker.internal:8099/`, `HTTP_PORT=8080` and the test SMTP values. Add `extra_hosts` through a `compose.override.yaml` written by the script for `ops` and `updater`.
4. `docker compose up -d`, wait for `/healthz`, seed the demo data, and check that `/sign-in` serves the app.
5. Run `docker compose exec ops node ops/dist/cli.js backup` → `Backup … saved to rest:http://host.docker.internal:8000/smoke`. Then `restore-test` → `Restore test passed`.
6. Run `docker compose exec ops node ops/dist/cli.js check` → every line `✓`. (The REST destination is a separate server, so `BACKUP_ALLOW_LOCAL` stays false and `backup-location` passes.)
6a. **Restore, then upload.** `docker compose stop app`, then `docker compose exec ops node ops/dist/cli.js restore latest --yes-replace-live-data` → it takes a safety backup and restores. `docker compose start app`, wait for `/healthz`, then sign in as the demo admin and upload a file, proving the app can still write to the restored uploads folder:

    ```bash
    curl -fsS -c /tmp/hf-smoke-cookies -H 'origin: http://localhost:8080' -H 'content-type: application/json' \
      -d '{"email":"admin@demo.test","password":"demo-password-1"}' http://localhost:8080/api/auth/sign-in >/dev/null
    curl -fsS -b /tmp/hf-smoke-cookies -H 'origin: http://localhost:8080' \
      -F 'file=@apps/server/test/fixtures/files/tiny.png' http://localhost:8080/api/files | grep -q '"contentType":"image/png"' && echo UPLOAD-AFTER-RESTORE-OK
    ```
7. `docker compose stop app`, then wait up to 180 s (two 60-second monitor rounds, plus slack) for `/tmp/hf-smoke-alerts.log` to contain `Problem: The app is not answering.`. `docker compose start app`, then wait for `Fixed:`.
8. Update to `V+patch` → `Updated from`. Update to `V+2` → `undone automatically`. `APP_TAG` must be `V+patch`, and the notes count is unchanged.
9. Inside the ops image, run the integration test suite's equivalent:

   ```bash
   docker compose exec ops node ops/dist/cli.js restore-test
   ```

   This is a second pass after the rollback, and proves the restored data still backs up and restores.
10. Tear down: `docker compose down -v`, `docker rm -f hf-smoke-rest`, kill the catcher. Print `SMOKE PASSED` with the elapsed time.

`deploy/smoke/RESULT.md` template:

```markdown
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
```

- [ ] **Step 5: Check syntax only. Do not run the smoke.**

Run:
```bash
chmod +x deploy/smoke/run-smoke.sh && bash -n deploy/smoke/run-smoke.sh && node --check deploy/smoke/catcher.mjs && echo SYNTAX-OK
npm run verify
```
Expected: `SYNTAX-OK`, and the full suite PASSES (6 new tests). If this machine has Docker and browsers, also run `npm run verify:full`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs: README, runbook, building-on guide, licence list; operator-run full-bundle smoke

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 7: Hand off to the operator**

Stop and tell Malcolm:

> The foundation is built and every automatic check passes. One thing is left that only you can do: run `! bash deploy/smoke/run-smoke.sh` on a throwaway VM that has Docker (not a client box and not CT 110). It takes about 10 minutes. It backs up to a separate test server, proves a restore, kills the app to check that an alert fires, and tries one good update and one deliberately broken one. Afterwards, look at a few phone screenshots in `reports/screenshots/` and tell me whether they look professional enough to charge for.

Once the output is back, fill in `RESULT.md` and commit it with the message `docs: foundation smoke result`.
