# Task 2: Config, database & test DBs

The server reads all its settings from environment variables, validated once at start-up. A missing or bad setting stops start-up with a plain-English list of every problem, never a stack trace. The database layer gives each later task a Drizzle `Db`, committed SQL migrations, and a helper that creates a fresh migrated database per test file.

**Files:**
- Create: `apps/server/src/config.ts`, `apps/server/src/db/{client.ts,migrate.ts,migrate-cli.ts}`, `apps/server/src/db/schema/index.ts`, `apps/server/drizzle.config.ts`, `apps/server/vitest.config.ts`
- Create: `apps/server/test/helpers/testDb.ts`
- Test: `apps/server/test/config.test.ts`, `apps/server/test/db.test.ts`

**Interfaces:**
- Consumes: the workspace layout (Task 1).
- Produces:
  - `loadConfig`, `Config`, `ConfigError`, `createDb`, `runMigrations`, `Db`, `Tx` and `createTestDb`, exactly as in the index's Shared Interfaces.
  - `apps/server/src/db/schema/index.ts` re-exports every table module. Later tasks add `export * from './<table>.js'` lines here.
  - Migrations live in `apps/server/drizzle/`. New ones are created with `npm -w @hf/server run db:generate` (`drizzle-kit generate`), or with `npm -w @hf/server run db:custom -- --name <name>` for hand-written SQL (`drizzle-kit generate --custom`).
  - `node apps/server/dist/db/migrate-cli.js` migrates `DATABASE_URL` and exits 0. On failure it prints `The database update failed: <message>` and exits 1.

Environment variables (defaults in brackets):

| Var | Rule |
|---|---|
| `INSTANCE_MODE` | `demo` \| `production` \| `test` [`demo`] |
| `APP_NAME` | non-empty [`Highland App`] |
| `APP_ORIGIN` | absolute `http(s)://` URL with no path; required |
| `PORT` | 1–65535 [`3000`] |
| `DATABASE_URL` | `postgres://…`; required |
| `COOKIE_SECURE` | `true`/`false`; [`true` unless `APP_ORIGIN` starts with `http://`] |
| `UPLOAD_DIR` | absolute path; required |
| `UPLOAD_MAX_BYTES` | integer [`15728640`] |
| `EMAIL_TRANSPORT` | `smtp` \| `file` \| `memory` [`smtp`]. `file` and `memory` are refused when `INSTANCE_MODE=production` |
| `SMTP_URL` | required when transport is `smtp` |
| `EMAIL_FILE_DIR` | required when transport is `file` |
| `EMAIL_FROM` | `Name <addr>` or `addr`; required |
| `HEALTH_TOKEN` | optional; ≥ 24 chars when set |
| `APP_VERSION` / `GIT_COMMIT` | [`0.0.0-dev`] / [`unknown`] |
| `WEB_DIST_DIR` | optional; when set, the server serves the SPA from it |

- [ ] **Step 1: Install**

```bash
cd /root/highland-foundation
npm -w @hf/server i fastify@5.12.7 zod@4.6.7 drizzle-orm@0.45.4 pg@8.23.1
npm -w @hf/server i -D drizzle-kit@0.31.11 @types/pg@8.23.1
```

Add these server scripts:
- `"db:generate": "drizzle-kit generate"`
- `"db:custom": "drizzle-kit generate --custom"`
- `"build": "tsc -b"`

`drizzle.config.ts`: `{ dialect: 'postgresql', schema: './src/db/schema/index.ts', out: './drizzle' }`.

- [ ] **Step 2: Write the failing tests**

`apps/server/test/config.test.ts`:

```ts
import { test, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

const base = {
  APP_ORIGIN: 'https://app.example.co.uk', DATABASE_URL: 'postgres://u:p@localhost/db',
  UPLOAD_DIR: '/data/uploads', EMAIL_FROM: 'App <app@example.co.uk>', SMTP_URL: 'smtp://localhost:1025',
};

test('defaults are applied', () => {
  const c = loadConfig(base);
  expect(c).toMatchObject({ instanceMode: 'demo', appName: 'Highland App', port: 3000, cookieSecure: true,
    uploadMaxBytes: 15728640, email: { transport: 'smtp', smtpUrl: 'smtp://localhost:1025', from: 'App <app@example.co.uk>' },
    appVersion: '0.0.0-dev', commit: 'unknown' });
});

test('http origin turns secure cookies off by default', () => {
  expect(loadConfig({ ...base, APP_ORIGIN: 'http://192.168.1.20:8080' }).cookieSecure).toBe(false);
});

test('every problem is listed in plain English at once', () => {
  try {
    loadConfig({ APP_ORIGIN: 'not a url', PORT: '99999', EMAIL_TRANSPORT: 'smtp' });
    expect.unreachable();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    const p = (e as ConfigError).problems;
    expect(p).toContain('APP_ORIGIN must be a web address like https://app.example.co.uk (got "not a url").');
    expect(p).toContain('PORT must be a whole number between 1 and 65535 (got "99999").');
    expect(p).toContain('DATABASE_URL is missing.');
    expect(p).toContain('UPLOAD_DIR is missing.');
    expect(p).toContain('EMAIL_FROM is missing.');
    expect(p).toContain('SMTP_URL is missing (needed because EMAIL_TRANSPORT is smtp).');
    expect((e as Error).message).toMatch(/^The app cannot start because of 6 settings problems:/);
  }
});

test('production refuses test-only mail transports and short health tokens', () => {
  expect(() => loadConfig({ ...base, INSTANCE_MODE: 'production', EMAIL_TRANSPORT: 'file', EMAIL_FILE_DIR: '/tmp/m' }))
    .toThrow(/EMAIL_TRANSPORT file is only for testing/);
  expect(() => loadConfig({ ...base, HEALTH_TOKEN: 'short' })).toThrow(/HEALTH_TOKEN must be at least 24 characters/);
});
```

`apps/server/test/db.test.ts`:

```ts
import { test, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';

test('createTestDb gives an isolated, migrated database and drops it on close', async () => {
  const a = await createTestDb();
  const b = await createTestDb();
  expect(a.url).not.toBe(b.url);
  const r = await a.db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`);
  expect(r.rows[0]).toHaveProperty('n');
  const name = new URL(a.url).pathname.slice(1);
  await a.close();
  const still = await b.db.execute(sql`select 1 from pg_database where datname = ${name}`);
  expect(still.rows).toHaveLength(0);
  await b.close();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npx vitest run --project apps/server`
Expected: FAIL. The modules are not found.

- [ ] **Step 4: Implement**

- `config.ts`:
  - It parses each variable by hand with small helpers (`required`, `url`, `int`, `bool`, `oneOf`) that push messages into a `problems` array, so that **all** problems are collected.
  - It throws `new ConfigError(problems)`, whose `message` is `The app cannot start because of ${n} settings problems:\n- ` followed by the problems joined with `\n- `.
  - The exact message texts are the ones in the test.
  - It does not use Zod here, because a Zod error message would not be plain English.
- `db/client.ts`:
  - `createDb(url)` makes `new pg.Pool({ connectionString: url, max: 10 })` and `drizzle(pool, { schema })`.
  - `close()` ends the pool.
  - `runMigrations(db)` calls `migrate(db, { migrationsFolder: fileURLToPath(new URL('../../drizzle', import.meta.url)) })`. The same relative path works from `src/` (under tsx) and from `dist/`, because both sit one level below the workspace root.
- `db/migrate-cli.ts`: reads `DATABASE_URL` only (it does not need the full config), migrates, and closes.
- `test/helpers/testDb.ts`:
  - It reads `TEST_DATABASE_URL`. If that is missing, it throws `TEST_DATABASE_URL is not set. Point it at a Postgres role that may CREATE DATABASE.`
  - It connects to that admin database, runs `CREATE DATABASE hf_test_<16 hex>`, then `createDb` on the new URL and `runMigrations`.
  - `close()` ends the pool, then runs `DROP DATABASE … WITH (FORCE)`.
- With no tables yet, generate an empty initial migration so the migrator table exists: `npm -w @hf/server run db:custom -- --name init` and put `SELECT 1;` in it.

- [ ] **Step 5: Verify**

Run: `TEST_DATABASE_URL=postgres://postgres@localhost:5432/postgres npm run verify`
Expected: all tests PASS (5 new).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: config with plain-English errors, database, migrations, throwaway test DBs

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
