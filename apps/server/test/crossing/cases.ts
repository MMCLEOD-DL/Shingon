import type { Role } from '@hf/shared';
import { IDS, type World, type WorldActor, type WorldResource } from './world.js';

export type Route = `${'GET' | 'POST' | 'PATCH' | 'DELETE'} ${string}`;

const ALL = ['admin', 'manager', 'member'] as const;

/**
 * Which roles may call each non-public route at all, typed out by hand from the spec's policy (Ruling 3)
 * and the routes in Tasks 3–7. Never derived from PERMISSIONS, can() or a route's declared permission (Ruling 10).
 */
export const EXPECTED_ROLES: Record<Route, readonly Role[]> = {
  'GET /api/me': ALL,
  'PATCH /api/me': ALL,
  'POST /api/me/password': ALL,
  'POST /api/auth/sign-out': ALL,
  'GET /api/users': ['admin', 'manager'],
  'GET /api/users/:id': ['admin', 'manager'],
  'PATCH /api/users/:id': ['admin'],
  'POST /api/users/:id/resend-invite': ['admin'],
  'POST /api/users/invite': ['admin'],
  'GET /api/teams': ['admin', 'manager'],
  'POST /api/teams': ['admin'],
  'GET /api/audit': ['admin'],
};

/**
 * Routes that anyone may call without signing in, also typed out by hand. A route declared public that is not
 * listed here fails the coverage gate, so a forgotten permission cannot slip past the harness.
 * Every actor gets the same expected answer from these (the case's okStatus).
 */
export const EXPECTED_PUBLIC: readonly Route[] = [
  'POST /api/auth/sign-in',
  'POST /api/auth/accept-invite',
  'POST /api/auth/forgot-password',
  'POST /api/auth/reset-password',
];

export interface ItemCase { kind: 'item'; route: Route; resource: string; visible?: (a: WorldActor, r: WorldResource) => boolean; allowed?: (a: WorldActor, r: WorldResource) => boolean; body?: (r: WorldResource) => unknown; okStatus?: number | ((r: WorldResource, a: WorldActor) => number); mutates?: boolean }
export interface ListCase { kind: 'list'; route: Route; resource: string; visible?: (a: WorldActor, r: WorldResource) => boolean; query?: string }
export interface ActionCase { kind: 'action'; route: Route; body?: (w: World) => unknown; okStatus?: number; mutates?: boolean; forbiddenFields?: Record<string, unknown>[] }
export type CrossingCase = ItemCase | ListCase | ActionCase;

const own = (a: WorldActor, r: WorldResource) => a.id === r.id;
// A well-formed link token that was never issued.
const NEVER_ISSUED = 'A'.repeat(43);
// The reset-request limit is per address and email, so each call asks about a different unknown address.
let forgotCounter = 0;

export const CASES: CrossingCase[] = [
  { kind: 'action', route: 'GET /api/me', okStatus: 200 },
  { kind: 'action', route: 'PATCH /api/me', body: () => ({ name: 'Renamed' }), mutates: true,
    forbiddenFields: [{ role: 'admin' }, { teamId: IDS.teams.south }, { email: 'x@hf.test' }, { disabled: false }] },
  { kind: 'action', route: 'POST /api/me/password', body: () => ({ currentPassword: 'correct horse battery', newPassword: 'another long passphrase' }), okStatus: 204, mutates: true },
  { kind: 'action', route: 'POST /api/auth/sign-out', okStatus: 204, mutates: true },
  { kind: 'list', route: 'GET /api/users', resource: 'user' },
  { kind: 'item', route: 'GET /api/users/:id', resource: 'user' },
  { kind: 'item', route: 'PATCH /api/users/:id', resource: 'user', body: () => ({ name: 'Renamed' }), mutates: true },
  { kind: 'item', route: 'PATCH /api/users/:id', resource: 'user', body: () => ({ role: 'member', teamId: IDS.teams.north }), mutates: true,
    okStatus: (r, a) => (own(a, r) ? 409 : 200) },   // an admin may not change their own role (Task 4)
  { kind: 'item', route: 'PATCH /api/users/:id', resource: 'user', body: () => ({ disabled: true }), mutates: true,
    okStatus: (r, a) => (own(a, r) ? 409 : 200) },   // nor disable their own account
  { kind: 'item', route: 'POST /api/users/:id/resend-invite', resource: 'user', mutates: true,
    okStatus: (r) => (r.key === 'pendingPat' ? 204 : 409) },   // everyone else has activated (Dave too, though disabled)
  { kind: 'action', route: 'POST /api/users/invite', body: () => ({ email: 'invited@hf.test', name: 'Invited', role: 'member', teamId: IDS.teams.north }), mutates: true },
  { kind: 'list', route: 'GET /api/teams', resource: 'team' },
  { kind: 'action', route: 'POST /api/teams', body: () => ({ name: 'East' }), mutates: true },
  { kind: 'action', route: 'GET /api/audit', okStatus: 200 },

  // Public routes: every actor, signed in or not, gets the same answer, nothing leaks and a refusal changes nothing.
  { kind: 'action', route: 'POST /api/auth/sign-in', body: () => ({ email: 'northalice@hf.test', password: 'not the right password' }), okStatus: 401, mutates: true },
  { kind: 'action', route: 'POST /api/auth/sign-in', body: () => ({ email: 'disableddave@hf.test', password: 'correct horse battery' }), okStatus: 401, mutates: true },
  { kind: 'action', route: 'POST /api/auth/sign-in', body: () => ({ email: 'pendingpat@hf.test', password: 'correct horse battery' }), okStatus: 401, mutates: true },
  { kind: 'action', route: 'POST /api/auth/forgot-password', body: () => ({ email: `nobody-${String(++forgotCounter)}@hf.test` }), okStatus: 202 },
  { kind: 'action', route: 'POST /api/auth/accept-invite', body: () => ({ token: NEVER_ISSUED, password: 'a perfectly long password' }), okStatus: 400, mutates: true },
  { kind: 'action', route: 'POST /api/auth/reset-password', body: () => ({ token: NEVER_ISSUED, password: 'a perfectly long password' }), okStatus: 400, mutates: true },
];
