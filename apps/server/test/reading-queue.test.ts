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
async function pending(label: string, createdAt: Date): Promise<string> {
  const key = `ab${String(++n).padStart(10, '0')}`;
  const put = await storage.put(key, Readable.from([Buffer.from(label)]));
  const [f] = await db.db.insert(files).values({
    ownerId: owner.id, teamId: owner.teamId, storageKey: key, originalName: `${label.slice(0, 20)}.png`, contentType: 'image/png', size: put.size, sha256: put.sha256,
    attachedType: 'receipt-reading',
  }).returning();
  const [r] = await db.db.insert(receiptReadings).values({ fileId: f!.id, ownerId: owner.id, teamId: owner.teamId, status: 'pending', createdAt, updatedAt: createdAt }).returning();
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
