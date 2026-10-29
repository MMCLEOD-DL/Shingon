import { createDb, runMigrations } from './client.js';

async function main(): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('The database update failed: DATABASE_URL is missing.');
    return 1;
  }
  const handle = createDb(url);
  const { db } = handle;
  try {
    await runMigrations(db);
    return 0;
  } catch (e) {
    console.error(`The database update failed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

process.exitCode = await main();
