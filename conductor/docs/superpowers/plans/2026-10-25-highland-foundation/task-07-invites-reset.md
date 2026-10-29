# Task 7: Invitations, password reset & first admin

This task completes "accounts and sign-in, with password reset" (spec §5) under Ruling 1 (no public sign-up).

- People join by an admin's invite.
- They recover access by an emailed link that works once, for one hour.
- Only the newest link of each kind works.
- The very first admin is created from the command line, which prints a set-password link, so a fresh box needs no working mail to get started.

Review Focus 5 is pinned here.

**Files:**
- Create: `apps/server/src/db/schema/tokens.ts`, `apps/server/src/auth/{tokens,invites,reset,bootstrap-admin}.ts`
- Modify: `apps/server/src/auth/routes.ts`, `apps/server/src/users/routes.ts`, `packages/shared/src/schemas.ts`
- Test: `apps/server/test/invites.test.ts`, `apps/server/test/reset.test.ts`

**Interfaces:**
- Consumes:
  - `queueEmail` and `memoryTransport` (Task 6);
  - `audit` (Task 5);
  - `createSession`, `revokeSessions`, `hashPassword`, `checkPasswordRules` (Task 3);
  - `defineRoute` (Tasks 3–4).
- Produces:
  - `createInvite`, `acceptInvite`, `requestPasswordReset`, `resetPassword`, `TOKEN_TTL` (index).
  - `issueToken(tx, userId, kind: 'invite' | 'reset', now?): Promise<string>`: deletes the user's earlier unused tokens of that kind.
  - `consumeToken(tx, token, kind, now?): Promise<{ userId: string } | null>`: marks the token used and returns null if it is unknown, used or expired.
  - `bootstrapAdmin(db, cfg, { email, name }): Promise<{ link: string }>`, and the CLI `node apps/server/dist/auth/bootstrap-admin.js --email <e> --name <n>`.
  - `@hf/shared` `InviteInput = z.strictObject({ email: z.email().trim().toLowerCase(), name: z.string().trim().min(1).max(100), role: z.enum(ROLES), teamId: z.uuid().nullable() })`.
  - Links put the token in the URL fragment, so it never reaches server or proxy logs:
    - `${appOrigin}/accept-invite#<token>`
    - `${appOrigin}/reset-password#<token>`
  - Routes:
    - `POST /api/users/invite` [`users:manage`] → 201 `{ user: UserView }`; an existing email → 409 `Someone with that email already has an account.`; the team rule from Task 4 applies.
    - `POST /api/users/:id/resend-invite` [`users:manage`] → 204; already activated → 409 `This person has already set their password.`; outside visibility → 404.
    - `POST /api/auth/accept-invite` (public: "accepting an invite"), body `{ token, password }` → 200 `{ user }` plus the session cookie.
    - `POST /api/auth/forgot-password` (public: "asking for a reset link"), body `{ email }` → always 202 `{ message: "If that email has an account, we've sent a link to reset the password." }`; rate limit 5 per hour per address+email, configured exactly like sign-in in Task 3: `config: { rateLimit: { max: 5, timeWindow: '1 hour', hook: 'preHandler', keyGenerator: (req) => req.ip + '|' + String(req.body?.email ?? '').trim().toLowerCase() } }`. Without `hook: 'preHandler'` the body is not parsed yet and the limit would apply to the whole address.
    - `POST /api/auth/reset-password` (public: "using a reset link"), body `{ token, password }` → 204.
    - `POST /api/me/password` [`self:manage`], body `{ currentPassword, newPassword }` → 204; a wrong current password → 400 `Your current password is not right.`
  - Messages:
    - invalid invite → 400 `This invite link has expired or has already been used. Ask your administrator to send a new one.`
    - invalid reset → 400 `This reset link has expired or has already been used. Ask for a new one.`
    - a weak password → 400 with the `checkPasswordRules` text as `error`.

Table `user_tokens`:
- `id text pk /* sha256 hex */`, `user_id uuid not null references users(id) on delete cascade`;
- `kind text not null check (kind in ('invite','reset'))`;
- `expires_at timestamptz not null`, `used_at timestamptz`, `created_at`.

Effects:
- accepting an invite → `auth` audit `user.invite_accepted`;
- a reset → revoke **all** of that user's sessions, queue `password-changed`, audit `auth.password_reset`;
- a change through `/api/me/password` → revoke the other sessions, queue `password-changed`, audit `auth.password_changed`;
- a reset request → audit `auth.password_reset_requested` with `details: { email }` whether or not the account exists. The audit is internal and gives no enumeration to the requester.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/reset.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { processOutbox } from '../src/email/index.js';
import { requestPasswordReset, resetPassword, TOKEN_TTL } from '../src/auth/reset.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
const site = { appName: 'Highland App', appOrigin: 'http://hf.test' };
const SAME = { message: "If that email has an account, we've sent a link to reset the password." };
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

async function lastLink() {
  await processOutbox(t.db, t.mail, site);
  const m = t.mail.sent.at(-1)!;
  return /http:\/\/hf\.test\/reset-password#([A-Za-z0-9_-]{43})/.exec(m.text)![1]!;
}

test('known and unknown emails get the same answer; only real accounts get mail', async () => {
  const N = await makeTeam(t.db, 'North');
  const u = await makeUser(t.db, { role: 'member', teamId: N.id, email: 'bob@hf.test' });
  const before = t.mail.sent.length;
  const a = await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'bob@hf.test' });
  const b = await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'ghost@hf.test' });
  expect([a.status, b.status]).toEqual([202, 202]);
  expect(a.json).toEqual(SAME); expect(b.json).toEqual(SAME);
  await processOutbox(t.db, t.mail, site);
  expect(t.mail.sent.slice(before).map((m) => m.to)).toEqual(['bob@hf.test']);
  void u;
});

test('only the newest link works, once, and a reset signs out every session', async () => {
  const u = await makeUser(t.db, { role: 'admin', email: 'cara@hf.test' });
  const session = await signInAs(t, u);
  await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'cara@hf.test' });
  const first = await lastLink();
  await call(t, null, 'POST', '/api/auth/forgot-password', { email: 'cara@hf.test' });
  const second = await lastLink();
  const stale = await call(t, null, 'POST', '/api/auth/reset-password', { token: first, password: 'brand new password' });
  expect(stale.status).toBe(400);
  expect(stale.json.error).toBe('This reset link has expired or has already been used. Ask for a new one.');
  expect((await call(t, null, 'POST', '/api/auth/reset-password', { token: second, password: 'brand new password' })).status).toBe(204);
  expect((await call(t, null, 'POST', '/api/auth/reset-password', { token: second, password: 'another new password' })).status).toBe(400);
  expect((await call(t, session, 'GET', '/api/me')).status).toBe(401);
  expect((await call(t, null, 'POST', '/api/auth/sign-in', { email: 'cara@hf.test', password: 'brand new password' })).status).toBe(200);
  await processOutbox(t.db, t.mail, site);
  expect(t.mail.sent.at(-1)!.subject).toBe('Your Highland App password was changed');
});

test('a reset link expires after one hour', async () => {
  const u = await makeUser(t.db, { role: 'admin', email: 'dee@hf.test' });
  const t0 = new Date('2026-11-01T10:00:00Z');
  await requestPasswordReset(t.db, 'dee@hf.test', { now: t0, appOrigin: 'http://hf.test' });
  const token = await lastLink();
  await expect(resetPassword(t.db, token, 'brand new password', { now: new Date(t0.getTime() + TOKEN_TTL.reset + 1) }))
    .rejects.toMatchObject({ status: 400 });
  void u;
});

test('changing your password keeps this session and ends the others', async () => {
  const u = await makeUser(t.db, { role: 'admin' });
  const here = await signInAs(t, u), there = await signInAs(t, u);
  expect((await call(t, here, 'POST', '/api/me/password', { currentPassword: 'nope-nope-nope', newPassword: 'brand new password' })).json.error)
    .toBe('Your current password is not right.');
  expect((await call(t, here, 'POST', '/api/me/password', { currentPassword: u.password, newPassword: 'short' })).json.error)
    .toBe('Use at least 10 characters.');
  expect((await call(t, here, 'POST', '/api/me/password', { currentPassword: u.password, newPassword: 'brand new password' })).status).toBe(204);
  expect((await call(t, here, 'GET', '/api/me')).status).toBe(200);
  expect((await call(t, there, 'GET', '/api/me')).status).toBe(401);
});
```

`apps/server/test/invites.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { processOutbox } from '../src/email/index.js';
import { bootstrapAdmin } from '../src/auth/bootstrap-admin.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
const site = { appName: 'Highland App', appOrigin: 'http://hf.test' };
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => { await t.close(); });

test('the first admin comes from the command line, and only once', async () => {
  const { link } = await bootstrapAdmin(t.db, t.config, { email: 'Owner@HF.test', name: 'Owner' });
  expect(link).toMatch(/^http:\/\/hf\.test\/accept-invite#[A-Za-z0-9_-]{43}$/);
  await expect(bootstrapAdmin(t.db, t.config, { email: 'b@hf.test', name: 'B' }))
    .rejects.toThrow('An admin already exists. Use the app to invite more people.');
  const r = await call(t, null, 'POST', '/api/auth/accept-invite', { token: link.split('#')[1], password: 'owner password 1' });
  expect(r.status).toBe(200);
  expect(r.json.user).toMatchObject({ email: 'owner@hf.test', role: 'admin' });
  expect(String(r.headers['set-cookie'])).toMatch(/^hf_session=/);
});

test('invite → mail → accept → signed in; the link works once', async () => {
  const admin = await makeUser(t.db, { role: 'admin', name: 'Ada' });
  const N = await makeTeam(t.db, 'North');
  const r = await call(t, await signInAs(t, admin), 'POST', '/api/users/invite', { email: 'new@hf.test', name: 'Newt', role: 'member', teamId: N.id });
  expect(r.status).toBe(201);
  expect(r.json.user).toMatchObject({ activated: false, disabled: false });
  await processOutbox(t.db, t.mail, site);
  const m = t.mail.sent.at(-1)!;
  expect(m.subject).toBe('Ada invited you to Highland App');
  const token = /accept-invite#([A-Za-z0-9_-]{43})/.exec(m.text)![1];
  expect((await call(t, null, 'POST', '/api/auth/accept-invite', { token, password: 'newt password 1' })).status).toBe(200);
  const again = await call(t, null, 'POST', '/api/auth/accept-invite', { token, password: 'newt password 2' });
  expect(again.json.error).toBe('This invite link has expired or has already been used. Ask your administrator to send a new one.');
});

test('a member cannot invite; a duplicate email is explained; an un-activated user cannot sign in', async () => {
  const N = await makeTeam(t.db, 'South');
  const m = await makeUser(t.db, { role: 'member', teamId: N.id });
  expect((await call(t, await signInAs(t, m), 'POST', '/api/users/invite', { email: 'x@hf.test', name: 'X', role: 'admin', teamId: null })).status).toBe(403);
  const admin = await makeUser(t.db, { role: 'admin' });
  const dup = await call(t, await signInAs(t, admin), 'POST', '/api/users/invite', { email: m.email, name: 'X', role: 'member', teamId: N.id });
  expect(dup.json.error).toBe('Someone with that email already has an account.');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project apps/server test/invites.test.ts test/reset.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `tokens.ts`, `invites.ts`, `reset.ts` and `bootstrap-admin.ts`**

- Tokens use the same 32-byte base64url and SHA-256 scheme as sessions.
- `consumeToken` is a single `UPDATE user_tokens SET used_at = now WHERE id = $1 AND kind = $2 AND used_at IS NULL AND expires_at > now RETURNING user_id`. Because it is one atomic statement, a double-click cannot use the link twice.
- `requestPasswordReset(db, email, { now?, appOrigin, ip? })` mails only users who are active and activated.
- `resetPassword(db, token, password, { now? })` throws `HttpError(400, …)`. It checks the password rules **before** consuming the token, so a weak password does not burn the link.
- `bootstrapAdmin` runs in a transaction and takes `pg_advisory_xact_lock(4242)`, so two runs at once cannot both create an admin.
- The CLI parses `--email` and `--name` with `node:util` `parseArgs`. It prints `Open this link within 7 days to set the admin password:\n<link>`; on error it prints the error message and exits 1.

- [ ] **Step 4: Add the routes**

Add them as listed in Interfaces, each in one transaction together with its `audit` and `queueEmail` calls.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: all tests PASS (7 new).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: invites, single-use password reset, password change, first-admin CLI

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
