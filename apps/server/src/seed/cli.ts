import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createDb } from '../db/client.js';
import { InstanceModeError } from '../instance.js';
import { seedDemo } from './demo.js';

async function main(): Promise<number> {
  let reset = false;
  try {
    ({ values: { reset = false } } = parseArgs({ options: { reset: { type: 'boolean' } }, strict: true }));
  } catch {
    console.error('Usage: seed:demo [--reset]');
    return 1;
  }
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : 'The settings could not be read.');
    return 1;
  }
  const handle = createDb(config.databaseUrl);
  try {
    const summary = await seedDemo(handle.db, config, { reset });
    console.log(summary.text);
    return 0;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    console.error(e instanceof InstanceModeError ? e.message : `Demo data could not be added${typeof code === 'string' ? ` (${code})` : ''}. Check that the database is running and up to date.`);
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
