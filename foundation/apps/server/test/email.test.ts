import { test, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';
import { renderTemplate, memoryTransport, queueEmail, processOutbox, RETRY_DELAYS_MS, startOutboxWorker, scrubSmtpError } from '../src/email/index.js';

const site = { appName: 'Acme Expenses', appOrigin: 'https://acme.example' };
let t: Awaited<ReturnType<typeof createTestDb>>;
const HOOK_MS = 30_000;
beforeAll(async () => { t = await createTestDb(); }, HOOK_MS);
afterAll(async () => { await t.close(); }, HOOK_MS);
beforeEach(async () => { await t.db.execute(sql`delete from email_outbox`); }, HOOK_MS);

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

test('a failed mail has its data cleared too', async () => {
  const broken = { send: () => Promise.reject(new Error('down')) };
  await queueEmail(t.db, { to: 'gone@hf.test', template: 'password-reset', data: { name: 'G', link: 'https://acme.example/reset/TOKEN' } });
  let now = Date.now() + 1000; // the row's database timestamp has microseconds
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    await processOutbox(t.db, broken, site, { now: new Date(now) });
    now += RETRY_DELAYS_MS[i] ?? 0;
  }
  const row = (await t.db.execute(sql`select status, data from email_outbox where to_address = 'gone@hf.test'`)).rows[0]!;
  expect(row).toEqual({ status: 'failed', data: {} });
});

test('concurrent runs send each queued mail exactly once', async () => {
  const mail = memoryTransport();
  const slow = { send: async (m: Parameters<typeof mail.send>[0]) => { await new Promise((r) => setTimeout(r, 20)); await mail.send(m); } };
  for (let i = 0; i < 6; i++) await queueEmail(t.db, { to: `conc${String(i)}@hf.test`, template: 'password-changed', data: { name: 'C' } });
  const results = await Promise.all([1, 2, 3].map(() => processOutbox(t.db, slow, site, { now: new Date(Date.now() + 1000) })));
  expect(results.reduce((n, r) => n + r.sent, 0)).toBe(6);
  expect(mail.sent.map((m) => m.to).sort()).toEqual([0, 1, 2, 3, 4, 5].map((i) => `conc${String(i)}@hf.test`));
});

test('one bad mail does not stop or repeat the others', async () => {
  const mail = memoryTransport();
  await queueEmail(t.db, { to: 'bad@hf.test', template: 'invite', data: { name: 'B' } });
  await queueEmail(t.db, { to: 'good@hf.test', template: 'password-changed', data: { name: 'G' } });
  expect(await processOutbox(t.db, mail, site, { now: new Date(Date.now() + 1000) })).toEqual({ sent: 1, retried: 1, failed: 0 });
  expect(mail.sent.map((m) => m.to)).toEqual(['good@hf.test']);
  const row = (await t.db.execute(sql`select last_error from email_outbox where to_address = 'bad@hf.test'`)).rows[0]!;
  expect(String(row.last_error)).toContain('missing');
});

test('the worker ticks without overlapping, survives a transport error, and stops', async () => {
  vi.useFakeTimers();
  try {
    // The processor is a stub, so no real I/O has to finish inside a fake-timer tick.
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const gate = { release: (): void => undefined };
    const errors: object[] = [];
    const process = async (): Promise<void> => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => { gate.release = () => { r(); }; });
      active--;
      throw Object.assign(new Error('connect ECONNREFUSED secret-host'), { name: 'TransportError' });
    };
    const stop = startOutboxWorker(t.db, memoryTransport(), site, { intervalMs: 50, log: { error: (o) => { errors.push(o); } }, process });
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(1);
    expect(maxActive).toBe(1);
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    // The failed run was swallowed and logged by name only; the next tick starts a fresh run.
    expect(errors).toEqual([{ errName: 'TransportError' }]);
    expect(JSON.stringify(errors)).not.toContain('secret-host');
    await vi.advanceTimersByTimeAsync(50);
    expect(calls).toBe(2);
    gate.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([{ errName: 'TransportError' }, { errName: 'TransportError' }]);
    const stopped = stop();
    await vi.advanceTimersByTimeAsync(0);
    await expect(stopped).resolves.toBeUndefined();
    const before = calls;
    await vi.advanceTimersByTimeAsync(500);
    expect(calls).toBe(before);
    expect(maxActive).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test('the worker logs a failed run by error name only', async () => {
  const errors: object[] = [];
  const brokenDb = { transaction: () => Promise.reject(new Error('password=hunter2')) } as unknown as typeof t.db;
  vi.useFakeTimers();
  try {
    const stop = startOutboxWorker(brokenDb, memoryTransport(), site, { intervalMs: 10, log: { error: (o) => { errors.push(o); } } });
    await vi.advanceTimersByTimeAsync(30);
    await stop();
  } finally {
    vi.useRealTimers();
  }
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.every((e) => JSON.stringify(e) === '{"errName":"Error"}')).toBe(true);
  expect(JSON.stringify(errors)).not.toContain('hunter2');
});

test('html escapes the app name, the inviter and awkward links', () => {
  const evil = { appName: 'A<script>&"x', appOrigin: 'https://acme.example' };
  const m = renderTemplate('invite', { name: 'N', inviterName: '<i>Eve</i>', link: 'https://acme.example/i?a="1"&b=<2>' }, evil);
  expect(m.html).not.toContain('<script>');
  expect(m.html).not.toContain('<i>Eve</i>');
  expect(m.html).toContain('A&lt;script&gt;&amp;&quot;x');
  expect(m.html).toContain('&lt;i&gt;Eve&lt;/i&gt;');
  expect(m.html).not.toMatch(/href="[^"]*"[^>]*"1"/);
  expect(m.html).not.toContain('<2>');
});

test('only links to this app become a button', () => {
  for (const link of ['javascript:alert(1)', 'https://evil.example/reset/x', 'https://acme.example.evil.test/x', 'not a url']) {
    const m = renderTemplate('password-reset', { name: 'N', link }, site);
    expect(m.html).not.toContain('href=');
    expect(m.text).toContain(link);
  }
  expect(renderTemplate('password-reset', { name: 'N', link: 'https://acme.example/reset/x' }, site).html).toContain('href="https://acme.example/reset/x"');
});

test('unknown templates and missing data are refused, not mailed blank', () => {
  expect(() => renderTemplate('nope' as never, {}, site)).toThrow(/Unknown email template/);
  expect(() => renderTemplate('invite', { name: 'N', inviterName: 'I' }, site)).toThrow(/link/);
  expect(() => renderTemplate('password-reset', { name: 'N' }, site)).toThrow(/link/);
});

test('smtp error text is scrubbed of credentials', () => {
  const url = 'smtp://mailuser:p%40ss%25w0rd@127.0.0.1:2525';
  const msg = scrubSmtpError('Invalid login for mailuser with p@ss%w0rd (raw p%40ss%25w0rd) at ' + url, url);
  expect(msg).not.toContain('mailuser');
  expect(msg).not.toContain('p@ss%w0rd');
  expect(msg).not.toContain('p%40ss%25w0rd');
  // Undecodable password: the raw text is still removed.
  const bad = 'smtp://bob:50%zz-secret@127.0.0.1:25';
  expect(scrubSmtpError('failed 50%zz-secret', bad)).not.toContain('secret');
  // A very short username is not masked by substring.
  expect(scrubSmtpError('mailbox ab is full', 'smtp://ab:pw12345@127.0.0.1:25')).toContain('mailbox ab is full');
});

test('the from address falls back to the site host, and an explicit one wins', async () => {
  const mail = memoryTransport();
  await queueEmail(t.db, { to: 'from1@hf.test', template: 'password-changed', data: { name: 'F' } });
  await processOutbox(t.db, mail, site, { now: new Date(Date.now() + 1000) });
  expect(mail.sent.at(-1)?.from).toBe('Acme Expenses <noreply@acme.example>');
  await queueEmail(t.db, { to: 'from2@hf.test', template: 'password-changed', data: { name: 'F' } });
  await processOutbox(t.db, mail, { ...site, from: 'Acme <hello@acme.example>' }, { now: new Date(Date.now() + 1000) });
  expect(mail.sent.at(-1)?.from).toBe('Acme <hello@acme.example>');
});
