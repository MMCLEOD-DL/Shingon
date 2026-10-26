import { ConfigError, loadConfig, type Config } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { buildApp } from './app.js';

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
// Development only. Production runs migrations through the separate `migrate` service.
if (process.env['RUN_MIGRATIONS'] === 'true') await runMigrations(db);

const app = await buildApp({ config, db });
const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

await app.listen({ host: '0.0.0.0', port: config.port });
