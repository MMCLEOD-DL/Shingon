import { pgTable, uuid, text, jsonb, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// Written in the same transaction as the change that causes the mail. A sent row's data is cleared,
// so reset and invite links do not sit in the database after delivery.
export const emailOutbox = pgTable(
  'email_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toAddress: text('to_address').notNull(),
    template: text('template').notNull(),
    data: jsonb('data').$type<Record<string, string>>().notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (t) => [
    check('email_outbox_status_check', sql`${t.status} in ('pending','sent','failed')`),
    index('email_outbox_status_next_idx').on(t.status, t.nextAttemptAt),
  ],
);
