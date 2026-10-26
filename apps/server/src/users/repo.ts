import { asc, and, eq } from 'drizzle-orm';
import type { TeamView, UserView } from '@hf/shared';
import type { Actor } from '../auth/sessions.js';
import type { Db } from '../db/client.js';
import { teams, users } from '../db/schema/index.js';
import { visibleTo } from '../access/scope.js';

const userCols = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  teamId: users.teamId,
  teamName: teams.name,
  disabledAt: users.disabledAt,
  passwordHash: users.passwordHash,
};

type Row = { id: string; email: string; name: string; role: UserView['role']; teamId: string | null; teamName: string | null; disabledAt: Date | null; passwordHash: string | null };

/** Never includes the password hash. */
export function toUserView(r: Row): UserView {
  return {
    id: r.id, email: r.email, name: r.name, role: r.role, teamId: r.teamId, teamName: r.teamName,
    disabled: r.disabledAt !== null, activated: r.passwordHash !== null,
  };
}

// A user row's "owner" is the user themself.
const scope = (actor: Actor) => visibleTo(actor, { owner: users.id, team: users.teamId });

export async function listUsers(db: Db, actor: Actor): Promise<UserView[]> {
  const rows = await db.select(userCols).from(users).leftJoin(teams, eq(users.teamId, teams.id)).where(scope(actor)).orderBy(asc(users.name), asc(users.id));
  return rows.map(toUserView);
}

/** Null when the user does not exist or is outside the actor's visibility. */
export async function getUser(db: Db, actor: Actor, id: string): Promise<UserView | null> {
  const [row] = await db.select(userCols).from(users).leftJoin(teams, eq(users.teamId, teams.id)).where(and(eq(users.id, id), scope(actor)));
  return row ? toUserView(row) : null;
}

export async function listTeams(db: Db, actor: Actor): Promise<TeamView[]> {
  // Teams are not owned rows: an admin sees all, anyone else only their own team.
  if (actor.role !== 'admin' && !actor.teamId) return [];
  const where = actor.role === 'admin' || !actor.teamId ? undefined : eq(teams.id, actor.teamId);
  return db.select({ id: teams.id, name: teams.name }).from(teams).where(where).orderBy(asc(teams.name));
}
