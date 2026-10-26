import { eq } from 'drizzle-orm';
import type { InstanceMode } from './config.js';
import type { Db, Tx } from './db/client.js';
import { instanceSettings } from './db/schema/index.js';
import { audit } from './audit/audit.js';

export class InstanceModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceModeError';
  }
}

export type InstanceRow = typeof instanceSettings.$inferSelect;

/**
 * Records the mode this database starts in, and refuses the two combinations that must never happen (index Ruling 11):
 * a live database restarted as a demo, and a database that has held demo data (published accounts and password) going live.
 * There is no override. The row is locked for the rest of the transaction, so a seed and a promotion cannot interleave.
 */
export async function ensureInstanceTx(tx: Tx, mode: InstanceMode): Promise<InstanceRow> {
  await tx.insert(instanceSettings).values({ id: 1, mode }).onConflictDoNothing();
  const [row] = await tx.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).for('update');
  if (!row) throw new Error('The instance record is missing.');
  if (row.mode === 'production' && mode !== 'production') {
    throw new InstanceModeError('This database belongs to a live app (production). Start it with INSTANCE_MODE=production.');
  }
  if (mode === 'production' && row.mode !== 'production') {
    if (row.seededAt !== null) throw new InstanceModeError('This database holds demo data. Start the live app on a fresh database.');
    const [promoted] = await tx.update(instanceSettings).set({ mode: 'production' }).where(eq(instanceSettings.id, 1)).returning();
    await audit(tx, { actor: null }, { action: 'instance.promoted', details: { from: row.mode, to: 'production' } });
    return promoted ?? row;
  }
  return row;
}

export async function ensureInstance(db: Db, mode: InstanceMode): Promise<void> {
  await db.transaction(async (tx) => {
    await ensureInstanceTx(tx, mode);
  });
}

/** The stored row, or null on a database that has never been started. */
export async function readInstance(db: Db | Tx): Promise<InstanceRow | null> {
  const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1));
  return row ?? null;
}

