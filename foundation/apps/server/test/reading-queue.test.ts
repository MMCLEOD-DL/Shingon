import { test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { asc, eq } from 'drizzle-orm';
import type { OcrEngine, OcrResult } from '@hf/ocr';
import { createTestDb } from './helpers/testDb.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { fixtureLines } from './helpers/fakeOcr.js';
import { LocalDiskStorage } from '../src/files/storage.js';
import { files, receiptReadings } from '../src/db/schema/index.js';
import { startReadingQueue, type ReadingQueue } from '../src/modules/ocr/index.js';

let db: Awaited<ReturnType<typeof createTestDb>>;
let dir: string;
let storage: LocalDiskStorage;
let owner: { id: string; teamId: string };
let queue: ReadingQueue | undefined;
const errors: unknown[] = [];
const log = { error: (obj: object, msg: string) => { errors.push([obj, msg]); }, warn: () => undefined };

beforeEach(async () => {
  db = await createTestDb();
  dir = await mkdtemp(join(tmpdir(), 'hf-queue-'));
  storage = new LocalDiskStorage(dir);
  const team = await makeTeam(db.db, 'North');
  const u = await makeUser(db.db, { role: 'member', teamId: team.id });
  owner = { id: u.id, teamId: team.id };
  errors.length = 0;
  queue = undefined;
});
afterEach(async () => {
  await queue?.stop();
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

let n = 0;
/** A stored file holding `label` as its bytes, and a pending reading for it created at `createdAt`. */
async function pending(label: string, createdAt: Date, engine: string | null = null): Promise<string> {
  const key = `ab${String(++n).padStart(10, '0')}`;
  const put = await storage.put(key, Readable.from([Buffer.from(label)]));
  const [f] = await db.db.insert(files).values({
    ownerId: owner.id, teamId: owner.teamId, storageKey: key, originalName: `${label.slice(0, 20)}.png`, contentType: 'image/png', size: put.size, sha256: put.sha256,
    attachedType: 'receipt-reading',
  }).returning();
  const [r] = await db.db.insert(receiptReadings).values({ fileId: f!.id, ownerId: owner.id, teamId: owner.teamId, status: 'pending', engine, createdAt, updatedAt: createdAt }).returning();
  await db.db.update(files).set({ attachedId: r!.id }).where(eq(files.id, f!.id));
  return r!.id;
}

/** An engine that records the order and overlap of its reads; `gate` (when given) holds each read until it resolves. */
function recordingEngine(opts: { gate?: (label: string) => Promise<void>; delayMs?: number } = {}) {
  const order: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const engine: OcrEngine = {
    id: 'recording', kind: 'local', outboundId: null,
    async read({ bytes }): Promise<OcrResult> {
      const label = bytes.toString();
      order.push(label);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        await opts.gate?.(label);
        return { engine: 'recording', lines: fixtureLines('taxi.txt'), warnings: [], ms: 1 };
      } finally {
        inFlight--;
      }
    },
    async close() { /* nothing */ },
  };
  return { engine, order, max: () => maxInFlight };
}

const start = (engine: OcrEngine, concurrency = 1): ReadingQueue =>
  (queue = startReadingQueue({ db: db.db, storage, engine, concurrency, maxBytes: 1024 * 1024, log }));
const statuses = async () => (await db.db.select({ id: receiptReadings.id, status: receiptReadings.status }).from(receiptReadings).orderBy(asc(receiptReadings.createdAt)));

test('pending rows left by a restart are read on start, oldest first', async () => {
  // The newer one is inserted first, so creation order and insertion order differ.
  const newer = await pending('newer', new Date('2026-03-02T10:00:00Z'));
  const older = await pending('older', new Date('2026-03-01T10:00:00Z'));
  const rec = recordingEngine();
  await start(rec.engine).idle();
  expect(rec.order).toEqual(['older', 'newer']);
  expect(await statuses()).toEqual([{ id: older, status: 'read' }, { id: newer, status: 'read' }]);
  expect(errors).toEqual([]);
});

test('never more than the set number at once', async () => {
  for (const label of ['a', 'b', 'c']) await pending(label, new Date());
  const one = recordingEngine({ delayMs: 20 });
  await start(one.engine, 1).idle();
  expect(one.max()).toBe(1);
  expect((await statuses()).map((s) => s.status)).toEqual(['read', 'read', 'read']);
  await queue!.stop();

  for (const label of ['d', 'e', 'f']) await pending(label, new Date());
  const two = recordingEngine({ delayMs: 20 });
  await start(two.engine, 2).idle();
  expect(two.max()).toBe(2);
});

test('a reading enqueued after start is read too', async () => {
  const rec = recordingEngine();
  const q = start(rec.engine);
  await q.idle();
  const id = await pending('later', new Date());
  q.enqueue(id);
  await q.idle();
  expect(await statuses()).toEqual([{ id, status: 'read' }]);
});

test('a reading whose row vanished meanwhile is skipped', async () => {
  const id = await pending('gone', new Date());
  const rec = recordingEngine({ gate: async () => { await db.db.delete(receiptReadings).where(eq(receiptReadings.id, id)); } });
  await start(rec.engine).idle();
  expect(rec.order).toEqual(['gone']);
  expect(await statuses()).toEqual([]);
  expect(errors).toEqual([]);
});

test('a file larger than the limit is not read', async () => {
  const id = await pending('x'.repeat(2000), new Date());
  const rec = recordingEngine();
  queue = startReadingQueue({ db: db.db, storage, engine: rec.engine, concurrency: 1, maxBytes: 1000, log });
  await queue.idle();
  expect(rec.order).toEqual([]);
  const [r] = await db.db.select().from(receiptReadings).where(eq(receiptReadings.id, id));
  expect(r).toMatchObject({ status: 'unreadable', problem: 'This file is too large to read automatically. Please type the details.' });
});

test('stop waits for the current reading and starts no more', async () => {
  const first = await pending('first', new Date('2026-03-01T10:00:00Z'));
  const second = await pending('second', new Date('2026-03-02T10:00:00Z'));
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const isStarted = new Promise<void>((r) => { started = r; });
  const rec = recordingEngine({ gate: (label) => (label === 'first' ? new Promise<void>((r) => { release = r; started(); }) : Promise.resolve()) });
  const q = start(rec.engine);
  await isStarted;
  let stopped = false;
  const stopping = q.stop().then(() => { stopped = true; });
  await new Promise((r) => setTimeout(r, 30));
  expect(stopped).toBe(false);
  release();
  await stopping;
  expect(rec.order).toEqual(['first']);
  expect(await statuses()).toEqual([{ id: first, status: 'read' }, { id: second, status: 'pending' }]);
  // Nothing more is taken on after stopping.
  q.enqueue(second);
  await q.idle();
  expect(rec.order).toEqual(['first']);
});

test('a reading that was started but never finished (the process died) is not read again at the next start', async () => {
  // As left by an out-of-memory kill: still pending, but marked as started by an engine.
  const crashed = await pending('crashed', new Date('2026-03-01T10:00:00Z'), 'local-tesseract');
  const fresh = await pending('fresh', new Date('2026-03-02T10:00:00Z'));
  const rec = recordingEngine();
  await start(rec.engine).idle();
  expect(rec.order).toEqual(['fresh']);
  const [c] = await db.db.select().from(receiptReadings).where(eq(receiptReadings.id, crashed));
  expect(c).toMatchObject({ status: 'unreadable', problem: "This receipt couldn't be read automatically. Please type the details.", proposal: null });
  expect(await statuses()).toEqual([{ id: crashed, status: 'unreadable' }, { id: fresh, status: 'read' }]);
  // Only the reading's id is logged.
  expect(errors).toEqual([[{ readingId: crashed }, expect.any(String)]]);
});

test('a reading is marked as started (engine set) just before the engine runs, and a normal finish keeps it right', async () => {
  const id = await pending('marked', new Date());
  const seen: (string | null)[] = [];
  const rec = recordingEngine({ gate: async () => {
    const [r] = await db.db.select().from(receiptReadings).where(eq(receiptReadings.id, id));
    seen.push(r!.engine);
  } });
  await start(rec.engine).idle();
  expect(seen).toEqual(['recording']);
  const [r] = await db.db.select().from(receiptReadings).where(eq(receiptReadings.id, id));
  expect(r).toMatchObject({ status: 'read', engine: 'recording', problem: null });
});

test('asking again for a reading that is being read does not read it a second time', async () => {
  const id = await pending('once', new Date());
  let release: () => void = () => undefined;
  let started: () => void = () => undefined;
  const isStarted = new Promise<void>((r) => { started = r; });
  const rec = recordingEngine({ gate: () => new Promise<void>((r) => { release = r; started(); }) });
  const q = start(rec.engine);
  await isStarted;
  q.enqueue(id);
  q.enqueue(id);
  release();
  await q.idle();
  expect(rec.order).toEqual(['once']);
  expect(await statuses()).toEqual([{ id, status: 'read' }]);
});

/** The test database, but the first `failures` selects fail as a dropped connection would. */
function flakyDb(failures: number) {
  let calls = 0;
  let left = failures;
  const proxy = new Proxy(db.db, {
    get(target, prop, recv) {
      if (prop === 'select') {
        return (...args: Parameters<typeof target.select>) => {
          calls++;
          if (left > 0) {
            left--;
            throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { name: 'ConnectionError' });
          }
          return target.select(...args);
        };
      }
      const v: unknown = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { db: proxy, calls: () => calls };
}

test('the start-up load is tried again with a short backoff when the database is not ready yet', async () => {
  const id = await pending('late db', new Date());
  const flaky = flakyDb(2);
  const rec = recordingEngine();
  queue = startReadingQueue({ db: flaky.db, storage, engine: rec.engine, concurrency: 1, maxBytes: 1024 * 1024, log, loadRetryMs: [5, 5, 5] });
  await queue.idle();
  expect(rec.order).toEqual(['late db']);
  expect(await statuses()).toEqual([{ id, status: 'read' }]);
  // Each failed try is logged by the error's name only.
  expect(errors).toEqual([
    [{ errName: 'ConnectionError', attempt: 1 }, expect.any(String)],
    [{ errName: 'ConnectionError', attempt: 2 }, expect.any(String)],
  ]);
});

test('the start-up load gives up after a bounded number of tries', async () => {
  const id = await pending('never', new Date());
  const flaky = flakyDb(100);
  const rec = recordingEngine();
  queue = startReadingQueue({ db: flaky.db, storage, engine: rec.engine, concurrency: 1, maxBytes: 1024 * 1024, log, loadRetryMs: [1, 1] });
  await queue.idle();
  expect(flaky.calls()).toBe(3);
  expect(rec.order).toEqual([]);
  expect(await statuses()).toEqual([{ id, status: 'pending' }]);
  expect(errors).toHaveLength(3);
  expect(JSON.stringify(errors)).not.toContain('ECONNREFUSED');
});

test('stop during the start-up backoff does not wait for the backoff to run out', async () => {
  const flaky = flakyDb(100);
  const rec = recordingEngine();
  queue = startReadingQueue({ db: flaky.db, storage, engine: rec.engine, concurrency: 1, maxBytes: 1024 * 1024, log, loadRetryMs: [60_000] });
  await new Promise((r) => setTimeout(r, 20));
  const t0 = Date.now();
  await queue.stop();
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(flaky.calls()).toBe(1);
});

test('a reading confirmed while the engine is reading it is left confirmed', async () => {
  const id = await pending('confirmed meanwhile', new Date());
  const typed = { amountPence: 500, vatPence: null, date: '2026-03-01', merchant: 'Typed' };
  const rec = recordingEngine({ gate: async () => {
    await db.db.update(receiptReadings).set({ status: 'confirmed', confirmed: typed, corrected: ['amount', 'vat', 'date', 'merchant'] }).where(eq(receiptReadings.id, id));
  } });
  await start(rec.engine).idle();
  const [r] = await db.db.select().from(receiptReadings).where(eq(receiptReadings.id, id));
  expect(r).toMatchObject({ status: 'confirmed', confirmed: typed, proposal: null, readAt: null });
});
