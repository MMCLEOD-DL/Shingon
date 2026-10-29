import { pgTable, bigserial, uuid, text, timestamp, jsonb, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Append-only: a database trigger (see the audit_append_only migration) refuses UPDATE, DELETE and TRUNCATE.
// Users are disabled, never deleted, so actor_id is `no action` (index Ruling 12).
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'no action' }),
    // The email at the time of the action, or 'system' / 'anonymous'.
    actorLabel: text('actor_label').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
    ip: text('ip'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at.desc()),
    index('audit_log_actor_id_idx').on(t.actorId),
    index('audit_log_action_idx').on(t.action),
  ],
);
