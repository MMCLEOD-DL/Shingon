import { ConfigError, loadConfig, type Config } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { buildApp } from './app.js';
import { ensureInstance, InstanceModeError } from './instance.js';
import { startFailure } from './startup.js';

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

const { db, close } = createDb(config.databaseUrl);
const fail = (stage: Parameters<typeof startFailure>[0], e: unknown): never => {
  console.error(startFailure(stage, e));
  process.exit(1);
};

let app: Awaited<ReturnType<typeof buildApp>>;
try {
  // Development only. Production runs migrations through the separate `migrate` service.
  if (process.env['RUN_MIGRATIONS'] === 'true') await runMigrations(db);
  // A live database never starts as a demo, and one that held demo data never goes live (Ruling 11).
  await ensureInstance(db, config.instanceMode);
  app = await buildApp({ config, db });
} catch (e) {
  if (e instanceof InstanceModeError) {
    console.error(e.message);
    process.exit(1);
  }
  fail({ setup: true }, e);
  throw e;
}
const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

try {
  await app.listen({ host: '0.0.0.0', port: config.port });
} catch (e) {
  fail({ listen: config.port }, e);
}
