// EVERY repository function that returns client rows takes `actor` first and applies `visibleTo`.
// Visibility: admin sees everything, a manager sees their team (and their own rows), a member sees their own rows.
// Edits: the owner or an admin. A manager can view but not edit team rows.
import { eq, or, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Actor } from '../auth/sessions.js';

/** A WHERE clause limiting rows to those the actor may see. `undefined` means no filter (admin). */
export function visibleTo(actor: Actor, cols: { owner: PgColumn; team: PgColumn }): SQL | undefined {
  if (actor.role === 'admin') return undefined;
  if (actor.role === 'manager' && actor.teamId) return or(eq(cols.team, actor.teamId), eq(cols.owner, actor.id));
  return eq(cols.owner, actor.id);
}

/** The same rules as `visibleTo`, for a row that is already loaded. */
export function canSee(actor: Actor, row: { ownerId: string; teamId: string | null }): boolean {
  if (actor.role === 'admin') return true;
  if (row.ownerId === actor.id) return true;
  return actor.role === 'manager' && actor.teamId !== null && row.teamId === actor.teamId;
}

/** Owner or admin only. Managers do not edit team rows. */
export function canEdit(actor: Actor, row: { ownerId: string }): boolean {
  return actor.role === 'admin' || row.ownerId === actor.id;
}

