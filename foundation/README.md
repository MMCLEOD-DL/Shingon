# Highland foundation

The foundation every Highland client app is built from: a staff web app for one company, with everything a small business needs to trust it with real data, already done and tested once.

**What it gives a client app:** invite-only accounts (no public sign-up), roles and teams (admin, manager, member), photo and PDF uploads that work from a phone, email through a retrying outbox, an activity log that the app cannot rewrite, a polished responsive interface, and an example feature (notes) to copy. **Optional modules**, switched on per app in `app-profile.json`: reading receipts on the box (or in the cloud when the data policy allows it), money reports as PDF and spreadsheet files, and scheduled jobs (see [docs/BUILDING-ON.md](docs/BUILDING-ON.md)). **What it gives each deployment:** a Docker Compose bundle with encrypted off-box backups, a weekly restore test, health checks with Matrix or webhook alerts and an outside heartbeat, one-command safe updates that undo themselves when they fail, and an outbound-only tunnel for remote access.

## The quality bar

- **Access control is proved, not assumed.** Every route goes through `defineRoute` with a declared permission, and a role-crossing harness sends every route as every kind of user and checks the exact answer (401, 403 or 404), that nothing leaked and that a refusal changed nothing. Its expectations are typed out by hand, independently of the app's own rules.
- **Data safety.** Backups are encrypted and never kept only on the box; a restore test runs every week; an update stops the app, backs up first, and puts everything back if the new version fails.
- **Plain UK English** in every message staff or the operator see, with no stack traces and no secrets in logs or alerts.
- **Phone first.** Every page is screenshot at desktop and phone width (Chromium and WebKit) and checked for sideways scrolling and small tap targets.
- **Licences.** Every npm package, installed or recorded in `package-lock.json` (including the builds for other operating systems), must have a permissive licence; the build fails otherwise (see [docs/LICENCES.md](docs/LICENCES.md)).

## Commands

The commands need Node 22.13 or later (`engines.node` in `package.json`; `.npmrc` sets `engine-strict`, so an older Node refuses to install).

| Command | What it does |
|---|---|
| `npm run verify` | Lint, type checks, licence gate and every unit and integration test. Must pass at every commit. Needs `TEST_DATABASE_URL` (a PostgreSQL role allowed to create databases). |
| `npm run verify:full` | `verify` plus the browser tests and page screenshots (needs the Playwright browsers) and the OCR accuracy run over the fictional receipt corpus (`npm run test:ocr`). Run before every release. |
| `npm run images` | Builds the app and ops images (`highland/app:<version>`, `highland/ops:<version>`). Needs Docker. |
| `npm run bundle` | Makes `dist/highland-bundle-<version>.tar.gz`: the files a deployment needs (`compose.yaml`, `Caddyfile`, `.env.example`, `RUNBOOK.md`). |
| `npm run release -- first` | The very first release, once: tags the version already in `package.json`, `foundation.json` and a dated `CHANGELOG.md` section (0.1.0) as `v0.1.0`, stamping `foundation.json`'s `commit` with the tag name. Refused once any `v*` tag exists, on uncommitted changes, when the versions disagree or the section is missing or undated, and on high-severity `npm audit` findings. Nothing is pushed. |
| `npm run release -- patch\|minor\|major` | Every later release: moves the changelog's Unreleased entries under the new version, stamps `foundation.json` (only in the foundation itself: an app's release leaves the `foundation.json` it inherited exactly as it is), commits and tags. Refuses on uncommitted changes, before the first release, or on high-severity `npm audit` findings in shipped packages. Nothing is pushed. (`npx tsx scripts/release.ts …` is the same.) |
| `npm run licences:doc` | Regenerates `docs/LICENCES.md` from the installed packages. |
| `bash deploy/smoke/run-smoke.sh` | The operator's full-bundle smoke test. **Only on a throwaway Linux machine with Docker, never on a client box.** Result: `deploy/smoke/RESULT.md`. |
| `bash deploy/smoke/ocr-modest-box.sh` | After `npm run images`, on the same throwaway machine: reads the receipt corpus with the app image in a container held to 2 CPUs, 2 GB and no network, and checks the speed, memory, accuracy and image-size gates. Result: `deploy/smoke/OCR-RESULT.md`. |

## Documents

- [docs/RUNBOOK.md](docs/RUNBOOK.md): for the operator. Installing, alerts, backups, updates, recovery, remote access, HTTPS and secrets.
- [docs/BUILDING-ON.md](docs/BUILDING-ON.md): for whoever builds a client app on the foundation.
- [docs/LICENCES.md](docs/LICENCES.md): every package and image and its licence (generated).
- [CHANGELOG.md](CHANGELOG.md): what changed in each release; `[security]` marks fixes that must be taken promptly.

## Later work

Known follow-ups, recorded so they are not forgotten:
- **jsdom** (test-only) is pinned at 29.1.1, because 30.x needs Node 22.22.2 or later. Raise it once every machine that runs the tests has a newer Node (the build machine already has 22.23).
- **Bundle size.** The web app ships as one script of about 665 kB; splitting it by page would make the first load on a phone faster.
- **The updater stays root**, because it rewrites the operator's root-owned `.env` and uses the Docker socket. It runs only on demand.
- **The app connects to PostgreSQL as its superuser** (`app`, the `POSTGRES_USER` that owns the database). So a compromised app process could do anything in the database, including purging the activity log or dropping tables. The fix is a separate database role for the app (`app_rw`, allowed only to read and write its own tables and to add to the activity log, not to purge it), with migrations, restores and ops keeping the owner role.
- **Multi-architecture (ARM) images**: amd64 only for now.
- **Surfacing OS and dependency security updates on live boxes automatically** (Phase 7). Until then the runbook's monthly patching routine covers it.
