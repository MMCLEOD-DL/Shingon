import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';
import { files } from './files.js';

// The example resource. `team_id` is the owner's team when the note was written, so moving a person later does not move their old notes.
export const notes = pgTable(
  'notes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id').notNull().references(() => users.id),
    teamId: uuid('team_id'),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    attachmentFileId: uuid('attachment_file_id').references(() => files.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('notes_team_created_idx').on(t.teamId, t.createdAt.desc()),
    index('notes_owner_created_idx').on(t.ownerId, t.createdAt.desc()),
  ],
);
export type NoteRow = typeof notes.$inferSelect;
