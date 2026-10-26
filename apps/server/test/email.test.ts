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
  const broken = { send: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:25')) };
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
