/**
 * The app the browser tests run against: a private, seeded database, the built web app, and mail written to files.
 * Test tooling only. It refuses to start without TEST_DATABASE_URL and always works on a database it created itself.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { buildApp } from './app.js';
import { hashPassword } from './auth/password.js';
import { loadConfig } from './config.js';
import { createDb, runMigrations } from './db/client.js';
import { teams, users } from './db/schema/index.js';
import { ensureInstance } from './instance.js';
import { seedDemo } from './seed/demo.js';

const PORT = 4319;
const ORIGIN = `http://localhost:${String(PORT)}`;
const SEED_NOW = new Date('2026-11-01T12:00:00Z');
/** The browser projects that run the journeys; each gets its own account so they never touch the same person. */
const FLOW_PROJECTS = ['desktop-chromium', 'mobile-chromium'] as const;

const adminUrl = process.env['TEST_DATABASE_URL'];
const mailDir = process.env['HF_E2E_MAIL_DIR'];
if (!adminUrl || !mailDir) {
  console.error('The browser tests need TEST_DATABASE_URL (a Postgres role that may create databases) and HF_E2E_MAIL_DIR (a folder for the mail files).');
  process.exit(1);
}

const dbName = `hf_e2e_${randomBytes(8).toString('hex')}`;
const withAdmin = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
  const c = new pg.Client({ connectionString: adminUrl });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
};
const dropDb = (): Promise<unknown> => withAdmin((c) => c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`));

const uploadDir = await mkdtemp(path.join(tmpdir(), 'hf-e2e-uploads-'));
await rm(mailDir, { recursive: true, force: true });
await mkdir(mailDir, { recursive: true });

await withAdmin((c) => c.query(`CREATE DATABASE ${dbName} ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`));
const dbUrl = new URL(adminUrl);
dbUrl.pathname = `/${dbName}`;

let handle: ReturnType<typeof createDb> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let cleaning: Promise<void> | undefined;
const cleanup = (): Promise<void> => {
  cleaning ??= (async () => {
    await app?.close().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await dropDb().catch(() => undefined);
    await rm(uploadDir, { recursive: true, force: true }).catch(() => undefined);
  })();
  return cleaning;
};
const stop = (): void => { void cleanup().then(() => process.exit(0)); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  const config = loadConfig({
    INSTANCE_MODE: 'demo', // a demo database can never be promoted to production; 'test' would switch the mail worker off
    APP_ORIGIN: ORIGIN,
    PORT: String(PORT),
    DATABASE_URL: dbUrl.toString(),
    TRUST_PROXY_HOPS: '0',
    UPLOAD_DIR: uploadDir,
    EMAIL_TRANSPORT: 'file',
    EMAIL_FILE_DIR: mailDir,
    EMAIL_POLL_MS: '300',
    EMAIL_FROM: 'Highland App <app@demo.test>',
    WEB_DIST_DIR: path.resolve(import.meta.dirname, '../../web/dist'),
  });
  handle = createDb(config.databaseUrl);
  const { db } = handle;
  await runMigrations(db);
  await ensureInstance(db, config.instanceMode);
  const summary = await seedDemo(db, config, { now: SEED_NOW });

  // The journeys' own accounts, added after the seed so they are not in its sign-in list.
  const [ops] = await db.select({ id: teams.id }).from(teams).where(eq(teams.name, 'Operations'));
  if (!ops) throw new Error('The Operations team was not seeded.');
  const passwordHash = await hashPassword(summary.password);
  for (const project of FLOW_PROJECTS) {
    const label = project.split('-').map((w) => `${w.slice(0, 1).toUpperCase()}${w.slice(1)}`).join(' ');
    await db.insert(users).values({ email: `flow.${project}@demo.test`, name: `Flow ${label}`, role: 'member', teamId: ops.id, passwordHash });
  }

  app = await buildApp({ config, db });
  await app.listen({ host: 'localhost', port: PORT });
  console.log(`Browser-test app ready at ${ORIGIN} (database ${dbName}).`);
} catch (e) {
  const code = (e as { code?: unknown } | null)?.code;
  console.error(`The browser-test app could not start${typeof code === 'string' ? ` (${code})` : ''}: ${e instanceof Error ? e.message : 'unknown problem'}`);
  await cleanup();
  process.exit(1);
}
