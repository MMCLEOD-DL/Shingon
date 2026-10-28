/**
 * The reading queue: reads receipts in the background, at most `concurrency` at once. On start it picks up every reading
 * left `pending` (by a restart, say), oldest first. The recognised text is used only to build the proposal and is never
 * stored or logged (Ruling 5); a failure is logged by the reading's id and the error's name, nothing else.
 */
import type { Readable } from 'node:stream';
import { and, asc, eq, sql } from 'drizzle-orm';
import { readReceipt, UnreadableError, type OcrEngine, type OcrInputType } from '@hf/ocr';
import type { Db } from '../../db/client.js';
import { files, receiptReadings } from '../../db/schema/index.js';
import type { Storage } from '../../files/storage.js';

export const GENERAL_PROBLEM = "This receipt couldn't be read automatically. Please type the details.";
export const TOO_LARGE_PROBLEM = 'This file is too large to read automatically. Please type the details.';

export interface ReadingQueue {
  /** Adds a reading to the queue (a reading already waiting is not added twice). Ignored once stopped. */
  enqueue(id: string): void;
  /** Resolves when nothing is waiting or being read. */
  idle(): Promise<void>;
  /** Takes on nothing more and waits for the readings in progress. */
  stop(): Promise<void>;
}

export interface ReadingQueueOptions {
  db: Db;
  storage: Storage;
  engine: OcrEngine;
  concurrency: number;
  /** Stored files larger than this are not read. */
  maxBytes: number;
  log: { error(obj: object, msg: string): void };
  now?: () => Date;
}

/** Today's date in the UK, as YYYY-MM-DD: the reading uses it to refuse dates in the future. */
export function londonToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

class TooLarge extends Error {}

async function readAll(stream: Readable, maxBytes: number): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream) {
      const b = chunk as Buffer;
      size += b.length;
      if (size > maxBytes) throw new TooLarge();
      parts.push(b);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(parts);
}

export function startReadingQueue(opts: ReadingQueueOptions): ReadingQueue {
  const { db, storage, engine, log } = opts;
  const concurrency = Math.max(1, opts.concurrency);
  const now = opts.now ?? (() => new Date());
  const waiting: string[] = [];
  const running = new Set<Promise<void>>();
  let idleWaiters: (() => void)[] = [];
  let stopped = false;
  /** True until the readings left pending before this start have been loaded. */
  let loading = true;

  // Every update is conditional on the row still being `pending`: a reading deleted, confirmed or started again
  // meanwhile is left alone, and a row is never re-created.
  const finish = async (id: string, set: Partial<typeof receiptReadings.$inferInsert>): Promise<void> => {
    await db.update(receiptReadings).set({ ...set, updatedAt: sql`clock_timestamp()` })
      .where(and(eq(receiptReadings.id, id), eq(receiptReadings.status, 'pending')));
  };

  async function readOne(id: string): Promise<void> {
    const [reading] = await db.select().from(receiptReadings).where(and(eq(receiptReadings.id, id), eq(receiptReadings.status, 'pending')));
    if (!reading) return;
    const [file] = await db.select().from(files).where(eq(files.id, reading.fileId));
    if (!file) return;
    try {
      if (file.size > opts.maxBytes) throw new TooLarge();
      const bytes = await readAll(storage.get(file.storageKey), opts.maxBytes);
      const result = await engine.read({ bytes, type: file.contentType as OcrInputType });
      const proposal = readReceipt(result, londonToday(now()));
      await finish(id, { status: 'read', engine: result.engine, proposal, problem: null, readAt: now() });
    } catch (e) {
      if (e instanceof UnreadableError) {
        await finish(id, { status: 'unreadable', engine: engine.id, proposal: null, problem: e.userMessage, readAt: now() });
      } else if (e instanceof TooLarge) {
        await finish(id, { status: 'unreadable', engine: null, proposal: null, problem: TOO_LARGE_PROBLEM, readAt: now() });
      } else {
        // The error's message may quote the receipt, so only its name is logged.
        log.error({ readingId: id, errName: (e as { name?: string } | null)?.name ?? 'unknown' }, 'A receipt could not be read automatically');
        await finish(id, { status: 'unreadable', engine: engine.id, proposal: null, problem: GENERAL_PROBLEM, readAt: now() });
      }
    }
  }

  const settleIdle = (): void => {
    if (waiting.length > 0 || running.size > 0 || loading) return;
    const ws = idleWaiters;
    idleWaiters = [];
    for (const w of ws) w();
  };

  const pump = (): void => {
    while (!stopped && running.size < concurrency && waiting.length > 0) {
      const id = waiting.shift() as string;
      const p: Promise<void> = readOne(id)
        .catch((e: unknown) => {
          // A database failure while saving: the row stays pending and is read again after the next start.
          log.error({ readingId: id, errName: (e as { name?: string } | null)?.name ?? 'unknown' }, 'A receipt reading could not be saved');
        })
        .finally(() => {
          running.delete(p);
          pump();
          settleIdle();
        });
      running.add(p);
    }
  };

  const loaded: Promise<void> = db.select({ id: receiptReadings.id }).from(receiptReadings).where(eq(receiptReadings.status, 'pending'))
    .orderBy(asc(receiptReadings.createdAt), asc(receiptReadings.id))
    .then((rows) => {
      if (stopped) return;
      // Readings left from before go first (they are older); any enqueued while loading follow.
      const early = waiting.splice(0);
      const ids = rows.map((r) => r.id);
      waiting.push(...ids, ...early.filter((id) => !ids.includes(id)));
    })
    .catch((e: unknown) => { log.error({ errName: (e as { name?: string } | null)?.name ?? 'unknown' }, 'The waiting receipt readings could not be loaded'); })
    .finally(() => {
      loading = false;
      pump();
      settleIdle();
    });

  return {
    enqueue(id) {
      if (stopped || waiting.includes(id)) return;
      waiting.push(id);
      // While the start-up load is running the order is settled by it; afterwards a new reading starts straight away.
      if (!loading) pump();
    },
    idle() {
      if (waiting.length === 0 && running.size === 0 && !loading) return Promise.resolve();
      if (stopped && running.size === 0 && !loading) return Promise.resolve();
      return new Promise<void>((resolve) => { idleWaiters.push(resolve); });
    },
    async stop() {
      stopped = true;
      waiting.length = 0;
      await loaded;
      while (running.size > 0) await Promise.allSettled([...running]);
      settleIdle();
    },
  };
}
