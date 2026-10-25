# Task 17: Images, Compose bundle & tunnel hook

Spec §4.5: "a deployment bundle (Docker Compose) that runs on any ordinary Linux machine". §4.6: "an outbound-only secure tunnel from the box, so no inbound firewall holes are needed on the client's network."

This task builds:
- the two images (`app` and `ops`);
- the Compose file;
- the Caddy front door;
- the optional `tunnel` profile;
- `ops init`, which writes a deployment's `.env` with strong random secrets and a plain-English checklist.

Static tests pin the security shape of the Compose file, so a later edit cannot quietly publish the database port or hand the Docker socket to a long-running service.

> **Needs Docker** on the build machine for Steps 6–7 (see the operator follow-ups in the index). Steps 1–5 do not.

**Files:**
- Create: `deploy/{Dockerfile,ops.Dockerfile,compose.yaml,Caddyfile,.env.example,.dockerignore}`, `deploy/vitest.config.ts`, `deploy/test/compose.test.ts`
- Create: `ops/src/{cli,init}.ts`, `ops/vitest.config.ts`, `ops/test/init.test.ts`
- Create: `scripts/bundle.ts`
- Modify: root `vitest.config.ts` (add the `deploy` project), root `package.json` (`"bundle": "tsx scripts/bundle.ts"`, `"images": "docker build -f deploy/Dockerfile -t highland/app:$npm_package_version --build-arg APP_VERSION=$npm_package_version --build-arg GIT_COMMIT=$(git rev-parse --short HEAD) . && docker build -f deploy/ops.Dockerfile -t highland/ops:$npm_package_version ."`)

**Interfaces:**
- Consumes:
  - `migrate-cli.js` (Task 2), `main.ts` (Task 3), `ensureInstance` (Task 14), `/healthz` (Task 19 adds the full version; for now add a minimal `GET /healthz` → `{ status: 'ok' }` to `app.ts` through `defineRoute` with `access: { public: 'liveness for Docker' }`, and Task 19 replaces it);
  - `foundation.json` (Task 16).
- Produces:
  - Images:
    - `highland/app:<version>`: `node apps/server/dist/main.js`, user `node`, port 3000, with OCI labels for version and revision;
    - `highland/ops:<version>`: Node 22 + `postgresql-client-17` + `restic` (pinned release binary, SHA-256 checked) + `docker-ce-cli` + `docker-compose-plugin`; entrypoint `node ops/dist/cli.js`.
  - Compose services: `db`, `migrate`, `app`, `ops`, `proxy`, `updater` (profile `tools`), `tunnel` (profile `tunnel`). Named volumes: `pgdata`, `uploads`, `state`, `caddy_data`.
  - `ops` CLI commands, added over Tasks 17–20: `init`, `backup`, `restore-test`, `restore`, `check`, `daemon`, `update`.
  - `generateEnv(opts: { client: string; origin: string; siteAddress: string; bundleDir: string; mode: 'demo' | 'production'; random?: (bytes: number) => string }): { env: string; checklist: string }`.
  - `npm run bundle` → `dist/highland-bundle-<version>.tar.gz` containing `compose.yaml`, `Caddyfile`, `.env.example` and `RUNBOOK.md`.

`compose.yaml` (write it like this; pin the exact third-party tags current at implementation time, never `latest`):

```yaml
name: ${COMPOSE_PROJECT_NAME:-highland}
x-db-url: &dburl postgres://app:${DB_PASSWORD:?run ops init}@db:5432/app
# Everything ops needs. Shared by `ops` and `updater`, so an update can back up, alert and
# address the right project with exactly the settings the daemon uses.
x-ops-env: &opsenv
  COMPOSE_PROJECT_NAME: ${COMPOSE_PROJECT_NAME:-highland}
  INSTANCE_MODE: ${INSTANCE_MODE:-production}
  DATABASE_URL: *dburl
  APP_INTERNAL_URL: http://app:3000
  CLIENT_LABEL: ${CLIENT_LABEL:?}
  HEALTH_TOKEN: ${HEALTH_TOKEN}
  BACKUP_REPOSITORY: ${BACKUP_REPOSITORY:?}
  BACKUP_PASSWORD: ${BACKUP_PASSWORD:?}
  BACKUP_ALLOW_LOCAL: ${BACKUP_ALLOW_LOCAL:-false}
  BACKUP_SCHEDULE: ${BACKUP_SCHEDULE:-30 2 * * *}
  RESTORE_TEST_SCHEDULE: ${RESTORE_TEST_SCHEDULE:-30 4 * * 0}
  BACKUP_KEEP: ${BACKUP_KEEP:---keep-daily 7 --keep-weekly 5 --keep-monthly 12}
  AUDIT_RETENTION_DAYS: ${AUDIT_RETENTION_DAYS:-730}
  AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID:-}
  AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:-}
  B2_ACCOUNT_ID: ${B2_ACCOUNT_ID:-}
  B2_ACCOUNT_KEY: ${B2_ACCOUNT_KEY:-}
  RESTIC_REST_USERNAME: ${RESTIC_REST_USERNAME:-}
  RESTIC_REST_PASSWORD: ${RESTIC_REST_PASSWORD:-}
  MATRIX_HOMESERVER: ${MATRIX_HOMESERVER:-}
  MATRIX_ACCESS_TOKEN: ${MATRIX_ACCESS_TOKEN:-}
  MATRIX_ROOM_ID: ${MATRIX_ROOM_ID:-}
  ALERT_WEBHOOK_URL: ${ALERT_WEBHOOK_URL:-}
  HEARTBEAT_URL: ${HEARTBEAT_URL:-}
  TUNNEL_ENABLED: ${TUNNEL_ENABLED:-false}
services:
  db:
    image: postgres:17-bookworm   # pin to the exact 17.x tag, e.g. postgres:17.6-bookworm
    restart: unless-stopped
    environment: { POSTGRES_DB: app, POSTGRES_USER: app, POSTGRES_PASSWORD: "${DB_PASSWORD}" }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD", "pg_isready", "-U", "app", "-d", "app"], interval: 5s, retries: 20 }
  migrate:
    image: ${APP_IMAGE:-highland/app}:${APP_TAG:?}
    command: ["node", "apps/server/dist/db/migrate-cli.js"]
    environment: { DATABASE_URL: *dburl }
    depends_on: { db: { condition: service_healthy } }
    restart: "no"
  app:
    image: ${APP_IMAGE:-highland/app}:${APP_TAG}
    restart: unless-stopped
    environment:
      INSTANCE_MODE: ${INSTANCE_MODE:-production}
      APP_NAME: ${APP_NAME:?}
      APP_ORIGIN: ${APP_ORIGIN:?}
      DATABASE_URL: *dburl
      UPLOAD_DIR: /data/uploads
      EMAIL_TRANSPORT: smtp
      SMTP_URL: ${SMTP_URL:?}
      EMAIL_FROM: ${EMAIL_FROM:?}
      HEALTH_TOKEN: ${HEALTH_TOKEN:?}
      APP_VERSION: ${APP_TAG}
      WEB_DIST_DIR: /app/apps/web/dist
    volumes: [uploads:/data/uploads]
    depends_on: { migrate: { condition: service_completed_successfully } }
  ops:
    image: ${OPS_IMAGE:-highland/ops}:${APP_TAG}
    command: ["daemon"]
    restart: unless-stopped
    environment: *opsenv
    volumes: [uploads:/data/uploads, state:/state]
    depends_on: { db: { condition: service_healthy } }
  proxy:
    image: caddy:2-alpine   # pin exact, e.g. caddy:2.10.2-alpine
    restart: unless-stopped
    ports: ["${HTTP_PORT:-80}:80", "${HTTPS_PORT:-443}:443"]
    environment: { SITE_ADDRESS: "${SITE_ADDRESS:-:80}" }
    volumes: ["./Caddyfile:/etc/caddy/Caddyfile:ro", "caddy_data:/data"]
    depends_on: [app]
  updater:
    profiles: [tools]
    image: ${OPS_IMAGE:-highland/ops}:${UPDATER_TAG:-${APP_TAG}}
    working_dir: ${HF_BUNDLE_DIR:?}
    environment:
      <<: *opsenv
      HF_BUNDLE_DIR: ${HF_BUNDLE_DIR}
    volumes: ["/var/run/docker.sock:/var/run/docker.sock", "${HF_BUNDLE_DIR}:${HF_BUNDLE_DIR}", "uploads:/data/uploads", "state:/state"]
  tunnel:
    profiles: [tunnel]
    image: cloudflare/cloudflared:2025.10.0   # pin exact current
    restart: unless-stopped
    command: ["tunnel", "--no-autoupdate", "--metrics", "0.0.0.0:2000", "run"]
    environment: { TUNNEL_TOKEN: "${TUNNEL_TOKEN:-}" }   # empty → cloudflared exits; the monitor reports it (Task 19)
    extra_hosts: ["host.docker.internal:host-gateway"]
volumes: { pgdata: {}, uploads: {}, state: {}, caddy_data: {} }
```

Notes:
- `:?` (required) is used only for values every deployment has. Optional services use `:-`, because Compose interpolates the whole file even for profiles that are not enabled.
- The bundle directory is mounted at the **same absolute path** inside `updater` (`HF_BUNDLE_DIR`), so the relative `./Caddyfile` resolves the same way for the host's Docker daemon.
- `updater`'s environment is `ops`'s plus `HF_BUNDLE_DIR`, through the `x-ops-env` anchor. Without that, an update would act on the default `highland` project instead of `COMPOSE_PROJECT_NAME`, refuse a development-only local backup repository, and fail to reach an S3, B2 or password-protected REST destination. A static test pins it.
- The updater's own `docker compose` calls (Task 20) pass `--project-directory` and `-p` but **never `-f`**, so Compose still loads `compose.override.yaml` from the bundle directory when there is one (the smoke uses one for `extra_hosts`, Task 21).
- The tunnel's routes (to `http://proxy:80` for the app, and to `ssh://host.docker.internal:22` for operator SSH) are set in the Cloudflare dashboard, which matches how the operator runs tunnels today.
- A Tailscale alternative is documented in the runbook (Task 21) as a swap of the `tunnel` service.

`Caddyfile`:

```
{$SITE_ADDRESS} {
	encode zstd gzip
	reverse_proxy app:3000
}
```

`SITE_ADDRESS` takes one of these forms:
- `:80` for a client LAN without TLS (`APP_ORIGIN=http://…`, so cookies are not Secure);
- `app.client.co.uk` for automatic public HTTPS;
- `https://app.lan { tls internal }`, which is a runbook recipe.

- [ ] **Step 1: Write the failing static tests**

`deploy/test/compose.test.ts`:

```ts
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const raw = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
const c = parse(raw, { merge: true }) as { services: Record<string, any> };   // merge: true resolves `<<: *opsenv` as Compose does
const S = c.services;

test('only the front door publishes ports; the database is never reachable from outside', () => {
  const publishing = Object.entries(S).filter(([, s]) => s.ports?.length).map(([n]) => n);
  expect(publishing).toEqual(['proxy']);
});

test('the tunnel is outbound-only, optional and pinned', () => {
  expect(S.tunnel.profiles).toEqual(['tunnel']);
  expect(S.tunnel.ports).toBeUndefined();
  expect(S.tunnel.command).toContain('--no-autoupdate');
});

test('only the on-demand updater gets the Docker socket', () => {
  const withSock = Object.entries(S).filter(([, s]) => (s.volumes ?? []).some((v: string) => String(v).includes('docker.sock'))).map(([n]) => n);
  expect(withSock).toEqual(['updater']);
  expect(S.updater.profiles).toEqual(['tools']);
});

test('the updater has every setting the ops daemon has, plus the bundle path', () => {
  const ops = Object.keys(S.ops.environment);
  const upd = Object.keys(S.updater.environment);
  expect(ops.filter((k) => !upd.includes(k))).toEqual([]);
  for (const k of ['COMPOSE_PROJECT_NAME', 'INSTANCE_MODE', 'BACKUP_ALLOW_LOCAL', 'APP_INTERNAL_URL', 'AWS_SECRET_ACCESS_KEY', 'B2_ACCOUNT_KEY', 'RESTIC_REST_PASSWORD'])
    expect(upd, k).toContain(k);
  expect(upd).toContain('HF_BUNDLE_DIR');
});

test('the app container gets no backup or alert secrets', () => {
  const env = Object.keys(S.app.environment);
  for (const k of ['BACKUP_PASSWORD', 'BACKUP_REPOSITORY', 'MATRIX_ACCESS_TOKEN', 'TUNNEL_TOKEN', 'AWS_SECRET_ACCESS_KEY']) expect(env).not.toContain(k);
});

test('third-party images are pinned to a version, never latest', () => {
  for (const [n, s] of Object.entries(S)) {
    const img = String(s.image);
    if (img.includes('${')) continue;           // our own images, tagged by APP_TAG
    expect(img, n).toMatch(/:[0-9][^:]*$/);
    expect(img, n).not.toMatch(/:latest$/);
  }
});

test('every ${VAR} used is documented in .env.example', () => {
  const used = new Set([...raw.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]!));
  const documented = new Set([...readFileSync(new URL('../.env.example', import.meta.url), 'utf8').matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]!));
  expect([...used].filter((v) => !documented.has(v))).toEqual([]);
});
```

(The pinned-tag test makes `postgres:17-bookworm` and `caddy:2-alpine` fail until they are pinned to exact versions, as intended.)

`ops/test/init.test.ts`:

```ts
import { test, expect } from 'vitest';
import { generateEnv } from '../src/init.js';

const opts = { client: 'Acme Ltd', origin: 'https://expenses.acme.co.uk', siteAddress: 'expenses.acme.co.uk', bundleDir: '/opt/highland/acme', mode: 'production' as const };

test('secrets are strong, distinct and present; the operator is told to save the backup key off the box', () => {
  const { env, checklist } = generateEnv(opts);
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(env)?.[1];
  for (const k of ['DB_PASSWORD', 'HEALTH_TOKEN', 'BACKUP_PASSWORD']) expect(get(k)!.length, k).toBeGreaterThanOrEqual(43);
  expect(new Set(['DB_PASSWORD', 'HEALTH_TOKEN', 'BACKUP_PASSWORD'].map(get)).size).toBe(3);
  expect(get('APP_ORIGIN')).toBe('https://expenses.acme.co.uk');
  expect(get('HF_BUNDLE_DIR')).toBe('/opt/highland/acme');
  expect(get('INSTANCE_MODE')).toBe('production');
  expect(get('CLIENT_LABEL')).toBe('Acme Ltd');
  expect(checklist).toContain('Save BACKUP_PASSWORD in your password manager now. Without it the backups cannot be read, and it must not live only on this box.');
});

test('every variable in .env.example appears in a generated file', async () => {
  const { readFileSync } = await import('node:fs');
  const example = [...readFileSync(new URL('../../deploy/.env.example', import.meta.url), 'utf8').matchAll(/^#?\s*([A-Z0-9_]+)=/gm)].map((m) => m[1]);
  const { env } = generateEnv(opts);
  expect(example.filter((k) => !new RegExp(`^#?\\s*${k}=`, 'm').test(env))).toEqual([]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project deploy --project ops`
Expected: FAIL. The files are missing.

- [ ] **Step 3: Write `compose.yaml`, `Caddyfile` and `.env.example`**

- Use the shapes above. Pin `postgres`, `caddy` and `cloudflared` to the exact current tags.
- `.env.example` documents every variable, one plain-English comment line each, grouped under headings:
  - `# The app`
  - `# Mail`
  - `# Backups (where they go is set by the client's data policy)`
  - `# Alerts`
  - `# Remote access (outbound tunnel)`
  - `# Advanced`

- [ ] **Step 4: Implement `ops/src/init.ts` and `cli.ts init`**

- `random` defaults to `(n) => randomBytes(n).toString('base64url')` with n = 32.
- Optional values are written commented out (`# MATRIX_HOMESERVER=`), with their comment lines.
- `checklist` is a numbered plain-English list:
  1. save `BACKUP_PASSWORD` (the exact sentence from the test);
  2. fill in `SMTP_URL` / `EMAIL_FROM`;
  3. set `BACKUP_REPOSITORY` to the destination in the client's data policy;
  4. set the Matrix alert details;
  5. optionally `TUNNEL_TOKEN`, then add `--profile tunnel` when starting.
- `cli.ts init --client … --origin … --site … --dir … [--demo]` writes the env to stdout and the checklist to stderr, so `ops init … > .env` works.

- [ ] **Step 5: Write the Dockerfiles and `scripts/bundle.ts`**

- `deploy/Dockerfile`:
  - stage `build` on `node:22-bookworm-slim`: copy the manifests first, `npm ci`, copy the source, then `npm run build -w @hf/shared -w @hf/server -w @hf/web` and `npm prune --omit=dev`;
  - runtime stage on `node:22-bookworm-slim`: copy `node_modules`, `package.json`, `foundation.json`, `packages/shared/{package.json,dist}`, `apps/server/{package.json,dist,drizzle}` and `apps/web/dist`;
  - `ARG APP_VERSION GIT_COMMIT` → `ENV`;
  - `RUN mkdir -p /data/uploads && chown node:node /data/uploads`, **before** `USER node`. Docker initialises an empty named volume from the image's folder, ownership included; without this the `uploads` volume is root-owned and every upload (and the demo seeder) fails with `EACCES`;
  - then `USER node`, `EXPOSE 3000`;
  - `HEALTHCHECK CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`.
- `deploy/ops.Dockerfile`:
  - apt sources for `apt.postgresql.org` (bookworm-pgdg) and `download.docker.com`, then install `postgresql-client-17 docker-ce-cli docker-compose-plugin ca-certificates`;
  - restic: `ARG RESTIC_VERSION=0.18.1` and `ARG RESTIC_SHA256=<from the release's SHA256SUMS>`; `curl` the `restic_${RESTIC_VERSION}_linux_amd64.bz2` asset, `echo "$RESTIC_SHA256  restic.bz2" | sha256sum -c`, then `bunzip2`;
  - `RUN mkdir -p /data/uploads && chown 1000:1000 /data/uploads` as well (uid/gid 1000 is `node` in the app image). `ops` can start before `app` and be the first container to mount the `uploads` volume, so both images must give the folder the same owner;
  - build the `ops` workspace; `ENTRYPOINT ["node", "ops/dist/cli.js"]`. Ops runs as root (it needs the Docker socket in `updater`), so anything it writes under `/data/uploads` must be handed back to 1000:1000 (Task 18, `ops restore`).
- `.dockerignore`: `node_modules`, `**/dist`, `reports`, `.git`, `.env`, `apps/web/e2e/.auth`.
- `scripts/bundle.ts`: creates the tarball with `tar -czf`, through `node:child_process` `execFileSync`.

- [ ] **Step 6: Verify (static, any machine)**

Run: `npm run verify`
Expected: all tests PASS (9 new).

- [ ] **Step 7: Verify (Docker build machine)**

Run:
```bash
npm run images
mkdir -p /tmp/hf-bundle && cp deploy/compose.yaml deploy/Caddyfile /tmp/hf-bundle/
docker run --rm highland/ops:0.1.0 init --client "Demo" --origin http://localhost:8080 --site :80 --dir /tmp/hf-bundle --demo > /tmp/hf-bundle/.env
cd /tmp/hf-bundle && printf 'APP_TAG=0.1.0\nHTTP_PORT=8080\nHTTPS_PORT=8443\nSMTP_URL=smtp://localhost:1025\nEMAIL_FROM=demo@demo.test\nBACKUP_REPOSITORY=/state/restic-local\nBACKUP_ALLOW_LOCAL=true\nAPP_NAME=Demo\n' >> .env
docker compose config -q && docker compose up -d && sleep 20
curl -fsS http://localhost:8080/healthz && curl -fsS http://localhost:8080/sign-in | grep -q '<div id="root">' && echo BUNDLE-OK
docker compose exec app node apps/server/dist/seed/cli.js | head -3
docker compose down -v
```
Expected:
- `{"status":"ok"}`, then `BUNDLE-OK`;
- the seeder's first line `Demo data added: 2 teams, 10 people, 32 notes, 16 attached photos.`;
- a clean teardown.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: app and ops images, Compose bundle with outbound-only tunnel profile, ops init

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
