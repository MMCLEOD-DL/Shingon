/**
 * Receipt readings: the actor-first repository. A reading follows its file's rules (Ruling 6): asking for one needs edit
 * rights on the file (others get 404, as with attachFile), seeing one follows the file's visibility, and confirming needs
 * edit rights (a manager who can see it gets 403). Nothing but the proposed fields, the confirmed values and the names of
 * the corrected fields is ever stored or audited (Ruling 5).
 */
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { correctedFields, type ConfirmReadingInput, type ReadingView } from '@hf/shared';
import type { Actor } from '../../auth/sessions.js';
import type { Db, Tx } from '../../db/client.js';
import { files, receiptReadings, type ReadingRow } from '../../db/schema/index.js';
import { canEdit, visibleTo } from '../../access/scope.js';
import { audit } from '../../audit/audit.js';
import { attachFile } from '../../files/repo.js';
import { conflict, forbidden, notFound } from '../../http/errors.js';

/** The attachment type a file gets when a reading uses it, so the orphan sweep keeps it (Ruling P1). */
export const READING_PARENT_TYPE = 'receipt-reading';

export const ALREADY_CONFIRMED = 'This receipt has already been confirmed.';
export const STILL_READING = 'Still reading this receipt. Try again in a moment.';

export interface ReadingDeps { ip?: string; now?: Date }

const stamp = (now?: Date): SQL | Date => now ?? sql`clock_timestamp()`;
const visible = (actor: Actor): SQL | undefined => visibleTo(actor, { owner: receiptReadings.ownerId, team: receiptReadings.teamId });
const auditCtx = (actor: Actor, deps: ReadingDeps) => ({ actor, ...(deps.ip === undefined ? {} : { ip: deps.ip }) });

export function toReadingView(r: ReadingRow): ReadingView {
  return {
    id: r.id, fileId: r.fileId, status: r.status, engine: r.engine, proposal: r.proposal, problem: r.problem,
    confirmed: r.confirmed, corrected: r.corrected, ownerId: r.ownerId,
    createdAt: r.createdAt.toISOString(), confirmedAt: r.confirmedAt?.toISOString() ?? null,
  };
}

export async function getReading(db: Db | Tx, actor: Actor, id: string): Promise<ReadingView | null> {
  const [row] = await db.select().from(receiptReadings).where(and(eq(receiptReadings.id, id), visible(actor)));
  return row ? toReadingView(row) : null;
}

/**
 * Starts (or starts again) the reading of a file and returns it as `pending`; the caller hands its id to the queue.
 * The file must be one the actor can see and change, otherwise 404. A confirmed reading is never read again (409).
 * The file is attached to the reading in the same transaction.
 */
export async function requestReading(db: Db, actor: Actor, fileId: string, deps: ReadingDeps = {}): Promise<ReadingView> {
  return db.transaction(async (tx) => {
    const [file] = await tx.select().from(files)
      .where(and(eq(files.id, fileId), visibleTo(actor, { owner: files.ownerId, team: files.teamId }))).for('update');
    if (!file || !canEdit(actor, file)) throw notFound("We couldn't find that file.");
    const [existing] = await tx.select().from(receiptReadings).where(eq(receiptReadings.fileId, file.id)).for('update');
    if (existing?.status === 'confirmed') throw conflict(ALREADY_CONFIRMED);
    let row: ReadingRow | undefined;
    if (existing) {
      [row] = await tx.update(receiptReadings)
        .set({ status: 'pending', engine: null, proposal: null, problem: null, readAt: null, updatedAt: stamp(deps.now) })
        .where(eq(receiptReadings.id, existing.id)).returning();
    } else {
      // Owner and team come from the file, never from the request or the actor (an admin may ask on someone's behalf).
      [row] = await tx.insert(receiptReadings).values({
        fileId: file.id, ownerId: file.ownerId, teamId: file.teamId, status: 'pending', createdAt: stamp(deps.now), updatedAt: stamp(deps.now),
      }).returning();
    }
    if (!row) throw new Error('The reading was not saved.');
    await attachFile(tx, actor, file.id, { type: READING_PARENT_TYPE, id: row.id });
    await audit(tx, auditCtx(actor, deps), { action: 'reading.requested', targetType: 'file', targetId: file.id, details: { readingId: row.id } });
    return toReadingView(row);
  });
}

/**
 * Records what a person confirmed. 404 when the actor cannot see the reading, 403 when they can see it but may not change it,
 * 409 while it is still being read or once it has been confirmed. The audit row holds the corrected field names only.
 */
export async function confirmReading(db: Db, actor: Actor, id: string, input: ConfirmReadingInput, deps: ReadingDeps = {}): Promise<ReadingView> {
  return db.transaction(async (tx) => {
    const [current] = await tx.select().from(receiptReadings).where(and(eq(receiptReadings.id, id), visible(actor))).for('update');
    if (!current) throw notFound();
    if (!canEdit(actor, current)) throw forbidden();
    if (current.status === 'pending') throw conflict(STILL_READING);
    if (current.status === 'confirmed') throw conflict(ALREADY_CONFIRMED);
    const confirmed = { amountPence: input.amountPence, vatPence: input.vatPence, date: input.date, merchant: input.merchant };
    const corrected = correctedFields(current.proposal, confirmed);
    const [row] = await tx.update(receiptReadings)
      .set({ status: 'confirmed', confirmed, corrected, confirmedAt: stamp(deps.now), updatedAt: stamp(deps.now) })
      .where(eq(receiptReadings.id, id)).returning();
    if (!row) throw notFound();
    await audit(tx, auditCtx(actor, deps), { action: 'reading.confirmed', targetType: 'reading', targetId: id, details: { corrected } });
    return toReadingView(row);
  });
}
