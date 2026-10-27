import { and, eq, isNull } from 'drizzle-orm';
import type { InviteInput } from '@hf/shared';
import type { Db, Tx } from '../db/client.js';
import { users } from '../db/schema/index.js';
import { audit } from '../audit/audit.js';
import { queueEmail } from '../email/index.js';
import { badRequest, conflict, HttpError } from '../http/errors.js';
import { checkPasswordRules, hashPassword } from './password.js';
import { createSession, type Actor } from './sessions.js';
import { checkTeamRule } from '../users/teamRule.js';
import { consumeToken, issueToken, peekToken, TOKEN_TTL } from './tokens.js';

export { TOKEN_TTL };

export const BAD_INVITE = 'This invite link has expired or has already been used. Ask your administrator to send a new one.';

export const inviteLink = (appOrigin: string, token: string): string => `${appOrigin}/accept-invite#${token}`;

/**
 * Creates a user with no password and queues their invite mail, all inside the caller's transaction.
 * Managers and members must belong to a team (an invite sets a role and a team together).
 */
export async function createInvite(
  tx: Tx,
  actor: Actor,
  input: InviteInput,
  opts: { appOrigin: string; now?: Date; ip?: string },
): Promise<{ userId: string }> {
  await checkTeamRule(tx, input.role, input.teamId);
  const [created] = await tx
    .insert(users)
    .values({ email: input.email, name: input.name, role: input.role, teamId: input.teamId })
    .onConflictDoNothing({ target: users.email })
    .returning({ id: users.id });
  if (!created) throw conflict('Someone with that email already has an account.');
  const token = await issueToken(tx, created.id, 'invite', opts.now);
  await queueEmail(tx, {
    to: input.email,
    template: 'invite',
    data: { name: input.name, inviterName: actor.name, link: inviteLink(opts.appOrigin, token) },
  });
  await audit(tx, { actor, ip: opts.ip }, {
    action: 'user.invited', targetType: 'user', targetId: created.id,
    details: { email: input.email, role: input.role, teamId: input.teamId },
  });
  return { userId: created.id };
}

/** Sends a fresh invite to someone who has not set a password yet. The earlier link stops working. */
export async function resendInvite(
  tx: Tx,
  actor: Actor,
  user: { id: string; email: string; name: string },
  opts: { appOrigin: string; now?: Date; ip?: string },
): Promise<void> {
  const token = await issueToken(tx, user.id, 'invite', opts.now);
  await queueEmail(tx, {
    to: user.email,
    template: 'invite',
    data: { name: user.name, inviterName: actor.name, link: inviteLink(opts.appOrigin, token) },
  });
  await audit(tx, { actor, ip: opts.ip }, {
    action: 'user.invited', targetType: 'user', targetId: user.id, details: { email: user.email, resent: true },
  });
}

/**
 * Sets the first password and signs the person in. The password rules are checked before the link is used up,
 * so a weak password does not burn it.
 */
export async function acceptInvite(
  db: Db,
  token: string,
  password: string,
  meta: { ip?: string; userAgent?: string; now?: Date },
): Promise<{ token: string; expiresAt: Date; user: Actor }> {
  const pending = await peekToken(db, token, 'invite', meta.now);
  if (!pending || pending.passwordHash !== null) throw new HttpError(400, BAD_INVITE);
  const problem = checkPasswordRules(password, pending.email);
  if (problem) throw badRequest(problem);
  const passwordHash = await hashPassword(password);

  return db.transaction(async (tx) => {
    const used = await consumeToken(tx, token, 'invite', meta.now);
    if (!used) throw new HttpError(400, BAD_INVITE);
    // Only an account that has no password yet can be activated, and never a disabled one.
    const [user] = await tx
      .update(users)
      .set({ passwordHash, updatedAt: meta.now ?? new Date() })
      .where(and(eq(users.id, used.userId), isNull(users.passwordHash), isNull(users.disabledAt)))
      .returning({ id: users.id, email: users.email, name: users.name, role: users.role, teamId: users.teamId });
    if (!user) throw new HttpError(400, BAD_INVITE);
    const who: Actor = { id: user.id, email: user.email, name: user.name, role: user.role, teamId: user.teamId };
    const session = await createSession(tx, user.id, { ...(meta.ip ? { ip: meta.ip } : {}), ...(meta.userAgent ? { userAgent: meta.userAgent } : {}) }, meta.now);
    await audit(tx, { actor: who, ip: meta.ip }, { action: 'user.invite_accepted', targetType: 'user', targetId: user.id });
    return { ...session, user: who };
  });
}
