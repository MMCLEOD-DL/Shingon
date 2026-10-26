import { hashPassword } from '../../../src/auth/password.js';
import { teams, users } from '../../../src/db/schema/index.js';
import type { TestApp } from '../../helpers/testApp.js';
import type { IDS, WorldResource } from '../world.js';

// scrypt is slow on purpose: hash once and reuse the string on every reset.
let hashed: Promise<string> | undefined;
const passwordHash = (): Promise<string> => (hashed ??= hashPassword('correct horse battery'));

type UserKey = keyof (typeof IDS)['users'];
const PEOPLE: { key: UserKey; label: string; role: 'admin' | 'manager' | 'member'; team: 'north' | 'south' | null; activated: boolean; disabled?: boolean }[] = [
  { key: 'admin', label: 'Ada Admin', role: 'admin', team: null, activated: true },
  { key: 'northManager', label: 'Nina North', role: 'manager', team: 'north', activated: true },
  { key: 'northAlice', label: 'Alice North', role: 'member', team: 'north', activated: true },
  { key: 'northBob', label: 'Bob North', role: 'member', team: 'north', activated: true },
  { key: 'southManager', label: 'Sam South', role: 'manager', team: 'south', activated: true },
  { key: 'southCarol', label: 'Carol South', role: 'member', team: 'south', activated: true },
  // Disabled after his session is issued (see world.ts reset).
  { key: 'disabledDave', label: 'Dave North', role: 'member', team: 'north', activated: true },
  // Invited but never activated: a resource only, never an actor.
  { key: 'pendingPat', label: 'Pat North', role: 'member', team: 'north', activated: false },
  // Invited, never activated, then switched off: resending her invite must be refused (409).
  { key: 'disabledPenny', label: 'Penny North', role: 'member', team: 'north', activated: false, disabled: true },
];

export async function seedUsersAndTeams(t: TestApp, ids: typeof IDS): Promise<WorldResource[]> {
  const out: WorldResource[] = [];
  for (const [key, label] of [['north', 'North'], ['south', 'South']] as const) {
    const canary = `CANARY-team-${key}`;
    const id = ids.teams[key];
    await t.db.insert(teams).values({ id, name: `${label} ${canary}` });
    out.push({ type: 'team', key, id, ownerId: null, teamId: id, canary, table: 'teams' });
  }
  const hash = await passwordHash();
  for (const p of PEOPLE) {
    const canary = `CANARY-user-${p.key}`;
    const id = ids.users[p.key];
    const teamId = p.team === null ? null : ids.teams[p.team];
    await t.db.insert(users).values({
      // The canary is in the email too (lower-cased; the harness compares without case).
      id, email: `${canary.toLowerCase()}@hf.test`, name: `${p.label} ${canary}`, role: p.role, teamId,
      passwordHash: p.activated ? hash : null, disabledAt: p.disabled ? new Date() : null,
    });
    // A user row's owner is the user themself.
    out.push({ type: 'user', key: p.key, id, ownerId: id, teamId, canary, table: 'users' });
  }
  return out;
}
