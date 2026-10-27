import { eq } from 'drizzle-orm';
import type { Role } from '@hf/shared';
import type { Db, Tx } from '../db/client.js';
import { teams } from '../db/schema/index.js';
import { badRequest } from '../http/errors.js';

/**
 * The one team rule, shared by inviting someone and by changing a person's role or team: managers and members must belong
 * to a team (an admin may have none), and a team that is named must exist. Throws a plain 400.
 */
export async function checkTeamRule(db: Db | Tx, role: Role, teamId: string | null): Promise<void> {
  if ((role === 'manager' || role === 'member') && teamId === null) throw badRequest('Managers and members must belong to a team.');
  if (teamId !== null) {
    const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId));
    if (!team) throw badRequest("That team doesn't exist.");
  }
}
