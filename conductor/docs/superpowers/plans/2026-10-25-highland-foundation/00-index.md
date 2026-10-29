# Plan 6 — The House Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read this index plus your task file.

**Goal:** Build the Highland house foundation: a fully tested starter web app that every client build begins from. It covers accounts, roles, the role-crossing harness, files, email, audit, the visual system, backups with a tested restore, monitoring with Matrix alerts, safe update with rollback, a tunnel hook, a demo seeder and versioning, plus one tiny example feature ("notes") that proves the pattern end to end.

**Architecture:**
- **A new, separate project:** `/root/highland-foundation`, its own git repo. It is built by the operator with Claude Code in hand-steered sessions, not by the factory (spec §5 [call]). Conductor itself is not touched.
- **npm workspaces, TypeScript end to end:**
  - `packages/shared`: roles, permissions and the input schemas, shared by the server and the browser.
  - `apps/server`: a Fastify API over PostgreSQL. It also serves the built web app.
  - `apps/web`: a React single-page app built with Vite, using Mantine as the one component library.
  - `ops`: a TypeScript command-line tool that runs in its own container. It handles backups, restore tests, the monitor and alerts, the scheduler and safe updates.
- **Access control is enforced in one place.**
  - Every API route is declared with `defineRoute`, which names its permission (or says why it is public).
  - A route registered any other way fails the role-crossing gate.
  - Data is scoped by `visibleTo(actor)` inside every repository query.
- **The role-crossing harness** builds a fixed "world": two teams, a manager and members in each, an admin, a disabled user and an anonymous visitor, each owning resources marked with unique canary strings.
  - For every registered route, it signs in as every actor and computes the expected status (401, 403, 404 or 2xx) from its **own hand-written tables**: who may see which rows (`oracle.ts`) and which roles may call each route (`EXPECTED_ROLES`). It never uses the app's `can()` or the permission a route declares, and it fails with a plain sentence when the declared permission and its table disagree.
  - It checks that no response body ever contains a canary the actor may not see.
  - It checks that a denied change left the target row **and the rest of the database** untouched.
  - It fails if any route has no crossing case, and if any route anywhere was registered without `defineRoute`.
- **Shipping:** one Docker Compose bundle containing `db`, `migrate`, `app`, `ops` and `proxy`, plus the optional `updater` and `tunnel` profiles.

**Tech Stack:** Node 22 LTS, TypeScript 6.0, npm workspaces; Fastify 5, Zod 4, Drizzle ORM + `pg`, PostgreSQL 17 (prod) / ≥15 (dev tests); React 19, React Router, TanStack Query, Mantine 9, Vite 7; Vitest, Playwright; Nodemailer; restic; Caddy; cloudflared; croner.

**Spec:** `/root/conductor/docs/superpowers/specs/2026-10-24-conductor-factory-design.md`:
- §2: the quality bar. All five items are binding.
- §4.6: run (remote access, alerts, backups, restore tests, update path).
- §5: the house stack and foundation contents, versioning [call].
- §5a: licences.
- §6: data policy fields that the foundation must make configurable (backup destination, hosting, outbound destinations).
- §7: client data never goes to the factory's models.

## Stack choices (spec §10 leaves these to the builder)

The licences below are those of the **direct** packages, read from the npm registry on 2026-10-25 (`npm view <pkg> license`). Transitive licences were **not** pre-checked for the whole plan. The exception is the build toolchain, whose full tree was checked with a throwaway install on 2026-10-25 after a review found that Vite 8 depends on `lightningcss` (MPL-2.0): the Task 1 list with `vite@7.3.7` (129 packages), plus `@vitejs/plugin-react@5.2.0` and `postcss-preset-mantine` from Task 11, are all MIT, ISC, Apache-2.0, BSD, BlueOak-1.0.0 or CC-BY-4.0 (caniuse-lite data). Every later install can still bring a surprise, so Task 1 adds a dry-run pre-flight, and the licence gate re-checks every installed package, direct and transitive, on every `npm run verify`. A task that installs something and then fails the gate must stop and either pin an older version or ask the operator; it must not add an exception on its own.

| Choice | Licence | Why this one |
|---|---|---|
| **Fastify 5** (+ `@fastify/cookie`, `multipart`, `rate-limit`, `helmet`, `static`) | MIT | Fast, small and plugin-based. It has first-class schema validation and an `onRoute` hook, which is how the crossing gate sees **every** route that exists. `inject()` makes HTTP tests fast without opening a port. |
| **Zod 4** + `fastify-type-provider-zod` | MIT | One schema serves as the TypeScript type, the server validator and the browser form validator. `z.strictObject` rejects unknown keys, which shuts out mass assignment such as a member sending `role: "admin"`. |
| **Drizzle ORM** + **drizzle-kit** + **pg** | Apache-2.0 / MIT / MIT | Typed SQL that stays close to SQL, so `visibleTo()` is a plain `WHERE` clause anyone can audit. Migrations are generated as committed `.sql` files and run with Drizzle's runtime migrator, so drizzle-kit is not needed in production. Models write it well. |
| **PostgreSQL 17** (image) | PostgreSQL | The spec's database. Tests run against any Postgres ≥ 15 (this VM has 15). |
| **Own session auth on `node:crypto` scrypt** | (built-in) | About 150 lines that we own and test completely: opaque random tokens, hashed at rest, server-side revocation. No auth framework to track; Lucia is deprecated and the others pull in large surfaces. Disabling a user or changing their role takes effect on their next request. |
| **React 19 + Vite 7 + React Router + TanStack Query** | MIT | The most mainstream SPA stack, so both frontier and local models write it fluently. The SPA has no server rendering to secure: the API is the only authority. Vite stays on 7.3.7 (all-permissive tree) until the operator rules on `lightningcss` (operator questions). |
| **Mantine 9** (`core`, `hooks`, `form`, `notifications`, `dropzone`) + **@tabler/icons-react** | MIT | One complete, polished library with a real `AppShell`, a mobile burger nav, forms, dropzone and notifications. It is CSS-module based with no Tailwind build step, and it themes from a single `createTheme`. No web fonts are shipped (system font stack), which avoids font licences. |
| **Vitest 5** / **Playwright** | MIT / Apache-2.0 | Unit and integration tests, plus browser flows and the desktop/mobile screenshot gate, whose output also feeds the Design council member later. Vitest 5 requires Vite as a peer, so Task 1 pins `vite@7.3.7` next to it. |
| **Nodemailer 10** | MIT-0 | Standard SMTP client. Mail goes through a transactional outbox table so it survives restarts and retries. **Mailpit** (MIT, dev only) catches mail in development. |
| **restic** (binary in the ops image) | BSD-2-Clause | Encrypted by default, deduplicated, and it talks to SFTP, S3-compatible, B2 and REST servers. That makes the per-project backup destination (spec §4.6) just a repository URL. |
| **Caddy** (image) | Apache-2.0 | Front door with automatic HTTPS for a public name, or `tls internal` / plain HTTP on a client LAN. |
| **cloudflared** (image, `tunnel` profile) | Apache-2.0 | Outbound-only tunnel the operator already runs. The hook is provider-neutral, so Tailscale can replace it per client. |
| **croner** | MIT | Cron expressions for the ops scheduler, with no daemon. |
| **@faker-js/faker** | MIT | Deterministic demo data (`faker.seed(42)`). |
| **yaml** | ISC | Parses `compose.yaml` in the bundle tests. |

Rejected:
- **Next.js:** a heavier, host-shaped runtime, and middleware-based auth has a history of bypasses.
- **shadcn + Tailwind:** copy-in components mean more code per client to maintain.
- **Postgres row-level security:** adds pool and migration complexity. Kept as a possible later defence in depth; the harness is the gate.
- **axe-core in the foundation:** it is MPL-2.0. Accessibility scanning belongs to the council (Phase 6), outside the shipped app.
- **Vite 8 (for now):** it has a hard dependency on `lightningcss`, MPL-2.0 including its platform binaries. It is build-time only, but it would sit in the source tree handed to the client. `@vitejs/plugin-react` 6.x needs Vite 8, so the plan uses 5.2.0.

## Rulings made while scoping (decided, not open)

1. **No public sign-up.** Accounts exist only through an admin invite, or `bootstrap-admin` for the very first admin. Why: these are staff apps for one company. Open sign-up is an access-control risk with no benefit.
2. **Status code oracle.** In order: not signed in (or disabled) → **401**; role lacks the permission → **403**; the row is outside the actor's visibility → **404**, so its existence is never confirmed; visible but the item rule forbids the action → **403**. The harness checks these exact codes.
3. **Foundation roles are `admin`, `manager`, `member`**, with teams.
   - Visibility: admin sees everything, a manager sees their team, a member sees their own rows.
   - Edits: the owner or an admin. A manager can view but not edit team rows.
   - This mirrors the expenses tracker (staff, approver, finance admin). Client apps extend `PERMISSIONS`; they do not rewrite the model.
4. **The server is the only authority.** The web app hides what a role cannot do, but that is presentation only. The harness talks to the API, never to the UI.
5. **Backups are never only on the same box.** `ops` refuses a local repository path unless `BACKUP_ALLOW_LOCAL=true` (development only), and the monitor raises a standing warning while that flag is set.
6. **Update = brief downtime, never lost writes.** The app stops before the pre-update backup, so a rollback that restores that backup loses nothing.
7. **The updater is the only container that gets the Docker socket**, and it runs only on demand (`docker compose run --rm updater …`). The long-running `ops` service never has it.
8. **Detailed health and version are token-gated.** `/healthz` and `/readyz` are public but return only `{status}` unless the request carries `x-health-token: $HEALTH_TOKEN`. Likewise `/api/version` returns only `{ app }` publicly, and adds `foundation` and `commit` only with the token, so a stranger cannot read off which `[security]` fixes a box is missing (Task 16).
9. **Out of scope** (later phases or optional modules per spec §5):
   - OCR, PDF and spreadsheet export, client-facing remote preview links;
   - S3 file storage (the `Storage` interface allows it later);
   - the factory's use of the foundation (Phase 5);
   - the council tools (Phases 2 and 6);
   - **surfacing OS and dependency security updates for live deployments** (spec §4.6, last bullet): deferred to Phase 7 (ship and run). The foundation covers the release side (Task 16's release script refuses on high-severity `npm audit` findings in shipped packages, and `[security]` changelog entries are machine-findable), and the runbook gives the operator a monthly rebuild-and-update routine (Task 21);
   - **a separate non-owner database role for the app** (`app_rw`, with only `SELECT, INSERT` on `audit_log` and no `EXECUTE` on `audit_purge_before`): later defence in depth. Until then the audit log is protected against bugs, not against a fully compromised app process (Task 5);
   - **ARM (multi-arch) images**: amd64 only until the operator answers the ARM question below.
10. **Expected access is written down by hand, twice.** The crossing harness's visibility oracle and its `EXPECTED_ROLES` table are typed out from the policy, never computed from the app's own `PERMISSIONS`, `can()` or route declarations (Task 8). Adding a route means adding its expected roles by hand.
11. **A database that has held demo data never goes live.** `ensureInstance` refuses to promote a seeded demo or test database to production, with no override, because the demo accounts and their password are published (Task 14).
12. **Users are disabled, never deleted.** `audit_log.actor_id` is `on delete no action`, pinned by a test (Task 5). Erasing a leaver's personal data under the data policy's retention rule is a later module.

## Global Constraints

- **Project:** `/root/highland-foundation`, its own git repo, branch `main`. One commit per task. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Runtime:**
  - Node `>=22.12` (Vitest 5's floor). TypeScript **6.0.3**, because typescript-eslint 8.72 supports `<6.1`.
  - ESM everywhere, `"module": "NodeNext"`, with `.js` extensions in relative imports.
- **Dependencies:**
  - Every dependency is exact-pinned (`.npmrc` `save-exact=true`), and the versions installed at scaffold time are committed in `package-lock.json`.
  - Every installed package must pass `npm run licences` (Task 1). GPL, AGPL, LGPL, MPL, EPL, SSPL, "UNLICENSED", unknown and missing licences all fail unless they are listed in `licence-exceptions.json` with the operator's reason (spec §5a).
- **Access control:**
  - Every HTTP route goes through `defineRoute` (Task 4).
  - Every query that returns client rows filters by `visibleTo(actor, …)`.
  - Input schemas are `z.strictObject`.
  - The status oracle in Ruling 2 is law.
- **Secrets:**
  - Passwords, session tokens, reset and invite tokens, `BACKUP_PASSWORD`, `MATRIX_ACCESS_TOKEN`, `HEALTH_TOKEN` and SMTP credentials never appear in logs, audit details, API responses, alert text or test snapshots.
  - Tokens are stored only as SHA-256 hashes.
- **Plain English:** every message the operator or a client sees (UI copy, alert text, `ops` and CLI output, errors) is plain UK English, with no stack traces and no error codes alone.
- **Data:** client data never goes to the factory's models (spec §7). The foundation ships with demo data only, and `seed:demo` refuses to run when `INSTANCE_MODE=production`.
- **Time:** stored as `timestamptz` in UTC and shown in `Europe/London`.
- **Tests:**
  - `npm test` runs every workspace's Vitest suite. Integration tests need `TEST_DATABASE_URL`, pointing to a Postgres role allowed to `CREATEDB`. Each test file gets its own throwaway database.
  - Tests never reach the network beyond `127.0.0.1` / `localhost`.
  - Tasks 17, 18, 20 and 21 also need Docker on the build machine (see Operator follow-ups).
  - Task 15 needs Playwright's browsers. `npx playwright install chromium webkit` needs internet only; the `--with-deps` form installs system packages with `apt` and needs **root and internet**, so run it on the build machine, not the Claude VM.
- **`npm run verify`** = lint + typecheck + licences + test. It must pass at every commit.

## Review Focus

1. **A user is disabled, or demoted from manager to member, while signed in.** Their very next request must see the new rights: a disabled user gets 401, and a demoted user no longer sees team rows. Pinned in Task 3 (`loadSession` rejects disabled users) and Task 4 (a role change applies on the next request).
2. **Self-promotion through extra fields.** A member sends `{ "role": "admin" }` to `PATCH /api/me`, or `ownerId` / `teamId` to `POST /api/notes`. The answer is 400 and nothing changes. Pinned in Task 4 (users/me) and Task 10 (notes), and replayed by the harness in Task 8.
3. **A disguised or awkward upload:**
   - HTML or SVG renamed `receipt.jpg`, a 0-byte file, a file one byte over the limit, an iPhone HEIC photo.
   - The disguised and empty files are refused, the oversize file gets 413, and HEIC is accepted.
   - Downloads never render as a web page: `nosniff`, a sandboxing CSP, and `attachment` for anything that is not a raster image.
   - Pinned in Task 9.
4. **The backup destination is unreachable at update time,** or the restore test fails. The update cancels before touching the running version, the app comes back up on the old version, and the operator gets a plain-English alert. A failed restore test raises an alert, not silence. Pinned in Tasks 18, 19 (`restoreTestJob`) and 20.
5. **Password reset abuse:**
   - an unknown email, five requests in a row, an old link used after a newer one, a link used twice, a link used after an hour.
   - The same response is given whether or not the account exists, only the newest link works, a link works once and expires after 60 minutes, and a successful reset signs out every other session.
   - Pinned in Task 7.

## Milestones

| Milestone | Tasks | Usable result at the end |
|---|---|---|
| M1 Skeleton | 1–2 | Repo, licence gate, config, database, migrations, test DB helper |
| M2 Identity and access | 3–7 | Sign-in, sessions, roles, permissions, `defineRoute`, user admin API, audit log, email outbox, invites and password reset |
| M3 The hard line | 8 | Role-crossing harness and coverage gate, with a plain-English report |
| M4 Files and the example feature | 9–10 | Uploads with type sniffing and authorised download; the notes feature end to end on the API |
| M5 Visual system | 11–15 | Theme, layout shell, account, admin and notes pages; demo seeder; Playwright flows; desktop/mobile screenshot gate |
| M6 Operations | 16–20 | Versioning, the Compose bundle with tunnel hook, encrypted backups with tested restore, health monitor with Matrix alerts, safe update with rollback |
| M7 Hand-off | 21 | README, runbook, licence notices, "building on the foundation" guide, operator smoke on a throwaway VM |

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `package.json`, `.npmrc`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `.gitignore`, `licence-exceptions.json`, `scripts/check-licences.ts` | workspaces, toolchain, `verify`, licence gate | 1 |
| `apps/server/src/config.ts`, `src/db/{client,migrate,migrate-cli}.ts`, `src/db/schema/index.ts`, `drizzle.config.ts`, `test/helpers/testDb.ts` | env config, pool, migrations, throwaway test DBs | 2 |
| `packages/shared/src/access.ts` (roles, `can`, first permission), `apps/server/src/db/schema/{teams,users,sessions}.ts`, `src/auth/{password,sessions,routes}.ts`, `src/http/{errors,csrf,route}.ts`, `src/app.ts`, `src/main.ts`, `test/helpers/{testApp,factories}.ts` | users, sessions, sign-in/out, `defineRoute`, error model, `buildApp` | 3 |
| `packages/shared/src/{access,schemas}.ts`, `apps/server/src/access/scope.ts`, `src/users/{repo,routes}.ts` | full permission table, visibility scoping, users/teams/me API | 4 |
| `apps/server/src/db/schema/audit.ts`, `drizzle/*_audit_append_only.sql`, `src/audit/{audit,routes}.ts` | append-only audit log + admin read API | 5 |
| `apps/server/src/db/schema/email.ts`, `src/email/{templates,transport,outbox}.ts` | outbox, templates, SMTP/file/memory transports, worker | 6 |
| `apps/server/src/db/schema/tokens.ts`, `src/auth/{invites,reset,bootstrap-admin}.ts` | invites, password reset, first admin | 7 |
| `apps/server/test/crossing/{world,harness,cases,crossing.test}.ts`, `reports/` | role-crossing harness, coverage gate, report | 8 |
| `apps/server/src/db/schema/files.ts`, `src/files/{storage,sniff,repo,routes}.ts` | storage driver, sniffing, upload/download | 9 |
| `apps/server/src/db/schema/notes.ts`, `src/notes/{repo,routes}.ts`, `packages/shared/src/schemas.ts` (notes) | example feature API | 10 |
| `apps/web/{index.html,vite.config.ts}`, `src/{main,theme,brand,api,auth,routes,nav}.tsx?`, `src/ui/*` | theme, layout shell, API client, auth context, house components | 11 |
| `apps/web/src/pages/account/*` | sign-in, forgot, reset, accept invite, profile | 12 |
| `apps/web/src/pages/{admin,notes}/*` | users, teams, audit, notes pages | 13 |
| `apps/server/src/seed/{registry,demo,cli,image}.ts`, `src/db/schema/instance.ts`, `src/instance.ts`, `src/db/wipe.ts` | demo-data seeder with production guards | 14 |
| `apps/web/{playwright.config.ts,e2e/*}`, `apps/server/src/e2e-server.ts` | browser flows, page registry, responsive/screenshot gate | 15 |
| `apps/server/src/version.ts`, `src/http/healthToken.ts`, `CHANGELOG.md`, `scripts/{release,changelog,stamp-foundation}.ts` | versioning, token-gated `/api/version`, security-fix tracking | 16 |
| `deploy/{Dockerfile,ops.Dockerfile,compose.yaml,compose.dev.yaml,Caddyfile,.env.example}`, `deploy/test/compose.test.ts`, `ops/src/init.ts` | images, the bundle, tunnel and TLS profiles, `ops init` | 17 |
| `ops/src/{runner,backup,restore,scheduler,cli}.ts`, `apps/server/src/db/schema/opsRuns.ts` | encrypted backups, tested restore, schedule | 18 |
| `apps/server/src/health/{checks,routes}.ts`, `ops/src/{monitor,alerts}.ts` | readiness checks, monitor, Matrix/webhook alerts, heartbeat | 19 |
| `ops/src/{update,compose}.ts` | safe update, pre-update backup, automatic rollback | 20 |
| `README.md`, `docs/{RUNBOOK,LICENCES,BUILDING-ON}.md`, `deploy/smoke/{run-smoke.sh,RESULT.md}` | hand-off docs; operator smoke | 21 |

## Tasks

1. [Repo scaffold & licence gate](task-01-scaffold-licences.md)
2. [Config, database & test DBs](task-02-config-db.md)
3. [Users, sessions & sign-in](task-03-sessions.md)
4. [Roles, permissions, route registry & user admin API](task-04-access.md)
5. [Audit log](task-05-audit.md)
6. [Transactional email](task-06-email.md)
7. [Invitations, password reset & first admin](task-07-invites-reset.md)
8. [Role-crossing harness & coverage gate](task-08-crossing.md)
9. [File uploads](task-09-files.md)
10. [Example feature: notes (API)](task-10-notes-api.md)
11. [Web scaffold, visual system & layout shell](task-11-web-shell.md)
12. [Account pages](task-12-account-pages.md)
13. [Admin & notes pages](task-13-admin-notes-pages.md)
14. [Demo-data seeder](task-14-seeder.md)
15. [Browser flows & responsive screenshot gate](task-15-browser-gate.md)
16. [Versioning & release](task-16-versioning.md)
17. [Images, Compose bundle & tunnel hook](task-17-bundle.md)
18. [Encrypted backups & tested restore](task-18-backups.md)
19. [Health checks, monitor & alerts](task-19-health-alerts.md)
20. [Safe update & automatic rollback](task-20-safe-update.md)
21. [Docs & operator smoke](task-21-docs-smoke.md)

Order matters:
- 2 needs 1; 3 needs 2; 4 needs 3; 5–7 need 4 (7 also needs 5 and 6).
- 8 needs 4–7 and is re-run by every later task that adds a route (9, 10, 16, 19).
- 11 needs 4; 12–13 need 11 and the matching API; 14 needs 10; 15 needs 12–14.
- 17 needs 16; 18 needs 17; 19 needs 18; 20 needs 18–19; 21 needs everything.

## Shared Interfaces (all tasks)

```ts
// ── Task 2 · apps/server/src/config.ts
type InstanceMode = 'demo' | 'production' | 'test';
interface Config {
  instanceMode: InstanceMode; appName: string; appOrigin: string; port: number;
  databaseUrl: string; cookieSecure: boolean;
  uploadDir: string; uploadMaxBytes: number;                 // default 15 * 1024 * 1024
  email: { transport: 'smtp' | 'file' | 'memory'; smtpUrl?: string; fileDir?: string; from: string };
  healthToken?: string; appVersion: string; commit: string; webDistDir?: string;
}
loadConfig(env?: NodeJS.ProcessEnv): Config               // throws ConfigError(problems: string[]) — plain English, one line per bad var
// apps/server/src/db/client.ts
type Db = NodePgDatabase<typeof schema>; type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
createDb(url: string): { db: Db; pool: pg.Pool; close(): Promise<void> }
runMigrations(db: Db): Promise<void>                      // drizzle-orm/node-postgres/migrator, folder apps/server/drizzle
// apps/server/test/helpers/testDb.ts
createTestDb(): Promise<{ url: string; db: Db; close(): Promise<void> }>   // fresh migrated hf_test_<hex>, dropped on close

// ── Task 3
hashPassword(pw: string): Promise<string>                 // 'scrypt$32768$8$1$<salt b64url>$<hash b64url>'
verifyPassword(pw: string, stored: string): Promise<boolean>
checkPasswordRules(pw: string, email: string): string | null   // plain-English problem or null
interface Actor { id: string; email: string; name: string; role: Role; teamId: string | null }
createSession(db: Db | Tx, userId: string, meta: { ip?: string; userAgent?: string }, now?: Date): Promise<{ token: string; expiresAt: Date }>
loadSession(db: Db, token: string, now?: Date): Promise<{ actor: Actor; sessionId: string } | null>
revokeSessions(db: Db | Tx, userId: string, opts?: { exceptSessionId?: string }): Promise<number>
SESSION_COOKIE = 'hf_session'; SESSION_IDLE_MS = 7 * 86400e3; SESSION_ABSOLUTE_MS = 30 * 86400e3
buildApp(deps: { config: Config; db: Db; emailTransport?: EmailTransport; storage?: Storage; now?: () => Date }): Promise<FastifyInstance>
// request decorations: req.actor: Actor | null; req.sessionId: string | null
// apps/server/test/helpers/testApp.ts
createTestApp(overrides?: Partial<Config> & { beforeReady?: (app) => void | Promise<void> }): Promise<{ app; db; config; mail: MemoryTransport; storageDir: string; close() }>   // beforeReady: Task 8
signInAs(t, user: { id: string }): Promise<{ cookie: string }>      // creates a session directly; cookie header value
call(t, auth: { cookie: string } | null, method, url, body?): Promise<{ status: number; json: any; text: string; headers }>

// ── Task 3 (moved forward so routes exist from the start) · packages/shared/src/access.ts
ROLES = ['admin', 'manager', 'member'] as const; type Role = typeof ROLES[number]
PERMISSIONS: Record<Permission, readonly Role[]>; type Permission = keyof typeof PERMISSIONS   // Task 3: 'self:manage' only; Task 4: the full table
can(role: Role, perm: Permission): boolean
// apps/server/src/http/route.ts
defineRoute<S extends RouteSchemas>(app, spec: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string;
  access: { public: string } | { permission: Permission };   // public: the reason it is public
  schema?: { params?: ZodType; query?: ZodType; body?: ZodType };
  config?: Record<string, unknown>;                           // passed to Fastify, e.g. { rateLimit: { …, hook: 'preHandler' } }
  handler(req, reply, ctx: { actor: Actor | null; db: Db }): Promise<unknown>;
}): void
app.hf.routes: { method: string; url: string; access: RouteAccess }[]     // every defineRoute call
app.hf.allRoutes: { method: string; url: string }[]                       // every route Fastify saw (onRoute hook)
app.hf.staticRoutes: { method: string; url: string }[]                    // built web app files (Task 11); the only allow-list for routes outside defineRoute
// ── Task 4 · apps/server/src/access/scope.ts
visibleTo(actor: Actor, cols: { owner: PgColumn; team: PgColumn }): SQL | undefined   // undefined = admin (no filter)
canSee(actor: Actor, row: { ownerId: string; teamId: string | null }): boolean
canEdit(actor: Actor, row: { ownerId: string }): boolean                 // owner or admin
// apps/server/src/http/errors.ts (Task 3)
class HttpError extends Error { status: number; userMessage: string; issues?: unknown }
unauthorized() 401 · forbidden() 403 · notFound() 404 · badRequest(msg, issues?) 400 · tooLarge() 413 · conflict(msg) 409

// ── Task 5
audit(db: Db | Tx, ctx: { actor: Actor | null; ip?: string }, e: { action: AuditAction; targetType?: string; targetId?: string; details?: Record<string, unknown> }): Promise<void>
AUDIT_ACTIONS (const array) ; redactDetails(d): Record<string, unknown>   // keys matching /pass|token|secret|key/i -> '[redacted]'

// ── Task 6
type TemplateName = 'invite' | 'password-reset' | 'password-changed'
renderTemplate(name, data, site: { appName: string; appOrigin: string }): { subject: string; text: string; html: string }
interface EmailTransport { send(m: { to: string; from: string; subject: string; text: string; html: string }): Promise<void> }
createTransport(cfg: Config['email']): EmailTransport ; memoryTransport(): EmailTransport & { sent: EmailMessage[] }
queueEmail(tx: Db | Tx, m: { to: string; template: TemplateName; data: Record<string, string> }): Promise<void>
processOutbox(db, transport, site, opts?: { now?: Date; batch?: number }): Promise<{ sent: number; retried: number; failed: number }>
startOutboxWorker(db, transport, site, { intervalMs = 5000 }): () => Promise<void>   // returns stop()
RETRY_DELAYS_MS = [60e3, 300e3, 1800e3, 7200e3, 21600e3]                          // then 'failed'

// ── Task 7
createInvite(tx, actor, input: InviteInput): Promise<{ userId: string }>   // queues 'invite' mail with link
acceptInvite(db, token, password, meta): Promise<{ token: string /* session */ }>
requestPasswordReset(db, email, meta): Promise<void>                        // silent for unknown email
resetPassword(db, token, password): Promise<void>
TOKEN_TTL = { invite: 7 * 86400e3, reset: 60 * 60e3 }

// ── Task 8 · apps/server/test/crossing/
ACTORS = ['anon', 'admin', 'northManager', 'northAlice', 'northBob', 'southManager', 'southCarol', 'disabledDave'] as const
buildWorld(t): Promise<World>; world.reset(): Promise<void>; world.resources: Record<ResourceType, WorldResource[]>
type CrossingCase = ItemCase | ListCase | ActionCase                     // see Task 8
EXPECTED_ROLES: Record<Route, readonly Role[]>                           // hand-written; never derived from PERMISSIONS
runCrossing(world, cases, expected = EXPECTED_ROLES): Promise<{ checks: number; failures: CrossingFailure[] }>
uncoveredRoutes(app, cases, expected = EXPECTED_ROLES): string[] ; dbFingerprint(t): Promise<Record<string, string>> ; writeCrossingReport(result, dir = 'reports')

// ── Task 9
interface Storage { put(key: string, data: Readable): Promise<{ size: number; sha256: string }>; get(key: string): Readable; delete(key: string): Promise<void>; check(): Promise<void> }
new LocalDiskStorage(root: string)
sniffType(head: Buffer): AllowedType | null    // 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic' | 'application/pdf'

// ── Task 10
listNotes(db, actor, q: { cursor?: string; limit: number }) ; getNote(db, actor, id) ; createNote(db, actor, input, ip) ; updateNote(...) ; deleteNote(...)

// ── Task 14
ensureInstance(db: Db, mode: InstanceMode): Promise<void>      // a production database never starts in demo mode again; a seeded database is never promoted to production
registerSeeder(s: { name: string; order: number; run(ctx: SeedCtx): Promise<void> }) ; seedDemo(db, cfg): Promise<SeedSummary>

// ── Task 16
getVersionInfo(cfg): { app: string; foundation: string; commit: string }   // GET /api/version: { app } publicly, all three with x-health-token
hasHealthToken(req, cfg): boolean                                          // apps/server/src/http/healthToken.ts; reused by /readyz
securityFixesSince(changelog: string, version: string): { version: string; lines: string[] }[]

// ── Task 18 · ops/src
interface Runner { run(cmd: string, args: string[], opts?: { env?: Record<string, string>; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> }
runBackup(deps: OpsDeps, kind: 'scheduled' | 'pre-update' | 'manual'): Promise<{ snapshotId: string }>   // counts and pg_dump share one exported snapshot; fixed work folder; --group-by host
verifyLatestRestore(deps: OpsDeps): Promise<{ ok: boolean; problems: string[] }>
restoreDatabase(deps: OpsDeps, snapshotId: string, targetDb: string): Promise<void>   // DROP … WITH (FORCE) + CREATE, then pg_restore: nothing from a failed migration survives
recordRun(deps, kind: OpsRunKind, ok: boolean, detail: string): Promise<void>      // table ops_runs

// ── Task 19
GET /readyz -> { status: 'ok' | 'degraded' | 'down', checks?: { name: string; ok: boolean; detail: string }[] }
interface AlertChannel { send(text: string): Promise<void> } ; matrixChannel(cfg) ; webhookChannel(url)
channelFromConfig(cfg, log): AlertChannel   // configured channels always; logChannel only when none is set and the mode is demo/test
new Monitor({ checks, channel, heartbeatUrl?, failAfter = 2, remindEveryMs = 6 * 3600e3, now }) .tick(): Promise<void>

// ── Task 20
runUpdate(deps: UpdateDeps, opts: { to: string }): Promise<UpdateOutcome>    // 'updated' | 'cancelled' | 'rolled-back' | 'rollback-failed'; stops app and ops first
```

## Operator follow-ups (outside the code)

Task 21's RESULT template also lists these.
- **Build machine with Docker.** This VM has no Docker socket. Tasks 17, 18, 20 and 21 need a machine with Docker Engine and Compose v2 and outbound internet (npm, Playwright browsers, images), for example a dedicated LXC or VM. Task 15's `npx playwright install --with-deps` also belongs there, because it installs system packages as root. Postgres ≥15 for `TEST_DATABASE_URL` is already available on this VM.
- **Matrix alert identity.** Create a bot account and a private alerts room on the Synapse server. Store `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN` and `MATRIX_ROOM_ID` per deployment.
- **External "box is down" watcher.** A monitor inside the box cannot report its own power cut. Run a heartbeat receiver the operator controls (Uptime Kuma push monitor, MIT, self-hosted) and set `HEARTBEAT_URL` per deployment.
- **Backup destinations and keys.** Choose per client (spec §4.6; client-owned storage is the default suggestion). Store each deployment's `BACKUP_PASSWORD` **off the box**, in the operator's password manager. Without it, the backups cannot be read.
- **Image delivery.** Choose a private registry, or `docker save | docker load` over the tunnel. The updater supports both.
- **Tunnel accounts.** A Cloudflare tunnel token per deployment, or a Tailscale auth key if a client prefers that.
- **Solicitor.** Check the §5a ownership and licence terms before the first contract; `docs/LICENCES.md` gives them the dependency list.

## Operator questions (open; the plan's defaults let work start without them)

1. **Vite 8 and `lightningcss` (MPL-2.0).** Vite 8, and so the newest Vitest's required Vite peer, depends on `lightningcss`. It is a build-time CSS tool and is not in the runtime image, but it would be in the source handed to the client. Accept it in `licence-exceptions.json` for the foundation, or stay on Vite 7 (all permissive) until that changes? **Default in this plan:** Vite 7.3.7 and `@vitejs/plugin-react` 5.2.0; no exception.
2. **Does the §5a permissive-only rule cover the operating-system packages inside the shipped Docker images?** The Debian base includes GPL/LGPL tools such as bash and glibc. Or does it cover only the app's own npm dependencies? The council's Legal member needs a fixed answer. **Default in this plan:** the gate covers npm packages; `docs/LICENCES.md` lists the images and notes the Debian base's mixed free licences (Task 21).
3. **Will any client box be ARM** (a Raspberry Pi or an ARM mini-PC)? The plan builds amd64-only images and downloads the amd64 restic binary; ARM needs multi-arch builds. **Default in this plan:** amd64 only (Ruling 9).
