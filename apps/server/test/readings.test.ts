import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { HEIC_REFUSED, IMAGE_TOO_LARGE, UnreadableError } from '@hf/ocr';
import { createTestApp, call, signInAs, type TestApp } from './helpers/testApp.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { fixtureLines } from './helpers/fakeOcr.js';
import { lastAudit, readingFor, upload } from './helpers/readings.js';
import { files, receiptReadings } from '../src/db/schema/index.js';
import { sweepOrphans } from '../src/files/repo.js';
import { LocalDiskStorage } from '../src/files/storage.js';

let t: TestApp;
type U = { id: string };
let alice: U, bob: U, mN: U, mS: U, admin: U;
let aliceAuth: { cookie: string };

const ALREADY = 'This receipt has already been confirmed.';
const GENERAL = "This receipt couldn't be read automatically. Please type the details.";
const TAXI = { amountPence: 1240, vatPence: 207, date: '2026-03-12', merchant: 'Northside Taxis' };

beforeAll(async () => {
  t = await createTestApp();
  const N = await makeTeam(t.db, 'North');
  const S = await makeTeam(t.db, 'South');
  alice = await makeUser(t.db, { role: 'member', teamId: N.id });
  bob = await makeUser(t.db, { role: 'member', teamId: N.id });
  mN = await makeUser(t.db, { role: 'manager', teamId: N.id });
  mS = await makeUser(t.db, { role: 'manager', teamId: S.id });
  admin = await makeUser(t.db, { role: 'admin' });
  aliceAuth = await signInAs(t, alice);
});
afterAll(async () => { await t.close(); });

const row = async (id: string) => (await t.db.select().from(receiptReadings).where(eq(receiptReadings.id, id)))[0];

test('owner asks for a reading, it is read, and the proposal comes back with confidences', async () => {
  const f = await upload(t, alice, 'taxi-photo.jpg');
  const r = await call(t, aliceAuth, 'POST', `/api/files/${f.id}/reading`, {});
  expect(r.status).toBe(202);
  expect(r.json.reading).toMatchObject({ fileId: f.id, status: 'pending', proposal: null, ownerId: alice.id });
  await t.readings.idle();
  const g = await call(t, aliceAuth, 'GET', `/api/readings/${String(r.json.reading.id)}`);
  expect(g.status).toBe(200);
  expect(g.json.reading).toMatchObject({ status: 'read', engine: 'fake', proposal: { amountPence: { value: 1240 }, vatPence: { value: 207 }, date: { value: '2026-03-12' } } });
  expect(typeof g.json.reading.proposal.amountPence.confidence).toBe('number');
  const a = await lastAudit(t.db, 'reading.requested');
  expect(a).toMatchObject({ targetType: 'file', targetId: f.id, actorId: alice.id });
});

test('confirming records which fields staff corrected, and audits names only', async () => {
  const id = await readingFor(t, alice, 'taxi.txt');
  const c = await call(t, aliceAuth, 'POST', `/api/readings/${id}/confirm`, { amountPence: 1240, vatPence: 207, date: '2026-03-12', merchant: 'Northside Taxis Ltd' });
  expect(c.status).toBe(200);
  expect(c.json.reading).toMatchObject({ status: 'confirmed', corrected: ['merchant'], confirmed: { merchant: 'Northside Taxis Ltd' } });
  expect(c.json.reading.confirmedAt).toEqual(expect.any(String));
  const a = await lastAudit(t.db, 'reading.confirmed');
  expect(a.details).toEqual({ corrected: ['merchant'] });
  expect(a).toMatchObject({ targetType: 'reading', targetId: id });
  expect(JSON.stringify(a)).not.toContain('Northside');
});

test('a second confirm and a re-read of a confirmed receipt are refused', async () => {
  const id = await readingFor(t, alice, 'taxi.txt');
  expect((await call(t, aliceAuth, 'POST', `/api/readings/${id}/confirm`, TAXI)).status).toBe(200);
  const before = await row(id);
  const again = await call(t, aliceAuth, 'POST', `/api/readings/${id}/confirm`, { ...TAXI, amountPence: 999 });
  expect(again.status).toBe(409);
  expect(again.json.error).toBe(ALREADY);
  const reread = await call(t, aliceAuth, 'POST', `/api/files/${before!.fileId}/reading`, {});
  expect(reread.status).toBe(409);
  expect(reread.json.error).toBe(ALREADY);
  expect(await row(id)).toEqual(before);
});

test('asking again for an unconfirmed reading starts it afresh with the same id', async () => {
  const f = await upload(t, alice, 'taxi-photo.jpg');
  t.fakeOcr.fail(new UnreadableError(IMAGE_TOO_LARGE));
  const first = await call(t, aliceAuth, 'POST', `/api/files/${f.id}/reading`, {});
  await t.readings.idle();
  // A picture over 25 megapixels is refused by the engine; staff see its sentence.
  expect(await row(String(first.json.reading.id))).toMatchObject({ status: 'unreadable', problem: IMAGE_TOO_LARGE, proposal: null });
  const second = await call(t, aliceAuth, 'POST', `/api/files/${f.id}/reading`, {});
  expect(second.status).toBe(202);
  expect(second.json.reading).toMatchObject({ id: first.json.reading.id, status: 'pending', problem: null, proposal: null });
  await t.readings.idle();
  expect(await row(String(first.json.reading.id))).toMatchObject({ status: 'read', problem: null });
});

test('confirming while still reading is accepted, every field counts as corrected, and the reading finishing later changes nothing', async () => {
  const f = await upload(t, alice, 'taxi-photo.jpg');
  const held = t.fakeOcr.hold();
  const r = await call(t, aliceAuth, 'POST', `/api/files/${f.id}/reading`, {});
  const id = String(r.json.reading.id);
  // Staff gave up waiting (the page's 90 seconds) and typed the details themselves.
  const typed = { amountPence: 999, vatPence: null, date: '2026-03-11', merchant: 'Typed by hand' };
  const c = await call(t, aliceAuth, 'POST', `/api/readings/${id}/confirm`, typed);
  expect(c.status).toBe(200);
  expect(c.json.reading).toMatchObject({ status: 'confirmed', confirmed: typed, corrected: ['amount', 'vat', 'date', 'merchant'] });
  expect((await lastAudit(t.db, 'reading.confirmed')).details).toEqual({ corrected: ['amount', 'vat', 'date', 'merchant'] });
  const confirmed = await row(id);
  // The queue then finishes reading the receipt: the confirmed row is never overwritten.
  held.release();
  await t.readings.idle();
  expect(await row(id)).toEqual(confirmed);
  expect(confirmed).toMatchObject({ status: 'confirmed', confirmed: typed, proposal: null });
});

test('VAT above the total and extra keys are refused with 400 and nothing changes', async () => {
  const id = await readingFor(t, alice, 'taxi.txt');
  const before = await row(id);
  const vat = await call(t, aliceAuth, 'POST', `/api/readings/${id}/confirm`, { ...TAXI, vatPence: 1300, amountPence: 1240 });
  expect(vat.status).toBe(400);
  expect(vat.json.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "The VAT can't be more than the total." })]));
  for (const extra of [{ ownerId: bob.id }, { status: 'confirmed' }, { corrected: [] }, { fileId: before!.fileId }]) {
    expect((await call(t, aliceAuth, 'POST', `/api/readings/${id}/confirm`, { ...TAXI, ...extra })).status).toBe(400);
  }
  expect((await call(t, aliceAuth, 'POST', `/api/files/${before!.fileId}/reading`, { ownerId: bob.id })).status).toBe(400);
  expect(await row(id)).toEqual(before);
});

test('a manager sees the team reading but cannot confirm it (403); another team gets 404', async () => {
  const id = await readingFor(t, alice, 'taxi.txt');
  const before = await row(id);
  const north = await signInAs(t, mN);
  const south = await signInAs(t, mS);
  const seen = await call(t, north, 'GET', `/api/readings/${id}`);
  expect(seen.status).toBe(200);
  expect(seen.json.reading.id).toBe(id);
  expect((await call(t, north, 'POST', `/api/readings/${id}/confirm`, TAXI)).status).toBe(403);
  expect((await call(t, south, 'GET', `/api/readings/${id}`)).status).toBe(404);
  expect((await call(t, south, 'POST', `/api/readings/${id}/confirm`, TAXI)).status).toBe(404);
  expect((await call(t, await signInAs(t, bob), 'GET', `/api/readings/${id}`)).status).toBe(404);
  expect(await row(id)).toEqual(before);
  // An admin may confirm anyone's reading.
  expect((await call(t, await signInAs(t, admin), 'POST', `/api/readings/${id}/confirm`, TAXI)).status).toBe(200);
});

test('a member cannot ask for a reading of a file they can see but do not own (404)', async () => {
  const f = await upload(t, alice, 'taxi-photo.jpg');
  const north = await signInAs(t, mN);
  // The manager can see the file, but asking for a reading changes it: only its owner or an admin may.
  expect((await call(t, north, 'GET', `/api/files/${f.id}`)).status).toBe(200);
  expect((await call(t, north, 'POST', `/api/files/${f.id}/reading`, {})).status).toBe(404);
  expect((await call(t, await signInAs(t, bob), 'POST', `/api/files/${f.id}/reading`, {})).status).toBe(404);
  expect(await t.db.select().from(receiptReadings).where(eq(receiptReadings.fileId, f.id))).toEqual([]);
  expect((await t.db.select().from(files).where(eq(files.id, f.id)))[0]).toMatchObject({ attachedType: null, attachedId: null });
  expect((await call(t, await signInAs(t, admin), 'POST', `/api/files/${f.id}/reading`, {})).status).toBe(202);
  await t.readings.idle();
  // The reading belongs to the file's owner, whoever asked for it.
  expect((await t.db.select().from(receiptReadings).where(eq(receiptReadings.fileId, f.id)))[0]).toMatchObject({ ownerId: alice.id });
});

test('a file used by a reading is attached to it, and survives sweepOrphans 25 h later', async () => {
  const id = await readingFor(t, alice, 'taxi.txt');
  const r = await row(id);
  const loose = await upload(t, alice, 'taxi-photo.jpg');
  const f = (await t.db.select().from(files).where(eq(files.id, r!.fileId)))[0]!;
  expect(f).toMatchObject({ attachedType: 'receipt-reading', attachedId: id });
  const storage = new LocalDiskStorage(t.config.uploadDir);
  const in25h = new Date(Date.now() + 25 * 3600e3);
  await sweepOrphans(t.db, storage, new Date(in25h.getTime() - 24 * 3600e3));
  expect((await t.db.select().from(files).where(eq(files.id, f.id)))).toHaveLength(1);
  expect(existsSync(join(t.config.uploadDir, f.storageKey.slice(0, 2), f.storageKey))).toBe(true);
  expect(await row(id)).toBeDefined();
  // The same sweep does remove an upload nothing uses, so the cut-off really was passed.
  expect((await t.db.select().from(files).where(eq(files.id, loose.id)))).toHaveLength(0);
});

test('a photo attached to something else cannot be read', async () => {
  const f = await upload(t, alice, 'taxi-photo.jpg');
  const note = await call(t, aliceAuth, 'POST', '/api/notes', { title: 'Taxi', attachmentId: f.id });
  expect(note.status).toBe(201);
  const r = await call(t, aliceAuth, 'POST', `/api/files/${f.id}/reading`, {});
  expect(r.status).toBe(409);
  expect(await t.db.select().from(receiptReadings).where(eq(receiptReadings.fileId, f.id))).toEqual([]);
});

test('deleting the file deletes its reading', async () => {
  const id = await readingFor(t, alice, 'taxi.txt');
  const r = await row(id);
  expect((await call(t, aliceAuth, 'DELETE', `/api/files/${r!.fileId}`)).status).toBe(204);
  expect((await call(t, aliceAuth, 'GET', `/api/readings/${id}`)).status).toBe(404);
  expect(await row(id)).toBeUndefined();
});

test('a HEIC upload ends as unreadable with the sentence staff see', async () => {
  const f = await upload(t, alice, 'tiny.heic');
  expect(f.contentType).toBe('image/heic');
  const r = await call(t, aliceAuth, 'POST', `/api/files/${f.id}/reading`, {});
  expect(r.status).toBe(202);
  await t.readings.idle();
  const g = await call(t, aliceAuth, 'GET', `/api/readings/${String(r.json.reading.id)}`);
  expect(g.json.reading).toMatchObject({ status: 'unreadable', problem: HEIC_REFUSED, proposal: null });
  expect(HEIC_REFUSED).toMatch(/^Photos in HEIC format can't be read automatically\. /);
  // The form stays usable: staff type the details and confirm, and every field counts as corrected.
  const c = await call(t, aliceAuth, 'POST', `/api/readings/${String(r.json.reading.id)}/confirm`, TAXI);
  expect(c.status).toBe(200);
  expect(c.json.reading).toMatchObject({ status: 'confirmed', corrected: ['amount', 'vat', 'date', 'merchant'] });
});

test('an engine crash ends as unreadable with the general sentence and logs no receipt text', async () => {
  const errors = vi.spyOn(t.app.log, 'error');
  const warns = vi.spyOn(t.app.log, 'warn');
  try {
    const f = await upload(t, alice, 'taxi-photo.jpg');
    const crash = new Error('Northside Taxis Total to pay £12.40 Card ending 4421');
    t.fakeOcr.fail(crash);
    const r = await call(t, aliceAuth, 'POST', `/api/files/${f.id}/reading`, {});
    await t.readings.idle();
    expect(await row(String(r.json.reading.id))).toMatchObject({ status: 'unreadable', problem: GENERAL, proposal: null });
    expect(errors).toHaveBeenCalled();
    const logged = JSON.stringify([...errors.mock.calls, ...warns.mock.calls]);
    for (const bit of ['Northside', '12.40', '4421']) expect(logged).not.toContain(bit);
  } finally {
    errors.mockRestore();
    warns.mockRestore();
  }
});

test('no proposal ever contains the raw recognised text', async () => {
  const id = await readingFor(t, alice, 'taxi.txt');
  await call(t, aliceAuth, 'POST', `/api/readings/${id}/confirm`, TAXI);
  const r = await row(id);
  expect(Object.keys(r!).sort()).toEqual(['confirmed', 'confirmedAt', 'corrected', 'createdAt', 'engine', 'fileId', 'id', 'ownerId', 'problem', 'proposal', 'readAt', 'status', 'teamId', 'updatedAt']);
  const stored = JSON.stringify(r);
  // Every line that is not itself a field value (the merchant name is) must be gone.
  for (const line of fixtureLines('taxi.txt').map((l) => l.text).filter((l) => l !== TAXI.merchant)) {
    expect(stored).not.toContain(line);
  }
  for (const bit of ['Station Road', '765432', '4421', '004417', 'Total to pay']) expect(stored).not.toContain(bit);
});
