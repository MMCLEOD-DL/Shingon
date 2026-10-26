import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createDb, type Db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { audit } from '../audit/audit.js';
import { inviteLink } from './invites.js';
import { issueToken } from './tokens.js';

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Creates the very first admin, with no password, and returns the link to set one. It refuses once any
 * admin exists. The lock makes two runs at the same moment safe. No mail is sent, so a fresh box needs none.
 */
export async function bootstrapAdmin(
  db: Db,
  cfg: Pick<Config, 'appOrigin'>,
  input: { email: string; name: string },
): Promise<{ link: string }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) throw new Error('That email address does not look right.');
  if (name.length < 1 || name.length > 100) throw new Error('The name must be between 1 and 100 characters.');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4242)`);
    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).limit(1);
    if (existing) throw new Error('An admin already exists. Use the app to invite more people.');
    const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
    if (taken) throw new Error('Someone with that email already has an account.');
    const [created] = await tx.insert(users).values({ email, name, role: 'admin', teamId: null }).returning({ id: users.id });
    if (!created) throw new Error('The admin could not be created.');
    const token = await issueToken(tx, created.id, 'invite');
    await audit(tx, { actor: null }, {
      action: 'user.invited', targetType: 'user', targetId: created.id, details: { email, role: 'admin', via: 'bootstrap-admin' },
    });
    return { link: inviteLink(cfg.appOrigin, token) };
  });
}

async function main(): Promise<number> {
  let values: { email?: string; name?: string };
  try {
    ({ values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } }, strict: true }));
  } catch {
    console.error('Usage: bootstrap-admin --email <email address> --name <full name>');
    return 1;
  }
  if (!values.email || !values.name) {
    console.error('Usage: bootstrap-admin --email <email address> --name <full name>');
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
    const { link } = await bootstrapAdmin(handle.db, config, { email: values.email, name: values.name });
    console.log(`Open this link within 7 days to set the admin password:\n${link}`);
    return 0;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    // Our own messages are plain English; anything else (a database error) is shown only as a fixed line.
    console.error(e instanceof Error && !code && e.name === 'Error' ? e.message : 'The admin could not be created. Check that the database is running and up to date.');
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
