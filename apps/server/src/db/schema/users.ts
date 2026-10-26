import { pgTable, uuid, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { teams } from './teams.js';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Stored lower-cased and trimmed.
    email: text('email').notNull().unique(),
    name: text('name').notNull(),
    role: text('role', { enum: ['admin', 'manager', 'member'] }).notNull(),
    teamId: uuid('team_id').references(() => teams.id),
    // Null until an invite is accepted. A user with no password hash cannot hold a session.
    passwordHash: text('password_hash'),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [check('users_role_check', sql`${t.role} in ('admin','manager','member')`)],
);
