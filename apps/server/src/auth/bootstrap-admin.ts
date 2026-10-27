import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { and, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { ConfigError, loadConfig, type Config } from '../config.js';
import { createDb, type Db } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { audit, EMAIL_SHAPE } from '../audit/audit.js';
import { inviteLink } from './invites.js';
import { resetLink } from './reset.js';
import { revokeSessions } from './sessions.js';
import { issueToken } from './tokens.js';

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
    const admins = await tx.select({ id: users.id, email: users.email, passwordHash: users.passwordHash }).from(users).where(eq(users.role, 'admin'));
    if (admins.length > 0) {
      // A lost link can be re-issued, but only while no admin has set a password and the email is one of theirs.
      const pending = admins.every((a) => a.passwordHash === null) ? admins.find((a) => a.email === email) : undefined;
      if (!pending) throw new Error('An admin already exists. Use the app to invite more people.');
      const fresh = await issueToken(tx, pending.id, 'invite');
      await audit(tx, { actor: null }, {
        action: 'user.invited', targetType: 'user', targetId: pending.id, details: { email, role: 'admin', via: 'bootstrap-admin', resent: true },
      });
      return { link: inviteLink(cfg.appOrigin, fresh) };
    }
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

export const NOT_LOCKED_OUT = 'An admin can still sign in (an account that is switched on and has a password), so recovery has been refused and nothing was changed. That admin can switch accounts back on and invite people in the app; a forgotten password can be reset from the sign-in page.';

/**
 * Lockout recovery (`bootstrap-admin --recover`): when no admin can sign in (every admin is switched off or has never set
 * a password), switches the named existing admin back on and returns a fresh link to set a password. Refused while any
 * admin is both switched on and activated, and for an email that is not an admin's. The admin's old sessions are ended
 * (they must not come back to life with the account), and the change is audited. No mail is sent: the box's mail may be
 * what is broken.
 */
export async function recoverAdmin(
  db: Db,
  cfg: Pick<Config, 'appOrigin'>,
  input: { email: string },
): Promise<{ link: string; kind: 'invite' | 'reset' }> {
  const email = input.email.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_SHAPE.test(email)) throw new Error('That email address does not look right.');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(4242)`);
    const [canSignIn] = await tx.select({ id: users.id }).from(users)
      .where(and(eq(users.role, 'admin'), isNull(users.disabledAt), isNotNull(users.passwordHash))).limit(1);
    if (canSignIn) throw new Error(NOT_LOCKED_OUT);
    const admins = await tx.select({ id: users.id, email: users.email, passwordHash: users.passwordHash, disabledAt: users.disabledAt }).from(users).where(eq(users.role, 'admin'));
    if (admins.length === 0) throw new Error('There is no admin yet, so there is nothing to recover. Create the first admin with bootstrap-admin --email <email address> --name <full name>.');
    const target = admins.find((a) => a.email === email);
    if (!target) throw new Error('That email address is not an admin\'s account, so nothing was changed. Recovery only works for an existing admin: give the email address of one.');
    const ref = { targetType: 'user', targetId: target.id } as const;
    const via = 'bootstrap-admin --recover';
    if (target.disabledAt !== null) {
      await tx.update(users).set({ disabledAt: null, updatedAt: new Date() }).where(eq(users.id, target.id));
      await audit(tx, { actor: null }, { action: 'user.enabled', ...ref, details: { via } });
    }
    await revokeSessions(tx, target.id);
    if (target.passwordHash === null) {
      // Never activated: the invite link sets the first password.
      const token = await issueToken(tx, target.id, 'invite');
      await audit(tx, { actor: null }, { action: 'user.invited', ...ref, details: { email, role: 'admin', via, resent: true } });
      return { link: inviteLink(cfg.appOrigin, token), kind: 'invite' };
    }
    const token = await issueToken(tx, target.id, 'reset');
    await audit(tx, { actor: null }, { action: 'auth.password_reset_requested', ...ref, details: { email, via } });
    return { link: resetLink(cfg.appOrigin, token), kind: 'reset' };
  });
}

const USAGE = [
  'Usage: bootstrap-admin --email <email address> --name <full name>',
  '       bootstrap-admin --recover --email <email address of an existing admin>',
  '         (only when no admin can sign in: switches that admin back on and prints a link to set a password)',
].join('\n');

async function main(): Promise<number> {
  let values: { email?: string; name?: string; recover?: boolean };
  try {
    ({ values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, recover: { type: 'boolean' } }, strict: true }));
  } catch {
    console.error(USAGE);
    return 1;
  }
  const recover = values.recover === true;
  if (!values.email || (recover ? values.name !== undefined : !values.name)) {
    console.error(USAGE);
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
    if (recover) {
      const { link, kind } = await recoverAdmin(handle.db, config, { email: values.email });
      console.log(kind === 'invite'
        ? `The admin account is switched on again. Open this link within 7 days to set its password:\n${link}`
        : `The admin account is switched on again. Open this link within 1 hour to set a new password (run this again for a fresh link if it runs out):\n${link}`);
      return 0;
    }
    const { link } = await bootstrapAdmin(handle.db, config, { email: values.email, name: values.name ?? '' });
    console.log(`Open this link within 7 days to set the admin password:\n${link}`);
    return 0;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    // Our own messages are plain English; anything else (a database error) is shown only as a fixed line.
    console.error(e instanceof Error && !code && e.name === 'Error' ? e.message
      : recover ? 'The admin could not be recovered. Check that the database is running and up to date.'
        : 'The admin could not be created. Check that the database is running and up to date.');
    return 1;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
