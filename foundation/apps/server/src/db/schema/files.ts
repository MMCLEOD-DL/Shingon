import { pgTable, uuid, text, integer, timestamp, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';
import { teams } from './teams.js';

// Bytes live on the storage volume under `storage_key` (random, never derived from the file name).
// `team_id` is the owner's team at upload time, so moving a person later does not move their old files.
export const files = pgTable(
  'files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull().references(() => users.id),
    teamId: uuid('team_id').references(() => teams.id),
    storageKey: text('storage_key').notNull().unique(),
    originalName: text('original_name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    sha256: text('sha256').notNull(),
    attachedType: text('attached_type'),
    attachedId: uuid('attached_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('files_name_length_check', sql`char_length(${t.originalName}) <= 200`),
    check('files_content_type_check', sql`${t.contentType} in ('image/jpeg','image/png','image/webp','image/heic','application/pdf')`),
    index('files_owner_id_idx').on(t.ownerId),
    index('files_team_id_idx').on(t.teamId),
    index('files_unattached_idx').on(t.createdAt).where(sql`${t.attachedType} is null`),
  ],
);
export type FileRow = typeof files.$inferSelect;
