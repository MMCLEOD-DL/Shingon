import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { userTokens, users } from '../db/schema/index.js';
import { audit, auditableEmail } from '../audit/audit.js';
import { queueEmail } from '../email/index.js';
import { badRequest, HttpError } from '../http/errors.js';
import { checkPasswordRules, hashPassword, verifyPassword } from './password.js';
import { revokeSessions, type Actor } from './sessions.js';
import { consumeToken, issueToken, peekToken, TOKEN_TTL } from './tokens.js';

export { TOKEN_TTL };

export const BAD_RESET = 'This reset link has expired or has already been used. Ask for a new one.';

export const resetLink = (appOrigin: string, token: string): string => `${appOrigin}/reset-password#${token}`;

/**
 * Mails a reset link to an active account that has set a password. It does the same for every email
 * address as far as the caller can tell: nothing is returned and nothing is thrown for an unknown address.
 * The audit row is internal and always written.
 */
export async function requestPasswordReset(
  db: Db,
  email: string,
  opts: { now?: Date; appOrigin: string; ip?: string },
): Promise<void> {
  const address = email.trim().toLowerCase();
  await db.transaction(async (tx) => {
    const [user] = await tx
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(eq(users.email, address), isNull(users.disabledAt), isNotNull(users.passwordHash)))
      .limit(1);
    if (user) {
      const token = await issueToken(tx, user.id, 'reset', opts.now);
      await queueEmail(tx, { to: user.email, template: 'password-reset', data: { name: user.name, link: resetLink(opts.appOrigin, token) } });
    }
    await audit(tx, { actor: null, ip: opts.ip }, {
      action: 'auth.password_reset_requested',
      ...(user ? { targetType: 'user', targetId: user.id } : {}),
      details: { email: auditableEmail(address) },
    });
  });
}

/**
 * Sets a new password with a reset link, then signs the person out everywhere.
 * The password rules are checked before the link is used up, so a weak password does not burn it.
 */
export async function resetPassword(
  db: Db,
  token: string,
  password: string,
  opts: { now?: Date; ip?: string } = {},
): Promise<void> {
  const pending = await peekToken(db, token, 'reset', opts.now);
  if (!pending || pending.passwordHash === null) throw new HttpError(400, BAD_RESET);
  const problem = checkPasswordRules(password, pending.email);
  if (problem) throw badRequest(problem);
  const passwordHash = await hashPassword(password);

  await db.transaction(async (tx) => {
    const used = await consumeToken(tx, token, 'reset', opts.now);
    if (!used) throw new HttpError(400, BAD_RESET);
    const [user] = await tx
      .update(users)
      .set({ passwordHash, updatedAt: opts.now ?? new Date() })
      .where(and(eq(users.id, used.userId), isNull(users.disabledAt), isNotNull(users.passwordHash)))
      .returning({ id: users.id, email: users.email, name: users.name, role: users.role, teamId: users.teamId });
    if (!user) throw new HttpError(400, BAD_RESET);
    await revokeSessions(tx, user.id);
    // Any other unused reset link for this person is dead too.
    await tx.delete(userTokens).where(and(eq(userTokens.userId, user.id), eq(userTokens.kind, 'reset'), isNull(userTokens.usedAt)));
    await queueEmail(tx, { to: user.email, template: 'password-changed', data: { name: user.name } });
    await audit(tx, { actor: user, ip: opts.ip }, { action: 'auth.password_reset', targetType: 'user', targetId: user.id });
  });
}

/** Changes your own password. Your other sessions end; the one you are using stays. */
export async function changePassword(
  db: Db,
  actor: Actor,
  sessionId: string | null,
  input: { currentPassword: string; newPassword: string },
  opts: { ip?: string; now?: Date } = {},
): Promise<void> {
  const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, actor.id)).limit(1);
  if (!row?.passwordHash || !(await verifyPassword(input.currentPassword, row.passwordHash))) {
    throw badRequest('Your current password is not right.');
  }
  const problem = checkPasswordRules(input.newPassword, actor.email);
  if (problem) throw badRequest(problem);
  const passwordHash = await hashPassword(input.newPassword);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash, updatedAt: opts.now ?? new Date() }).where(eq(users.id, actor.id));
    await revokeSessions(tx, actor.id, sessionId === null ? {} : { exceptSessionId: sessionId });
    await queueEmail(tx, { to: actor.email, template: 'password-changed', data: { name: actor.name } });
    await audit(tx, { actor, ip: opts.ip }, { action: 'auth.password_changed', targetType: 'user', targetId: actor.id });
  });
}
