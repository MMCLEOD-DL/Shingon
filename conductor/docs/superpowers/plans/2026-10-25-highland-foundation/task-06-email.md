# Task 6: Transactional email

This task delivers spec §5's transactional email. Mail goes through an **outbox table** written in the same transaction as the change that causes it. A worker sends it and retries with back-off. So an invite is never "created but never mailed" because the SMTP server blinked, and a mail is never sent for a change that rolled back. Mail that keeps failing ends as `failed`, which the readiness check reports (Task 19) so the operator hears about it.

**Files:**
- Create: `apps/server/src/db/schema/email.ts`, `apps/server/src/email/{templates,transport,outbox}.ts`
- Modify: `apps/server/src/app.ts` (start the worker unless `instanceMode === 'test'`; stop it on `onClose`), `apps/server/test/helpers/testApp.ts` (use the real `memoryTransport`)
- Create: `deploy/compose.dev.yaml` with `db` (postgres:17) and `mailpit` (`axllent/mailpit`, SMTP 1025, UI 8025) for local development
- Test: `apps/server/test/email.test.ts`

**Interfaces:**
- Consumes: `Db`/`Tx`, `Config['email']` (Task 2).
- Produces: `TemplateName`, `renderTemplate`, `EmailTransport`, `EmailMessage`, `createTransport`, `memoryTransport`, `queueEmail`, `processOutbox`, `startOutboxWorker` and `RETRY_DELAYS_MS`, exactly as in the index.
  - Template data (all strings):
    - `invite { name, inviterName, link }`
    - `password-reset { name, link }`
    - `password-changed { name }`
  - `createTransport`:
    - `smtp` → Nodemailer `createTransport(smtpUrl)`;
    - `file` → writes `<fileDir>/<epoch-ms>-<rand>.json` containing the message (the browser tests read these, Task 14);
    - `memory` → `memoryTransport()`.

Table `email_outbox`:
- `id uuid pk`, `to_address text not null`, `template text not null`, `data jsonb not null`;
- `status text not null default 'pending' check (status in ('pending','sent','failed'))`;
- `attempts int not null default 0`, `next_attempt_at timestamptz not null default now()`;
- `last_error text`, `created_at`, `sent_at`;
- an index on `(status, next_attempt_at)`.

**Data retention note:** a sent row's `data` is cleared to `{}` once it is sent. Reset and invite links must not sit in the database after delivery.

- [ ] **Step 1: Install**

```bash
npm -w @hf/server i nodemailer@10.2.1 && npm -w @hf/server i -D @types/nodemailer
```

- [ ] **Step 2: Write the failing tests**

`apps/server/test/email.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import { renderTemplate, memoryTransport, queueEmail, processOutbox, RETRY_DELAYS_MS } from '../src/email/index.js';

const site = { appName: 'Acme Expenses', appOrigin: 'https://acme.example' };
let t: Awaited<ReturnType<typeof createTestDb>>;
beforeAll(async () => { t = await createTestDb(); });
afterAll(async () => { await t.close(); });

test('templates are plain English, branded, and escape what they are given', () => {
  const m = renderTemplate('invite', { name: '<b>Al</b>', inviterName: 'Ada', link: 'https://acme.example/invite/abc' }, site);
  expect(m.subject).toBe('Ada invited you to Acme Expenses');
  expect(m.text).toContain('https://acme.example/invite/abc');
  expect(m.text).toContain('This link works for 7 days.');
  expect(m.html).toContain('&lt;b&gt;Al&lt;/b&gt;');
  expect(m.html).not.toContain('<b>Al</b>');
  expect(renderTemplate('password-reset', { name: 'Al', link: 'L' }, site).text).toContain('This link works for 1 hour and only once.');
  expect(renderTemplate('password-changed', { name: 'Al' }, site).subject).toBe('Your Acme Expenses password was changed');
});

test('a queued mail is sent once, and its link data is cleared', async () => {
  const mail = memoryTransport();
  await queueEmail(t.db, { to: 'al@hf.test', template: 'password-reset', data: { name: 'Al', link: 'https://x/reset/SECRET' } });
  expect(await processOutbox(t.db, mail, site)).toEqual({ sent: 1, retried: 0, failed: 0 });
  expect(await processOutbox(t.db, mail, site)).toEqual({ sent: 0, retried: 0, failed: 0 });
  expect(mail.sent).toHaveLength(1);
  expect(mail.sent[0]).toMatchObject({ to: 'al@hf.test', subject: 'Reset your Acme Expenses password' });
  const row = (await t.db.execute(sql`select status, data from email_outbox`)).rows.at(-1)!;
  expect(row).toEqual({ status: 'sent', data: {} });
});

test('a mail that is never queued is never sent: the outbox follows the transaction', async () => {
  const mail = memoryTransport();
  await expect(t.db.transaction(async (tx) => {
    await queueEmail(tx, { to: 'rolled@hf.test', template: 'password-changed', data: { name: 'R' } });
    throw new Error('boom');
  })).rejects.toThrow();
  await processOutbox(t.db, mail, site);
  expect(mail.sent.map((m) => m.to)).not.toContain('rolled@hf.test');
});

test('failures back off, then give up as failed', async () => {
  const broken = { send: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:25'); } };
  await queueEmail(t.db, { to: 'retry@hf.test', template: 'password-changed', data: { name: 'R' } });
  let now = Date.now();
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    expect(await processOutbox(t.db, broken, site, { now: new Date(now) })).toEqual({ sent: 0, retried: 1, failed: 0 });
    expect(await processOutbox(t.db, broken, site, { now: new Date(now + RETRY_DELAYS_MS[i]! - 1000) })).toEqual({ sent: 0, retried: 0, failed: 0 });
    now += RETRY_DELAYS_MS[i]!;
  }
  expect(await processOutbox(t.db, broken, site, { now: new Date(now) })).toEqual({ sent: 0, retried: 0, failed: 1 });
  const row = (await t.db.execute(sql`select status, attempts, last_error from email_outbox where to_address = 'retry@hf.test'`)).rows[0]!;
  expect(row).toMatchObject({ status: 'failed', attempts: 6 });
  expect(String(row.last_error)).toContain('ECONNREFUSED');
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run --project apps/server test/email.test.ts`
Expected: FAIL. The module is missing.

- [ ] **Step 4: Implement**

- `templates.ts`:
  - one function per template returning `{ subject, text }` with the exact phrases asserted above;
  - `html` = a shared `layout(appName, bodyParagraphs, button?)` that HTML-escapes every interpolated value;
  - inline styles only (mail clients ignore stylesheets), and a single button for the link.
- `outbox.ts`:
  - `processOutbox` runs in one transaction: `SELECT … WHERE status = 'pending' AND next_attempt_at <= $now ORDER BY created_at LIMIT $batch FOR UPDATE SKIP LOCKED`.
  - For each row it renders and sends:
    - on success: `status = 'sent', sent_at = now, data = '{}'`;
    - on error: `attempts + 1`, `last_error` = the error message clipped to 500 chars;
    - if `attempts` (after the increment) is greater than `RETRY_DELAYS_MS.length`, then `status = 'failed'`;
    - otherwise `next_attempt_at = now + RETRY_DELAYS_MS[attempts - 1]`.
  - The function returns the counts.
- `startOutboxWorker`: a `setInterval` that never overlaps (it skips a tick while one is running) and logs failures. `stop()` clears it and awaits the run in flight.
- `src/email/index.ts` re-exports all of these.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: all tests PASS (4 new).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: transactional email outbox with retry, templates, SMTP/file/memory transports

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
