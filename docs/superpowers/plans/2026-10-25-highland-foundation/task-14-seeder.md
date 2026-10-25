# Task 14: Demo-data seeder

Spec §4.2 says the operator can bring up a preview "with demo data at any point, to look at it and show the client". Spec §7 says "client data never goes to the factory's models". So previews, screenshots and browser tests all run on realistic but **invented** data.

The seeder is a registry, so each client feature adds its own seeder next to its code. It is guarded three times so demo data and a live app never meet:
1. it refuses to run when `INSTANCE_MODE=production`;
2. a database that has ever started in production mode remembers that, and refuses to start in demo mode at all;
3. a database that has ever been seeded with demo data can never be promoted to production. Otherwise a preview could go live still holding `admin@demo.test` and the other accounts on the published default password `demo-password-1` (it is in this repo and the runbook): an access-control hole on the very line spec §2.1 calls a disaster (index Ruling 11).

**Files:**
- Create: `apps/server/src/db/schema/instance.ts`, `apps/server/src/instance.ts`
- Create: `apps/server/src/seed/{registry,demo,cli,image}.ts`, `apps/server/src/seed/seeders/{people,notes}.ts`
- Modify: `apps/server/src/main.ts` (call `ensureInstance` before listening), `apps/server/package.json` (`"seed:demo": "node dist/seed/cli.js"`, `"seed:demo:dev": "tsx src/seed/cli.ts"`)
- Test: `apps/server/test/instance.test.ts`, `apps/server/test/seed.test.ts`

**Interfaces:**
- Consumes: `Db`, `hashPassword` (Task 3), `LocalDiskStorage` (Task 9), `audit` (Task 5), the notes and files tables (Tasks 9–10).
- Produces:
  - `ensureInstance(db, mode: InstanceMode): Promise<void>`:
    - inserts the single `instance_settings` row on the first boot;
    - if the stored mode is `production` and `mode` is not, it throws `InstanceModeError('This database belongs to a live app (production). Start it with INSTANCE_MODE=production.')`;
    - a `demo` or `test` database that has **never been seeded** (`seeded_at` is null) may be promoted to `production` once, and the change is audited;
    - if `seeded_at` is set and `mode` is `production`, it throws `InstanceModeError('This database holds demo data. Start the live app on a fresh database.')`. There is no override flag.
  - `registerSeeder({ name, order, run })` and `seedDemo(db, cfg, opts?: { reset?: boolean; now?: Date }): Promise<SeedSummary>`.
  - `SeedCtx = { tx: Tx; storage: Storage; faker: Faker; now: Date; password: string; created: Record<string, string[]> }`. `created` maps names like `'user:manager'` to ids, so later seeders can find earlier rows.
  - `SeedSummary = { alreadySeeded: boolean; counts: Record<string, number>; signIns: { email: string; role: Role; team: string | null }[]; password: string; text: string }`.
  - `DEMO_PASSWORD` comes from env `DEMO_PASSWORD` (default `demo-password-1`).
  - The CLI prints `summary.text` and exits 0. `--reset` wipes and re-seeds, and is allowed only in `demo` mode.

Table `instance_settings`: `id int primary key default 1 check (id = 1)`, `mode text not null`, `seeded_at timestamptz`, `created_at`, `updated_at`.

**Demo data (deterministic: `fakerEN_GB`, `faker.seed(42)`, all emails at `demo.test`, a reserved name that can never deliver mail):**
- Teams: `Operations` and `Sales`.
- People:
  - `admin@demo.test` (admin, "Morgan Admin");
  - one manager per team: `ops.manager@demo.test`, `sales.manager@demo.test`;
  - three members per team, with faker names and `firstname.lastname@demo.test`;
  - one invited-but-not-activated member in Sales, with no password.
- Notes: 4 per activated non-admin person, dated across the 60 days before `now`. Every second note carries a generated receipt-style PNG.
- `text` reads:

```
Demo data added: 2 teams, 10 people, 32 notes, 16 attached photos.
Sign in with any of these (password: demo-password-1):
  admin@demo.test (admin)
  ops.manager@demo.test (manager, Operations)
  ...
```

When the database is already seeded, the text is `Demo data is already in place. Use --reset to start again.`

- [ ] **Step 1: Install**

```bash
npm -w @hf/server i @faker-js/faker@10.6.0
```

- [ ] **Step 2: Write the failing tests**

`apps/server/test/instance.test.ts`:

```ts
import { test, expect } from 'vitest';
import { createTestDb } from './helpers/testDb.js';
import { ensureInstance } from '../src/instance.js';

test('a production database can never be started in demo mode again', async () => {
  const t = await createTestDb();
  await ensureInstance(t.db, 'demo');
  await ensureInstance(t.db, 'production');           // promotion is allowed once
  await expect(ensureInstance(t.db, 'demo')).rejects.toThrow('This database belongs to a live app (production). Start it with INSTANCE_MODE=production.');
  await ensureInstance(t.db, 'production');
  await t.close();
});

test('a database that ever held demo data can never go live', async () => {
  const t = await createTestDb();
  await ensureInstance(t.db, 'demo');
  await t.db.execute(sql`update instance_settings set seeded_at = now()`);
  await expect(ensureInstance(t.db, 'production')).rejects.toThrow('This database holds demo data. Start the live app on a fresh database.');
  const mode = (await t.db.execute(sql`select mode from instance_settings`)).rows[0]!.mode;
  expect(mode).toBe('demo');   // the refusal changed nothing
  await t.close();
});
```

(Add `import { sql } from 'drizzle-orm';` to the top of `instance.test.ts`.)

`apps/server/test/seed.test.ts`:

```ts
import { test, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestApp, call } from './helpers/testApp.js';
import { seedDemo } from '../src/seed/demo.js';

const NOW = new Date('2026-11-01T12:00:00Z');

test('seeding fills a preview with invented data, once', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  const s = await seedDemo(t.db, t.config, { now: NOW });
  expect(s.counts).toEqual({ teams: 2, people: 10, notes: 32, files: 16 });
  expect(s.text.split('\n')[0]).toBe('Demo data added: 2 teams, 10 people, 32 notes, 16 attached photos.');
  const emails = (await t.db.execute(sql`select email from users`)).rows.map((r) => String(r.email));
  expect(emails.every((e) => e.endsWith('@demo.test'))).toBe(true);
  const again = await seedDemo(t.db, t.config, { now: NOW });
  expect(again.alreadySeeded).toBe(true);
  expect(again.text).toBe('Demo data is already in place. Use --reset to start again.');
  await t.close();
});

test('the same seed gives the same people', async () => {
  const a = await createTestApp({ instanceMode: 'demo' }), b = await createTestApp({ instanceMode: 'demo' });
  const sa = await seedDemo(a.db, a.config, { now: NOW }), sb = await seedDemo(b.db, b.config, { now: NOW });
  expect(sa.signIns).toEqual(sb.signIns);
  await a.close(); await b.close();
});

test('every listed person can sign in with the demo password; the invited one is not listed', async () => {
  const t = await createTestApp({ instanceMode: 'demo' });
  const s = await seedDemo(t.db, t.config, { now: NOW });
  expect(s.signIns).toHaveLength(9);
  for (const p of s.signIns) {
    const r = await call(t, null, 'POST', '/api/auth/sign-in', { email: p.email, password: s.password });
    expect(r.status, p.email).toBe(200);
  }
  await t.close();
});

test('production refuses, and reset is demo-only', async () => {
  const t = await createTestApp({ instanceMode: 'production' });
  await expect(seedDemo(t.db, t.config)).rejects.toThrow('Demo data can only be added to a demo or test app, never a live one.');
  await t.close();
});
```

(Each `createTestApp` gets a fresh database, so the rate limit is not shared and 9 sign-ins are fine. `createTestApp` must accept `instanceMode` overrides; production mode with the memory transport is allowed **only** inside `createTestApp`, which builds `Config` directly rather than through `loadConfig`.)

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run --project apps/server test/instance.test.ts test/seed.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement**

- `seedDemo`:
  - checks `cfg.instanceMode` and the stored mode, then calls `ensureInstance`;
  - with `reset`, wipes every table in one transaction, using the same `SET LOCAL hf.audit_purge = 'on'` and `TRUNCATE … CASCADE` approach as `world.reset()` (Task 8). Move that helper to `apps/server/src/db/wipe.ts` as `wipeAllData(db)` and use it from both places. It truncates every public table **except `instance_settings`**, which is the database's memory of its mode and of having held demo data; a wipe must never let a demo database forget either. It refuses unless the mode is `demo` or `test`.
  - runs the seeders sorted by `order` in **one** transaction, hashes the password once, sets `seeded_at`, and audits `seed.demo` with the counts.
- `image.ts`: `receiptPng(lines: string[]): Buffer`. It draws a 360×560 off-white PNG with dark horizontal bars standing in for text lines, using raw RGBA rows and `zlib.deflateSync` plus a CRC32 table. No image library is needed. Files are written through `LocalDiskStorage(cfg.uploadDir)`.
- `seeders/people.ts` (order 10) and `seeders/notes.ts` (order 50) register themselves on import. `demo.ts` imports `./seeders/index.js`, which imports both. A client feature adds its own file and an import line.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: all tests PASS (6 new).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: deterministic demo-data seeder with production guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
