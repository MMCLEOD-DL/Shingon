import { createHash, randomBytes } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import type { Role } from '@hf/shared';
import type { Db, Tx } from '../db/client.js';
import { sessions, users } from '../db/schema/index.js';

export const SESSION_COOKIE = 'hf_session';
export const SESSION_IDLE_MS = 7 * 86400e3;
export const SESSION_ABSOLUTE_MS = 30 * 86400e3;
/** last_seen_at is only rewritten when it is older than this, to avoid a write on every request. */
const TOUCH_AFTER_MS = 5 * 60e3;

export interface Actor { id: string; email: string; name: string; role: Role; teamId: string | null }

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  db: Db | Tx,
  userId: string,
  meta: { ip?: string; userAgent?: string },
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await db.insert(sessions).values({
    id: hashToken(token),
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    ip: meta.ip ?? null,
    userAgent: meta.userAgent?.slice(0, 512) ?? null,
  });
  return { token, expiresAt };
}

/**
 * Every request loads its session from the database, so disabling a user or changing their role
 * takes effect on their very next request. Any session that fails a check is deleted.
 */
export async function loadSession(db: Db, token: string, now: Date = new Date()): Promise<{ actor: Actor; sessionId: string } | null> {
  const sessionId = hashToken(token);
  const [row] = await db
    .select({
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      id: users.id, email: users.email, name: users.name, role: users.role, teamId: users.teamId,
      disabledAt: users.disabledAt, passwordHash: users.passwordHash,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!row) return null;

  const nowMs = now.getTime();
  const invalid =
    nowMs > row.expiresAt.getTime() ||
    nowMs - row.lastSeenAt.getTime() > SESSION_IDLE_MS ||
    row.disabledAt !== null ||
    row.passwordHash === null;
  if (invalid) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }
  if (nowMs - row.lastSeenAt.getTime() > TOUCH_AFTER_MS) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
  }
  return {
    sessionId,
    actor: { id: row.id, email: row.email, name: row.name, role: row.role, teamId: row.teamId },
  };
}

/** Deletes a user's sessions (all of them, or all but one). Returns how many were removed. */
export async function revokeSessions(db: Db | Tx, userId: string, opts: { exceptSessionId?: string } = {}): Promise<number> {
  const where = opts.exceptSessionId === undefined
    ? eq(sessions.userId, userId)
    : and(eq(sessions.userId, userId), ne(sessions.id, opts.exceptSessionId));
  const removed = await db.delete(sessions).where(where).returning({ id: sessions.id });
  return removed.length;
}
