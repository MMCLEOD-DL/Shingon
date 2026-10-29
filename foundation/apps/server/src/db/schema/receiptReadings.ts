import { pgTable, uuid, text, timestamp, jsonb, index, check } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { ConfirmedReceipt, ReceiptField, ReceiptProposal } from '@hf/shared';
import { users } from './users.js';
import { files } from './files.js';

export const READING_STATUSES = ['pending', 'read', 'unreadable', 'confirmed'] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

// A receipt reading (OCR module). It belongs to one uploaded file and goes with it (on delete cascade). Owner and team are
// copied from the file, never taken from a request. Only the proposed fields, the confirmed values and the names of the
// corrected fields are kept: the recognised text of a receipt is never stored (Ruling 5).
export const receiptReadings = pgTable(
  'receipt_readings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    fileId: uuid('file_id').notNull().unique().references(() => files.id, { onDelete: 'cascade' }),
    ownerId: uuid('owner_id').notNull().references(() => users.id),
    teamId: uuid('team_id'),
    status: text('status', { enum: READING_STATUSES }).notNull(),
    engine: text('engine'),
    proposal: jsonb('proposal').$type<ReceiptProposal>(),
    problem: text('problem'),
    confirmed: jsonb('confirmed').$type<ConfirmedReceipt>(),
    corrected: text('corrected').array().$type<ReceiptField[]>().notNull().default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp('read_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [
    check('receipt_readings_status_check', sql`${t.status} in ('pending','read','unreadable','confirmed')`),
    index('receipt_readings_status_created_idx').on(t.status, t.createdAt),
  ],
);
export type ReadingRow = typeof receiptReadings.$inferSelect;
