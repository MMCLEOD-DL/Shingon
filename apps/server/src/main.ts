import { ConfigError, loadConfig, type Config } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { buildApp } from './app.js';
import { ensureInstance, InstanceModeError } from './instance.js';

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
const fail = (what: string, e: unknown): never => {
  // One plain line, no stack trace, and never the error text itself: database messages can contain connection details.
  const code = (e as { code?: unknown } | null)?.code;
  console.error(`The app could not start: ${what}${typeof code === 'string' ? ` (${code})` : ''}. Check the database address and that the database is running.`);
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
  fail('it could not set up the database or the web server', e);
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
  fail(`it could not listen on port ${String(config.port)}`, e);
}
