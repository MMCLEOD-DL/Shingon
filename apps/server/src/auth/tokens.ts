import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { userTokens, users } from '../db/schema/index.js';
import { hashToken } from './sessions.js';

export type TokenKind = 'invite' | 'reset';

/** An invite lasts a week, a reset link one hour. */
export const TOKEN_TTL = { invite: 7 * 86400e3, reset: 60 * 60e3 } as const;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Makes a new single-use token for a user and deletes their earlier unused tokens of that kind,
 * so only the newest link ever works. Only the SHA-256 of the token is stored.
 * Call it inside the transaction that queues the mail.
 */
export async function issueToken(tx: Tx, userId: string, kind: TokenKind, now: Date = new Date()): Promise<string> {
  // Two requests for the same user at once are queued behind each other, so exactly one token survives.
  await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('update');
  await tx.delete(userTokens).where(and(eq(userTokens.userId, userId), eq(userTokens.kind, kind), isNull(userTokens.usedAt)));
  const token = randomBytes(32).toString('base64url');
  await tx.insert(userTokens).values({
    id: hashToken(token),
    userId,
    kind,
    expiresAt: new Date(now.getTime() + TOKEN_TTL[kind]),
    createdAt: now,
  });
  return token;
}

/**
 * Uses a token up. One atomic statement, so two requests with the same link cannot both succeed.
 * Returns null when the token is unknown, already used or expired.
 */
export async function consumeToken(db: Db | Tx, token: string, kind: TokenKind, now: Date = new Date()): Promise<{ userId: string } | null> {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db
    .update(userTokens)
    .set({ usedAt: now })
    .where(and(eq(userTokens.id, hashToken(token)), eq(userTokens.kind, kind), isNull(userTokens.usedAt), gt(userTokens.expiresAt, now)))
    .returning({ userId: userTokens.userId });
  return row ?? null;
}

/**
 * Looks at a token without using it (so a weak password can be refused without burning the link).
 * The account must not be disabled. consumeToken remains the only thing that grants anything.
 */
export async function peekToken(db: Db | Tx, token: string, kind: TokenKind, now: Date = new Date()) {
  if (!TOKEN_SHAPE.test(token)) return null;
  const [row] = await db
    .select({ userId: users.id, email: users.email, name: users.name, role: users.role, teamId: users.teamId, passwordHash: users.passwordHash })
    .from(userTokens)
    .innerJoin(users, eq(users.id, userTokens.userId))
    .where(and(
      eq(userTokens.id, hashToken(token)), eq(userTokens.kind, kind), isNull(userTokens.usedAt),
      gt(userTokens.expiresAt, now), isNull(users.disabledAt),
    ))
    .limit(1);
  return row ?? null;
}
