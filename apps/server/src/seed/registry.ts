import type { Faker } from '@faker-js/faker';
import type { Role } from '@hf/shared';
import type { Tx } from '../db/client.js';
import type { Storage } from '../files/storage.js';

export interface SeedCtx {
  tx: Tx;
  storage: Storage;
  faker: Faker;
  now: Date;
  /** The published demo password. Hash it once (`ctx.passwordHash`), never per person. */
  password: string;
  passwordHash: string;
  /** Names like `'user:manager'` mapped to ids, so later seeders can find earlier rows. */
  created: Record<string, string[]>;
  /** What the summary reports. Seeders add to these. */
  counts: Record<string, number>;
  signIns: { email: string; role: Role; team: string | null }[];
  /** Keys of objects written to storage; removed again if the seeding transaction fails. */
  writtenKeys: string[];
}

export interface Seeder {
  name: string;
  order: number;
  run(ctx: SeedCtx): Promise<void>;
}

const seeders: Seeder[] = [];

/** A client feature adds its own seeder next to its code: `registerSeeder({ name, order, run })`, plus an import line in `seeders/index.ts`. */
export function registerSeeder(s: Seeder): void {
  const i = seeders.findIndex((x) => x.name === s.name);
  if (i >= 0) seeders.splice(i, 1);
  seeders.push(s);
}

export const registeredSeeders = (): Seeder[] => [...seeders].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
