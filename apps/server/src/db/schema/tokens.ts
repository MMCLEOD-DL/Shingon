import { pgTable, uuid, text, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

// Invite and password-reset links. Only the SHA-256 (hex) of the token is stored, never the token itself.
export const userTokens = pgTable(
  'user_tokens',
  {
    id: text('id').primaryKey(),
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['invite', 'reset'] }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('user_tokens_kind_check', sql`${t.kind} in ('invite','reset')`),
    index('user_tokens_user_kind_idx').on(t.userId, t.kind),
  ],
);
