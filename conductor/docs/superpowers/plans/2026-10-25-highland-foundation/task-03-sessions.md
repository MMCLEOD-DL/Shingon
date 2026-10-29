# Task 3: Users, sessions & sign-in

This task covers accounts and sign-in (spec §5), and the first half of the access-control hard line (§2.1): who is asking.

Sessions are opaque random tokens kept in an `httpOnly` cookie and stored only as SHA-256 hashes. Every request loads its session from the database, so disabling a user or changing their role takes effect on their next request (Review Focus 1). This task also creates `defineRoute` and the error model, so that every later route is declared the same way from the start.

**Files:**
- Create:
  - `packages/shared/src/access.ts`: `ROLES`, `Role`, the initial `PERMISSIONS`, `can`.
  - `apps/server/src/db/schema/{teams,users,sessions}.ts`
  - `apps/server/src/auth/{password,sessions,routes}.ts`
  - `apps/server/src/http/{errors,csrf,route}.ts`
  - `apps/server/src/{app,main}.ts`
  - `apps/server/test/helpers/{testApp,factories}.ts`
- Modify: `apps/server/src/db/schema/index.ts`, `packages/shared/src/index.ts`
- Test: `apps/server/test/password.test.ts`, `apps/server/test/sessions.test.ts`, `apps/server/test/auth-routes.test.ts`

**Interfaces:**
- Consumes: `Config`, `Db`, `createTestDb` (Task 2).
- Produces:
  - `hashPassword`, `verifyPassword`, `checkPasswordRules`, `Actor`, `createSession`, `loadSession`, `revokeSessions`, the `SESSION_*` constants, `buildApp`, `createTestApp`, `signInAs`, `call`, `HttpError` and the error helpers, `defineRoute`, `app.hf.routes`, `app.hf.allRoutes`. Signatures are in the index.
  - **Moved here from Task 4 so routes exist from the start:** `ROLES`, `Role`, `can`, and an initial `PERMISSIONS = { 'self:manage': ['admin', 'manager', 'member'] }`. Task 4 adds the rest.
  - `apps/server/test/helpers/factories.ts`:
    - `makeTeam(db, name): Promise<{ id: string }>`
    - `makeUser(db, opts: { role: Role; teamId?: string | null; email?: string; name?: string; password?: string | null; disabled?: boolean }): Promise<{ id: string; email: string; password: string }>`
    - The default password is `'correct horse battery'`; the default email is `user-<n>@hf.test`.
  - Routes:
    - `POST /api/auth/sign-in` (public: "signing in")
    - `POST /api/auth/sign-out` (`self:manage`)
    - `GET /api/me` (`self:manage`), which returns `{ user: Actor }`
  - `main.ts` loads the config, creates the database, runs migrations only when `RUN_MIGRATIONS=true` (development; production uses the `migrate` service, Task 17), calls `buildApp` and listens on `0.0.0.0:PORT`. On `ConfigError` it prints the message and exits 1.

Tables:
- `teams(id uuid pk default gen_random_uuid(), name text not null unique, created_at timestamptz default now())`
- `users(id uuid pk default gen_random_uuid(), email text not null unique, name text not null, role text not null check (role in ('admin','manager','member')), team_id uuid null references teams(id), password_hash text null, disabled_at timestamptz null, created_at timestamptz default now(), updated_at timestamptz default now())`
  - Emails are stored lower-cased and trimmed.
  - `password_hash` stays null until an invite is accepted.
- `sessions(id text pk /* sha256 hex of token */, user_id uuid not null references users(id) on delete cascade, created_at, last_seen_at, expires_at timestamptz not null, ip text, user_agent text)`, plus an index on `user_id`.

- [ ] **Step 1: Install**

```bash
npm -w @hf/server i @fastify/cookie@11.1.3 @fastify/helmet@13.2.0 @fastify/rate-limit@11.2.1 fastify-type-provider-zod@7.0.0
npm -w @hf/server i @hf/shared@*
```

- [ ] **Step 2: Write the failing tests**

`apps/server/test/password.test.ts`:

```ts
import { test, expect } from 'vitest';
import { hashPassword, verifyPassword, checkPasswordRules } from '../src/auth/password.js';

test('hash format and verification', async () => {
  const h = await hashPassword('correct horse battery');
  expect(h).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$/);
  expect(await verifyPassword('correct horse battery', h)).toBe(true);
  expect(await verifyPassword('correct horse batterz', h)).toBe(false);
  expect(await verifyPassword('x', 'garbage')).toBe(false);
  expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
});

test('password rules are plain English', () => {
  expect(checkPasswordRules('short', 'a@b.c')).toBe('Use at least 10 characters.');
  expect(checkPasswordRules('x'.repeat(201), 'a@b.c')).toBe('Use at most 200 characters.');
  expect(checkPasswordRules('alice@hf.test', 'Alice@HF.test')).toBe('Your password cannot be your email address.');
  expect(checkPasswordRules('correct horse battery', 'a@b.c')).toBeNull();
});
```

`apps/server/test/sessions.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import { makeUser } from './helpers/factories.js';
import { createSession, loadSession, revokeSessions, SESSION_IDLE_MS, SESSION_ABSOLUTE_MS } from '../src/auth/sessions.js';
import { users, sessions } from '../src/db/schema/index.js';

let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

test('the token is never stored; only its hash is', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const { token } = await createSession(t.db, u.id, {});
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const rows = await t.db.select().from(sessions).where(eq(sessions.userId, u.id));
  expect(rows[0]!.id).not.toContain(token);
  expect(rows[0]!.id).toMatch(/^[0-9a-f]{64}$/);
});

test('idle and absolute expiry', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const t0 = new Date('2026-11-01T09:00:00Z');
  const { token } = await createSession(t.db, u.id, {}, t0);
  expect(await loadSession(t.db, token, new Date(t0.getTime() + SESSION_IDLE_MS - 1000))).not.toBeNull();
  // the load above slid last_seen; 29 days of daily use is fine, day 30 is not
  let now = t0.getTime();
  for (let d = 1; d < 30; d++) { now = t0.getTime() + d * 86400e3; expect(await loadSession(t.db, token, new Date(now))).not.toBeNull(); }
  expect(await loadSession(t.db, token, new Date(t0.getTime() + SESSION_ABSOLUTE_MS + 1))).toBeNull();
  const { token: t2 } = await createSession(t.db, u.id, {}, t0);
  expect(await loadSession(t.db, t2, new Date(t0.getTime() + SESSION_IDLE_MS + 1))).toBeNull();
});

test('a disabled user has no session, even with a token issued before', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const { token } = await createSession(t.db, u.id, {});
  await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, u.id));
  expect(await loadSession(t.db, token)).toBeNull();
});

test('a role change is seen on the next load', async () => {
  const u = await makeUser(t.db, { role: 'manager' });
  const { token } = await createSession(t.db, u.id, {});
  await t.db.update(users).set({ role: 'member' }).where(eq(users.id, u.id));
  expect((await loadSession(t.db, token))!.actor.role).toBe('member');
});

test('revokeSessions can keep the current one', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const a = await createSession(t.db, u.id, {});
  const b = await createSession(t.db, u.id, {});
  const keep = (await loadSession(t.db, a.token))!.sessionId;
  expect(await revokeSessions(t.db, u.id, { exceptSessionId: keep })).toBe(1);
  expect(await loadSession(t.db, a.token)).not.toBeNull();
  expect(await loadSession(t.db, b.token)).toBeNull();
});
```

`apps/server/test/auth-routes.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeUser } from './helpers/factories.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

const BAD = "That email and password don't match an account.";

test('sign in sets a hardened cookie and /api/me answers', async () => {
  const u = await makeUser(t.db, { role: 'member', email: 'alice@hf.test' });
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: ' Alice@HF.test ', password: u.password });
  expect(r.status).toBe(200);
  const cookie = String(r.headers['set-cookie']);
  expect(cookie).toMatch(/^hf_session=[A-Za-z0-9_-]{43};/);
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Lax/);
  const me = await call(t, { cookie: cookie.split(';')[0]! }, 'GET', '/api/me');
  expect(me.json.user).toMatchObject({ id: u.id, email: 'alice@hf.test', role: 'member' });
  expect(JSON.stringify(me.json)).not.toMatch(/password|hash/i);
});

test('wrong password, unknown email, disabled and not-yet-activated all look the same', async () => {
  const d = await makeUser(t.db, { role: 'member', disabled: true });
  const n = await makeUser(t.db, { role: 'member', password: null });
  for (const body of [{ email: d.email, password: d.password }, { email: n.email, password: 'whatever-long-1' },
    { email: 'nobody@hf.test', password: 'whatever-long-1' }]) {
    const r = await call(t, null, 'POST', '/api/auth/sign-in', body);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ error: BAD });
  }
});

test('sign-in is rate limited per email and address', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  for (let i = 0; i < 10; i++) await call(t, null, 'POST', '/api/auth/sign-in', { email: u.email, password: 'wrong-wrong-1' });
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: u.email, password: u.password });
  expect(r.status).toBe(429);
  expect(r.json.error).toBe('Too many attempts. Please wait 15 minutes and try again.');
});

test('the limit is per email: another person on the same address can still sign in', async () => {
  // Runs straight after the test above, from the same inject IP (127.0.0.1).
  const other = await makeUser(t.db, { role: 'member' });
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: other.email, password: other.password });
  expect(r.status).toBe(200);
});

test('sign out ends the session', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const auth = await signInAs(t, u);
  expect((await call(t, auth, 'POST', '/api/auth/sign-out')).status).toBe(204);
  expect((await call(t, auth, 'GET', '/api/me')).status).toBe(401);
});

test('a change from another site is blocked', async () => {
  const u = await makeUser(t.db, { role: 'member' });
  const auth = await signInAs(t, u);
  const r = await t.app.inject({ method: 'POST', url: '/api/auth/sign-out', headers: { cookie: auth.cookie, origin: 'https://evil.example' } });
  expect(r.statusCode).toBe(403);
  expect(r.json().error).toBe('This request came from another website and was blocked.');
});

test('unknown input keys are refused, and validation errors are plain English', async () => {
  const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: 'a@hf.test', password: 'x', role: 'admin' });
  expect(r.status).toBe(400);
  expect(r.json.error).toBe('Some of the details are not valid.');
});

test('every route Fastify knows went through defineRoute', () => {
  const declared = new Set(t.app.hf.routes.map((r) => `${r.method} ${r.url}`));
  const stray = t.app.hf.allRoutes.filter((r) => r.method !== 'HEAD')
    .filter((r) => !declared.has(`${r.method} ${r.url}`));
  expect(stray).toEqual([]);
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run --project apps/server`
Expected: FAIL. The modules are not found.

- [ ] **Step 4: Implement the password and session modules**

- `password.ts`:
  - `scrypt` from `node:crypto` (promisified) with `N=32768, r=8, p=1, maxmem=64 MiB`, a 16-byte salt and a 64-byte key, encoded base64url.
  - `verifyPassword` parses the stored parameters and uses `timingSafeEqual`, returning false for any malformed string.
  - `checkPasswordRules` checks in this order: length < 10, length > 200, equal to the email (case-insensitive, trimmed).
- `sessions.ts`:
  - The token is `randomBytes(32).toString('base64url')`, and the session id is `sha256(token)` in hex.
  - `loadSession` joins `users` and returns null when:
    - there is no row;
    - `now > expires_at`;
    - `now - last_seen_at > SESSION_IDLE_MS`;
    - `users.disabled_at` is set;
    - `users.password_hash` is null.
  - In every one of those cases the row is deleted.
  - It writes `last_seen_at = now` only when the stored value is more than 5 minutes old, to avoid a write per request.

- [ ] **Step 5: Implement `errors.ts`, `csrf.ts`, `route.ts` and `app.ts`**

- `errors.ts`: `HttpError(status, userMessage, issues?)`. The default user messages are:
  - 401 `Please sign in.`
  - 403 `You don't have permission to do that.`
  - 404 `We couldn't find that.`
  - 413 `That file is too large.`
- `csrf.ts`: an `onRequest` hook. For `POST`, `PATCH`, `PUT` and `DELETE`, the `origin` header must equal `config.appOrigin`. Otherwise it throws `HttpError(403, 'This request came from another website and was blocked.')`.
- `route.ts`, `defineRoute(app, spec)`:
  1. Registers the route through `app.withTypeProvider<ZodTypeProvider>().route(...)`, with `schema` passed through.
  2. Pushes `{ method, url, access }` onto `app.hf.routes`.
  3. Adds a `preHandler`:
     - for `{ permission }` routes: `if (!req.actor) throw unauthorized(); if (!can(req.actor.role, p)) throw forbidden();`
     - `{ public }` routes skip both checks.
  4. Calls `spec.handler(req, reply, { actor: req.actor, db })`. A non-undefined return value is sent as JSON; `undefined` sends 204.
- `app.ts`, `buildApp`:
  - `Fastify({ logger, trustProxy: true })`, with the logger off in `test` mode and otherwise redacting `req.headers.cookie`, `req.headers.authorization` and `req.headers["x-health-token"]`.
  - Decorates `app.hf = { routes: [], allRoutes: [] }` and adds an `onRoute` hook that pushes into `allRoutes`.
  - Sets the Zod validator and serializer compilers.
  - Registers `@fastify/cookie`, then `@fastify/helmet` with CSP `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'`, then `@fastify/rate-limit` with `global: false`.
  - Adds an `onRequest` hook that sets `req.actor` and `req.sessionId` from the `hf_session` cookie via `loadSession`.
  - Adds the CSRF hook.
  - The error handler maps:
    - `HttpError` → `{ error: userMessage, issues? }`;
    - Fastify validation errors → 400 `{ error: 'Some of the details are not valid.', issues: [{ path, message }] }`;
    - rate-limit errors → 429 `{ error: 'Too many attempts. Please wait 15 minutes and try again.' }`;
    - anything else → logged, then 500 `{ error: 'Something went wrong on our side. It has been logged.' }`.
  - Registers the route modules (later tasks append to a single `registerRoutes(app, deps)` list).
- `auth/routes.ts`:
  - The sign-in body is `z.strictObject({ email: z.string().trim().toLowerCase().max(320), password: z.string().max(200) })`.
  - Per-route rate limit: `config: { rateLimit: { max: 10, timeWindow: '15 minutes', hook: 'preHandler', keyGenerator: (req) => req.ip + '|' + String(req.body?.email ?? '').trim().toLowerCase() } }`.
    - `hook: 'preHandler'` is essential. `@fastify/rate-limit` runs on `onRequest` by default, **before the body is parsed**, so `req.body` would be undefined and the key would collapse to the IP alone: every sign-in from one office (or from one test process) would share a single counter, and a request with bad input would get 429 instead of 400. On `preHandler` the body is parsed and validated, so the key really is address + email, and invalid input is refused with 400 before it counts.
    - `defineRoute` passes `spec.config` through to Fastify's route options, so add an optional `config?: Record<string, unknown>` to the `defineRoute` spec for this.
  - Missing users verify against a module-level `DUMMY_HASH` computed once, so timing does not reveal whether the account exists.
  - The cookie is `hf_session`: `httpOnly`, `sameSite: 'lax'`, `secure: config.cookieSecure`, `path: '/'`, `maxAge: SESSION_ABSOLUTE_MS / 1000`.
  - Sign-out deletes the session row and clears the cookie.

- [ ] **Step 6: Implement the test helpers**

- `createTestApp(overrides)`:
  - `createTestDb()`;
  - a temporary `uploadDir`;
  - config `{ instanceMode: 'test', appOrigin: 'http://hf.test', email: { transport: 'memory', from: 'Test <t@hf.test>' }, … }`;
  - a `memoryTransport()` stand-in until Task 6 provides the real one; for now, a local stub `{ sent: [], send(m) { this.sent.push(m) } }`;
  - `buildApp`.
- `call()` uses `app.inject` with `origin: 'http://hf.test'` and the cookie, and parses JSON when the content type is JSON.
- `signInAs()` calls `createSession` directly and returns `hf_session=<token>`.

- [ ] **Step 7: Generate the migration and verify**

Run: `npm -w @hf/server run db:generate -- --name identity && npm run verify`
Expected: one new migration in `apps/server/drizzle/`. All tests PASS (15 new).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: users, hashed sessions, sign-in with rate limit, defineRoute and error model

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
