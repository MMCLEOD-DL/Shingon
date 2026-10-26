import { eq } from 'drizzle-orm';
import type { Role } from '@hf/shared';
import type { TestApp } from '../helpers/testApp.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/sessions.js';
import { users } from '../../src/db/schema/index.js';
import { wipeAllData } from '../../src/db/wipe.js';
import { RESOURCE_SEEDERS } from './resources/index.js';

/** Everyone the harness signs in as. `anon` has no cookie; `disabledDave` holds a session issued before he was disabled. */
export const ACTORS = ['anon', 'admin', 'northManager', 'northAlice', 'northBob', 'southManager', 'southCarol', 'disabledDave'] as const;
export type ActorKey = (typeof ACTORS)[number];

export interface WorldActor { key: ActorKey; id: string | null; role: Role | null; teamId: string | null; cookie: string | null; signedIn: boolean }
export interface WorldResource { type: string; key: string; id: string; ownerId: string | null; teamId: string | null; canary: string; table: string }
export interface World { t: TestApp; actors: Record<ActorKey, WorldActor>; resources: Record<string, WorldResource[]>; reset(): Promise<void> }

/** Fixed ids, so a failure names the same rows on every run. */
export const IDS = {
  teams: {
    north: '7e000000-0000-4000-8000-000000000001',
    south: '7e000000-0000-4000-8000-000000000002',
  },
  users: {
    admin: '0a000000-0000-4000-8000-000000000001',
    northManager: '0a000000-0000-4000-8000-000000000002',
    northAlice: '0a000000-0000-4000-8000-000000000003',
    northBob: '0a000000-0000-4000-8000-000000000004',
    southManager: '0a000000-0000-4000-8000-000000000005',
    southCarol: '0a000000-0000-4000-8000-000000000006',
    disabledDave: '0a000000-0000-4000-8000-000000000007',
    pendingPat: '0a000000-0000-4000-8000-000000000008',
    disabledPenny: '0a000000-0000-4000-8000-000000000009',
  },
} as const satisfies { teams: { north: string; south: string }; users: Record<Exclude<ActorKey, 'anon'> | 'pendingPat' | 'disabledPenny', string> };

export const PASSWORD = 'correct horse battery';

const ACTOR_SHAPE: Record<ActorKey, { role: Role | null; teamId: string | null }> = {
  anon: { role: null, teamId: null },
  admin: { role: 'admin', teamId: null },
  northManager: { role: 'manager', teamId: IDS.teams.north },
  northAlice: { role: 'member', teamId: IDS.teams.north },
  northBob: { role: 'member', teamId: IDS.teams.north },
  southManager: { role: 'manager', teamId: IDS.teams.south },
  southCarol: { role: 'member', teamId: IDS.teams.south },
  disabledDave: { role: 'member', teamId: IDS.teams.north },
};

export async function buildWorld(t: TestApp): Promise<World> {
  const actors = Object.fromEntries(
    ACTORS.map((key) => [key, {
      key,
      id: key === 'anon' ? null : IDS.users[key],
      ...ACTOR_SHAPE[key],
      cookie: null,
      signedIn: key !== 'anon' && key !== 'disabledDave',
    } satisfies WorldActor]),
  ) as Record<ActorKey, WorldActor>;
  const resources: Record<string, WorldResource[]> = {};

  const world: World = {
    t,
    actors,
    resources,
    async reset() {
      await wipeAllData(t.db);

      for (const key of Object.keys(resources)) Reflect.deleteProperty(resources, key);
      for (const seed of RESOURCE_SEEDERS) {
        for (const r of await seed(t, IDS)) (resources[r.type] ??= []).push(r);
      }

      for (const key of ACTORS) {
        const a = actors[key];
        if (a.id === null) continue;
        const { token } = await createSession(t.db, a.id, {});
        a.cookie = `${SESSION_COOKIE}=${token}`;
      }
      // Dave's session was issued while he was still active; only then is he switched off.
      await t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, IDS.users.disabledDave));
    },
  };
  await world.reset();
  return world;
}
