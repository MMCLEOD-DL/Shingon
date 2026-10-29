import type { WorldActor, WorldResource } from './world.js';

/**
 * Who may see what, typed out by hand from the spec's policy (Ruling 3).
 * It deliberately does not import or call src/access/scope.ts (canSee, visibleTo), so a mistake there cannot hide here.
 */
export function sees(a: WorldActor, r: WorldResource): boolean {
  if (a.role === null || a.id === null) return false;
  if (a.role === 'admin') return true;
  if (r.type === 'team') return a.teamId !== null && a.teamId === r.id;
  if (r.type === 'user') return (a.role === 'manager' && a.teamId !== null && r.teamId === a.teamId) || r.id === a.id;
  // Notes, files and every client resource.
  return (a.role === 'manager' && a.teamId !== null && r.teamId === a.teamId) || r.ownerId === a.id;
}
