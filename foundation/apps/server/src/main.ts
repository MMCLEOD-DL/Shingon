import { ConfigError, loadConfig, type Config } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { buildApp } from './app.js';
import { ensureInstance, InstanceModeError } from './instance.js';
import { startFailure } from './startup.js';
import { OcrPolicyError, fallbackMessage, type OcrEngine } from '@hf/ocr';
import { createReadingEngine } from './modules/ocr/index.js';

let config: Config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(e.message);
    process.exit(1);
  }
  throw e;
}

let app: Awaited<ReturnType<typeof buildApp>> | undefined;

// The receipt reader, only when the ocr module is on. A setting the data policy does not allow stops the app here, before
// anything else starts, one plain sentence per problem (never the key or the address).
let ocrEngine: OcrEngine | null = null;
try {
  ocrEngine = await createReadingEngine(config, {
    // Each fall-back to the box is logged as a warning with its reason only (no key, address or receipt); a refused key or
    // endpoint (401/403) says so in plain words.
    onFallback: (reason) => { app?.log.warn({ reason }, fallbackMessage(reason)); },
  });
} catch (e) {
  if (e instanceof OcrPolicyError) {
    for (const problem of e.problems) console.error(problem);
    process.exit(1);
  }
  const code = (e as { code?: unknown } | null)?.code;
  console.error(`The app could not start: the receipt reader could not be started${typeof code === 'string' ? ` (${code})` : ''}. Check that the app was installed completely.`);
  process.exit(1);
}

const { db, close } = createDb(config.databaseUrl);
const fail = (stage: Parameters<typeof startFailure>[0], e: unknown): never => {
  console.error(startFailure(stage, e));
  process.exit(1);
};

try {
  // Development only. Production runs migrations through the separate `migrate` service.
  if (process.env['RUN_MIGRATIONS'] === 'true') await runMigrations(db);
  // A live database never starts as a demo, and one that held demo data never goes live (Ruling 11).
  await ensureInstance(db, config.instanceMode);
  app = await buildApp({ config, db, ocrEngine });
} catch (e) {
  if (e instanceof InstanceModeError) {
    console.error(e.message);
    process.exit(1);
  }
  fail({ setup: true }, e);
  throw e;
}
const running = app;
const shutdown = async () => {
  await running.close();
  await ocrEngine?.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

try {
  await running.listen({ host: '0.0.0.0', port: config.port });
} catch (e) {
  fail({ listen: config.port }, e);
}
