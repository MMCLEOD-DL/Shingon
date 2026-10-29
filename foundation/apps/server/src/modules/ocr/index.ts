/**
 * The OCR module on the server: receipt readings. Switched on only when app-profile.json lists `ocr`, decided once at
 * start-up (Ruling 7): otherwise no engine is made, no queue runs and no reading route exists.
 */
import type { FastifyInstance } from 'fastify';
import { chooseEngine, createAzureReceiptEngine, createLocalEngine, type CloudFailure, type EngineMakers, type OcrEngine } from '@hf/ocr';
import type { Config } from '../../config.js';
import { moduleOn } from '../../appProfile.js';
import type { Db } from '../../db/client.js';
import type { Storage } from '../../files/storage.js';
import { registerReadingRoutes } from './routes.js';
import { startReadingQueue, type ReadingQueue } from './queue.js';

export { startReadingQueue, londonToday, type ReadingQueue, type ReadingQueueOptions } from './queue.js';

/**
 * The receipt reader for this box, or null when the ocr module is off (nothing is made at all). Built only through
 * `chooseEngine`, which refuses (OcrPolicyError) any setting the data policy does not allow. A plain-http loopback
 * endpoint is a test stand-in only, so it is never allowed here, whatever the instance mode or `.env` say.
 */
export async function createReadingEngine(
  cfg: Pick<Config, 'profile' | 'ocr'>,
  opts: { onFallback?: (reason: CloudFailure) => void; makers?: EngineMakers } = {},
): Promise<OcrEngine | null> {
  if (!moduleOn(cfg, 'ocr')) return null;
  const makers: EngineMakers = opts.makers ?? {
    local: () => createLocalEngine({ workers: cfg.ocr.concurrency, timeoutMs: cfg.ocr.timeoutMs }),
    azure: createAzureReceiptEngine,
  };
  return chooseEngine(cfg.profile, cfg.ocr, makers, { allowHttpLoopback: false, ...(opts.onFallback ? { onFallback: opts.onFallback } : {}) });
}

/**
 * Starts the reading queue and registers the reading routes. The caller owns the engine and closes it after the app;
 * the queue is stopped when the app closes.
 */
export function registerOcrModule(
  app: FastifyInstance,
  deps: { config: Config; db: Db; storage: Storage; engine: OcrEngine; now?: () => Date },
): ReadingQueue {
  const queue = startReadingQueue({
    db: deps.db, storage: deps.storage, engine: deps.engine, concurrency: deps.config.ocr.concurrency,
    maxBytes: deps.config.uploadMaxBytes, log: app.log, ...(deps.now ? { now: deps.now } : {}),
  });
  app.addHook('onClose', async () => { await queue.stop(); });
  registerReadingRoutes(app, queue, deps.now);
  return queue;
}
