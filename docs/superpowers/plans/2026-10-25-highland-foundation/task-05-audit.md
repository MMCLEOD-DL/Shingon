# Task 5: Audit log

Spec §5 lists an audit log in the foundation. It answers "who did what, when" for the operator and the client's admin.

The log is append-only at the database level: a trigger refuses `UPDATE`, `DELETE` and `TRUNCATE`. A bug in the app, or an ordinary misuse of its API, cannot quietly rewrite history. The single exception is a deliberate retention purge, which needs a session flag that only the ops tool sets (Task 18). Audit rows are written in the same transaction as the change they describe.

What this does **not** stop: the app connects as the database role that owns the tables (the `POSTGRES_USER` in Task 17, a superuser), so code running with that connection could drop the trigger, set `hf.audit_purge` itself (custom settings can be set by any role) or call `audit_purge_before()`. Defending against a fully compromised app process needs a separate, non-owner `app_rw` role with only `SELECT, INSERT` on `audit_log` and no `EXECUTE` on the purge function. That is recorded in index Ruling 9 as later defence in depth; do not claim more than "a bug cannot" in the docs.

**Files:**
- Create: `apps/server/src/db/schema/audit.ts`, the custom migration `apps/server/drizzle/<n>_audit_append_only.sql`
- Create: `apps/server/src/audit/{audit,routes}.ts`
- Modify: `apps/server/src/auth/routes.ts` (sign-in, failed sign-in, sign-out), `apps/server/src/users/routes.ts` (role, team, disable and enable changes; team created; name changed), `apps/server/src/app.ts`
- Test: `apps/server/test/audit.test.ts`

**Interfaces:**
- Consumes: `defineRoute`, `Db`/`Tx`, `Actor` (Tasks 2–4).
- Produces:
  - `audit()`, `AUDIT_ACTIONS` and `redactDetails()` (index).
  - `AUDIT_ACTIONS = ['auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.password_changed', 'auth.password_reset_requested', 'auth.password_reset', 'user.invited', 'user.invite_accepted', 'user.updated', 'user.disabled', 'user.enabled', 'team.created', 'file.uploaded', 'file.downloaded', 'file.deleted', 'note.created', 'note.updated', 'note.deleted', 'seed.demo'] as const`. A client app appends its own actions.
  - `GET /api/audit` [`audit:read`]:
    - query `z.strictObject({ action: z.enum(AUDIT_ACTIONS).optional(), actorId: z.uuid().optional(), before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) })`;
    - returns `{ entries: AuditView[], nextBefore: number | null }`, newest first, with keyset pagination on `id`.
  - `AuditView = { id: number; at: string; actorLabel: string; action: string; targetType: string | null; targetId: string | null; details: Record<string, unknown>; ip: string | null }`.
  - SQL function `audit_purge_before(cutoff timestamptz) returns bigint` (used by Task 18).

Table `audit_log`:
- `id bigserial pk`, `at timestamptz not null default now()`;
- `actor_id uuid null references users(id) on delete no action`. **Users are disabled, never deleted** (index Ruling 12). `on delete set null` would turn a user delete into an `UPDATE` of `audit_log`, which the trigger refuses anyway; `no action` makes the rule explicit, and the test below pins it. Erasing a leaver's personal data under the data policy's retention field (spec §6) is a later module: it replaces the name and email on the user row and goes through the purge path for old audit rows;
- `actor_label text not null`: the email at the time of the action, or `'system'` / `'anonymous'`;
- `action text not null`, `target_type text`, `target_id text`, `details jsonb not null default '{}'`, `ip text`;
- indexes on `(at desc)`, `actor_id` and `action`.

Custom migration body:

```sql
CREATE OR REPLACE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('hf.audit_purge', true) = 'on' AND TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();
CREATE OR REPLACE FUNCTION audit_purge_before(cutoff timestamptz) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
  PERFORM set_config('hf.audit_purge', 'on', true);
  DELETE FROM audit_log WHERE at < cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  PERFORM set_config('hf.audit_purge', 'off', true);
  RETURN n;
END $$;
```

(The crossing harness's `world.reset()` (Task 8) wipes every table, including tables that cascade into `audit_log`, inside a transaction that first runs `SET LOCAL hf.audit_purge = 'on'`. That is why the guard also honours the flag for TRUNCATE. Nothing in the app ever sets this flag.)

- [ ] **Step 1: Write the failing tests**

`apps/server/test/audit.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestApp, call, signInAs } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { audit, redactDetails } from '../src/audit/audit.js';

let t: Awaited<ReturnType<typeof createTestApp>>;
let admin: any, alice: any;
beforeAll(async () => {
  t = await createTestApp();
  const N = await makeTeam(t.db, 'North');
  admin = await makeUser(t.db, { role: 'admin', email: 'ada@hf.test' });
  alice = await makeUser(t.db, { role: 'member', teamId: N.id, email: 'alice@hf.test' });
});
afterAll(async () => { await t.close(); });

test('sign-in, failed sign-in and admin changes are audited with who and what', async () => {
  await call(t, null, 'POST', '/api/auth/sign-in', { email: 'alice@hf.test', password: 'wrong-wrong-wrong' });
  await call(t, null, 'POST', '/api/auth/sign-in', { email: 'alice@hf.test', password: alice.password });
  const adminAuth = await signInAs(t, admin);
  await call(t, adminAuth, 'PATCH', `/api/users/${alice.id}`, { disabled: true });
  const r = await call(t, adminAuth, 'GET', '/api/audit?limit=10');
  const rows = r.json.entries.map((e: any) => [e.action, e.actorLabel, e.targetId]);
  expect(rows.slice(0, 3)).toEqual([
    ['user.disabled', 'ada@hf.test', alice.id],
    ['auth.sign_in', 'alice@hf.test', alice.id],
    ['auth.sign_in_failed', 'anonymous', null],
  ]);
  expect(r.json.entries[2].details).toEqual({ email: 'alice@hf.test' });
});

test('users are disabled, never deleted: a user with audit history cannot be removed', async () => {
  // admin has audit rows from the test above (user.disabled)
  await expect(t.db.execute(sql`delete from users where id = ${admin.id}`)).rejects.toThrow(/violates foreign key constraint/);
});

test('secrets never reach the audit details', () => {
  expect(redactDetails({ password: 'x', newPassword: 'y', token: 't', apiKey: 'k', clientSecret: 's', name: 'ok' }))
    .toEqual({ password: '[redacted]', newPassword: '[redacted]', token: '[redacted]', apiKey: '[redacted]', clientSecret: '[redacted]', name: 'ok' });
});

test('the log cannot be edited or deleted, only purged deliberately', async () => {
  await audit(t.db, { actor: null }, { action: 'seed.demo' });
  await expect(t.db.execute(sql`update audit_log set action = 'x'`)).rejects.toThrow(/append-only/);
  await expect(t.db.execute(sql`delete from audit_log`)).rejects.toThrow(/append-only/);
  await expect(t.db.execute(sql`truncate audit_log`)).rejects.toThrow(/append-only/);
  const purged = await t.db.execute(sql`select audit_purge_before('infinity') as n`);
  expect(Number(purged.rows[0]!.n)).toBeGreaterThan(0);
  await audit(t.db, { actor: null }, { action: 'seed.demo' });
  await expect(t.db.execute(sql`delete from audit_log`)).rejects.toThrow(/append-only/); // the purge flag did not leak
});

test('an audit row is rolled back with the change it describes', async () => {
  const before = (await t.db.execute(sql`select count(*)::int n from audit_log`)).rows[0]!.n;
  await expect(t.db.transaction(async (tx) => {
    await audit(tx, { actor: null }, { action: 'team.created', targetId: 'x' });
    throw new Error('boom');
  })).rejects.toThrow('boom');
  expect((await t.db.execute(sql`select count(*)::int n from audit_log`)).rows[0]!.n).toBe(before);
});

test('only admins can read the audit log; paging works', async () => {
  expect((await call(t, await signInAs(t, alice), 'GET', '/api/audit')).status).toBe(401); // alice was disabled above
  const p1 = await call(t, await signInAs(t, admin), 'GET', '/api/audit?limit=1');
  expect(p1.json.entries).toHaveLength(1);
  expect(typeof p1.json.nextBefore).toBe('number');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project apps/server test/audit.test.ts`
Expected: FAIL. The audit module is missing.

- [ ] **Step 3: Implement**

- `audit.ts`:
  - `audit(db, ctx, e)` inserts one row.
  - `actorLabel` is `ctx.actor?.email ?? (e.action.startsWith('auth.') ? 'anonymous' : 'system')`.
  - `details` go through `redactDetails`, which recurses one level into plain objects and matches keys against `/pass|token|secret|key/i`.
- Add audit calls to the existing routes in the same transaction as the change. For sign-in:
  - success → `auth.sign_in`, target user;
  - failure → `auth.sign_in_failed`, `details: { email }`, never the password.
- In users routes:
  - `disabled` toggles → `user.disabled` / `user.enabled`;
  - other field changes → `user.updated` with `details: { changed: { role: [from, to], … } }`;
  - `POST /api/teams` → `team.created`;
  - `PATCH /api/me` → `user.updated`.
- `routes.ts`: `GET /api/audit`, as specified.
- Generate the table migration (`db:generate -- --name audit`), then the custom one (`db:custom -- --name audit_append_only`) with the SQL above.

- [ ] **Step 4: Verify**

Run: `npm run verify`
Expected: all tests PASS (6 new).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: append-only audit log written in the same transaction, admin read API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
