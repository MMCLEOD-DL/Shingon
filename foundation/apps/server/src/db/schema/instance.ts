import { pgTable, integer, text, timestamp, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// One row. It is the database's memory of what it has been: the mode it started in and whether it ever held demo data.
// A trigger (see the instance_guard migration) stops it going backwards, and `wipeAllData` never truncates it.
export const instanceSettings = pgTable(
  'instance_settings',
  {
    id: integer('id').primaryKey().default(1),
    mode: text('mode', { enum: ['demo', 'production', 'test'] }).notNull(),
    seededAt: timestamp('seeded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (t) => [
    check('instance_settings_single_row', sql`${t.id} = 1`),
    check('instance_settings_mode_check', sql`${t.mode} in ('demo','production','test')`),
  ],
);
