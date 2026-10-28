import { fakerEN_GB } from '@faker-js/faker';
import { eq } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { files, instanceSettings } from '../db/schema/index.js';
import { wipeAllData } from '../db/wipe.js';
import { hashPassword } from '../auth/password.js';
import { audit } from '../audit/audit.js';
import { LocalDiskStorage } from '../files/storage.js';
import { ensureInstanceTx, InstanceModeError } from '../instance.js';
import { registeredSeeders, type SeedCtx } from './registry.js';
import './seeders/index.js';

export { registerSeeder } from './registry.js';
export type { SeedCtx } from './registry.js';

export const DEMO_SEED = 42;
export const DEFAULT_DEMO_PASSWORD = 'demo-password-1';

export interface SeedSummary {
  alreadySeeded: boolean;
  counts: Record<string, number>;
  signIns: { email: string; role: 'admin' | 'manager' | 'member'; team: string | null }[];
  password: string;
  text: string;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

function summaryText(counts: Record<string, number>, signIns: SeedSummary['signIns'], password: string): string {
  const c = (k: string) => counts[k] ?? 0;
  return [
    `Demo data added: ${plural(c('teams'), 'team', 'teams')}, ${plural(c('people'), 'person', 'people')}, ${plural(c('notes'), 'note', 'notes')}, ${plural(c('files'), 'attached photo', 'attached photos')}.`,
    `Sign in with any of these (password: ${password}):`,
    ...signIns.map((s) => `  ${s.email} (${s.role}${s.team ? `, ${s.team}` : ''})`),
  ].join('\n');
}

/**
 * Fills a demo or test app with invented data. Three guards: a live config refuses, a database that ever went live refuses
 * (`ensureInstanceTx`), and a database that gets seeded can never be promoted to production. Runs in one transaction; with
 * `reset` it first wipes everything except the instance record. Client data never goes through here: demo data only.
 */
export async function seedDemo(db: Db, cfg: Config, opts: { reset?: boolean; now?: Date } = {}): Promise<SeedSummary> {
  if (cfg.instanceMode === 'production') throw new InstanceModeError('Demo data can only be added to a demo or test app, never a live one.');
  if (opts.reset && cfg.instanceMode !== 'demo') throw new InstanceModeError('Starting again with --reset is only allowed in a demo app.');
  const password = process.env['DEMO_PASSWORD'] || DEFAULT_DEMO_PASSWORD;
  const now = opts.now ?? new Date();
  const storage = new LocalDiskStorage(cfg.uploadDir);

  const passwordHash = await hashPassword(password);
  const faker = fakerEN_GB;
  const ctx: Omit<SeedCtx, 'tx'> = { storage, faker, now, password, passwordHash, created: {}, counts: {}, signIns: [], writtenKeys: [], profile: cfg.profile };
  let oldKeys: string[] = [];
  try {
    const result = await db.transaction(async (tx) => {
      // Locks the instance row, so a seed and a promotion to production cannot interleave.
      const instance = await ensureInstanceTx(tx, cfg.instanceMode);
      if (instance.seededAt !== null && !opts.reset) return 'already' as const;
      if (opts.reset) {
        oldKeys = (await tx.select({ key: files.storageKey }).from(files)).map((r) => r.key);
        await wipeAllData(tx);
      }
      faker.seed(DEMO_SEED);
      const full: SeedCtx = { ...ctx, tx };
      for (const s of registeredSeeders()) await s.run(full);
      await tx.update(instanceSettings).set({ seededAt: now }).where(eq(instanceSettings.id, 1));
      await audit(tx, { actor: null }, { action: 'seed.demo', details: { ...full.counts, reset: opts.reset === true } });
      return 'seeded' as const;
    });
    if (result === 'already') {
      return { alreadySeeded: true, counts: {}, signIns: [], password, text: 'Demo data is already in place. Use --reset to start again.' };
    }
  } catch (e) {
    // The rows rolled back, so the objects written for them must go too.
    for (const key of ctx.writtenKeys) await storage.delete(key).catch(() => undefined);
    throw e;
  }
  // Objects of the files the reset wiped. Best effort: the disk-side sweep removes anything left.
  for (const key of oldKeys) await storage.delete(key).catch(() => undefined);
  return { alreadySeeded: false, counts: ctx.counts, signIns: ctx.signIns, password, text: summaryText(ctx.counts, ctx.signIns, password) };
}
