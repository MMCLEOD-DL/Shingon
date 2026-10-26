import type { Db, Tx } from '../db/client.js';
import type { Actor } from '../auth/sessions.js';
import { auditLog } from '../db/schema/index.js';

export const AUDIT_ACTIONS = [
  'auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.password_changed',
  'auth.password_reset_requested', 'auth.password_reset',
  'user.invited', 'user.invite_accepted', 'user.updated', 'user.disabled', 'user.enabled',
  'team.created',
  'file.uploaded', 'file.downloaded', 'file.deleted',
  'note.created', 'note.updated', 'note.deleted',
  'seed.demo',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A password pasted into an email box must not reach the audit log, so only email-shaped input is kept. */
export const auditableEmail = (v: string): string => (v.length <= 254 && EMAIL_SHAPE.test(v) ? v : '[not an email address]');

const SECRET_KEY = /pass|token|secret|key/i;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

/** Masks values whose key looks like a secret. Recurses one level into plain objects. */
export function redactDetails(d: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (isPlainObject(v)) {
      const inner: Record<string, unknown> = {};
      for (const [ik, iv] of Object.entries(v)) inner[ik] = SECRET_KEY.test(ik) ? '[redacted]' : iv;
      out[k] = inner;
    } else out[k] = v;
  }
  return out;
}

/** Writes one audit row. Pass the transaction of the change being described so both commit or roll back together. */
export async function audit(
  db: Db | Tx,
  ctx: { actor: Actor | null; ip?: string },
  e: { action: AuditAction; targetType?: string; targetId?: string; details?: Record<string, unknown> },
): Promise<void> {
  await db.insert(auditLog).values({
    actorId: ctx.actor?.id ?? null,
    actorLabel: ctx.actor?.email ?? (e.action.startsWith('auth.') ? 'anonymous' : 'system'),
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    details: redactDetails(e.details ?? {}),
    ip: ctx.ip ?? null,
  });
}
