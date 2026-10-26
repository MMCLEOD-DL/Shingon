import type { Role } from '@hf/shared';
import { readFileSync } from 'node:fs';
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
  // Files: every signed-in role. Who may see or delete a given file is the item rule in CASES, not a role rule.
  'POST /api/files': ALL,
  'GET /api/files/:id': ALL,
  'GET /api/files/:id/content': ALL,
  'DELETE /api/files/:id': ALL,
  // Notes: every signed-in role may use the routes. Who may see or change a given note is the item rule in CASES, not a role rule.
  'GET /api/notes': ALL,
  'POST /api/notes': ALL,
  'GET /api/notes/:id': ALL,
  'PATCH /api/notes/:id': ALL,
  'DELETE /api/notes/:id': ALL,
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

/**
 * `mutates` defaults to true for every method except GET: the harness then checks that a refusal changed nothing.
 * A case may opt out only with `mutates: false` and a `why` that says why nothing can change.
 * `forbiddenFields` are replayed on top of `body` by every permitted actor; each must be answered 400 with nothing changed.
 */
export interface ItemCase { kind: 'item'; route: Route; resource: string; visible?: (a: WorldActor, r: WorldResource) => boolean; allowed?: (a: WorldActor, r: WorldResource) => boolean; body?: (r: WorldResource) => unknown; okStatus?: number | ((r: WorldResource, a: WorldActor) => number); mutates?: boolean; why?: string; forbiddenFields?: Record<string, unknown>[] }
/** `paginate`: the first page's query, and how to get the next page's query from a reply (null at the end). Every page is checked. */
export interface ListCase { kind: 'list'; route: Route; resource: string; visible?: (a: WorldActor, r: WorldResource) => boolean; query?: string; paginate?: { query: string; next: (json: any) => string | null } }
/** `multipart`: send one file as multipart/form-data instead of JSON; `body` keys (and forbiddenFields) go in as extra text fields. */
export interface ActionCase { kind: 'action'; route: Route; multipart?: { field: string; filename: string; bytes: Buffer }; body?: (w: World) => unknown; okStatus?: number; mutates?: boolean; why?: string; forbiddenFields?: Record<string, unknown>[] }
export type CrossingCase = ItemCase | ListCase | ActionCase;

const TINY_PNG = readFileSync(new URL('../fixtures/files/tiny.png', import.meta.url));
const own = (a: WorldActor, r: WorldResource) => a.id === r.id;
const LONG_AGO = '2020-01-01T00:00:00.000Z';
const SOME_ID = '0a000000-0000-4000-8000-0000000000ff';
// A well-formed link token that was never issued.
const NEVER_ISSUED = 'A'.repeat(43);
// The reset-request limit is per address and email, so each call asks about a different unknown address.
let forgotCounter = 0;

export const CASES: CrossingCase[] = [
  { kind: 'action', route: 'GET /api/me', okStatus: 200 },
  { kind: 'action', route: 'PATCH /api/me', body: () => ({ name: 'Renamed' }), mutates: true,
    forbiddenFields: [{ role: 'admin' }, { teamId: IDS.teams.south }, { email: 'x@hf.test' }, { disabled: false }, { id: SOME_ID }, { passwordHash: 'x' }] },
  { kind: 'action', route: 'POST /api/me/password', body: () => ({ currentPassword: 'correct horse battery', newPassword: 'another long passphrase' }), okStatus: 204, mutates: true },
  { kind: 'action', route: 'POST /api/auth/sign-out', okStatus: 204, mutates: true },
  { kind: 'list', route: 'GET /api/users', resource: 'user' },
  { kind: 'item', route: 'GET /api/users/:id', resource: 'user' },
  { kind: 'item', route: 'PATCH /api/users/:id', resource: 'user', body: () => ({ name: 'Renamed' }), mutates: true,
    forbiddenFields: [{ email: 'x@hf.test' }, { passwordHash: 'x' }, { id: SOME_ID }, { createdAt: LONG_AGO }, { disabledAt: null }, { activated: true }] },
  { kind: 'item', route: 'PATCH /api/users/:id', resource: 'user', body: () => ({ role: 'member', teamId: IDS.teams.north }), mutates: true,
    okStatus: (r, a) => (own(a, r) ? 409 : 200) },   // an admin may not change their own role (Task 4)
  { kind: 'item', route: 'PATCH /api/users/:id', resource: 'user', body: () => ({ disabled: true }), mutates: true,
    okStatus: (r, a) => (own(a, r) ? 409 : 200) },   // nor disable their own account
  { kind: 'item', route: 'POST /api/users/:id/resend-invite', resource: 'user', mutates: true,
    okStatus: (r) => (r.key === 'pendingPat' ? 204 : 409) },   // the rest have activated (Dave too, though disabled), or are disabled (Penny)
  { kind: 'action', route: 'POST /api/users/invite', body: () => ({ email: 'invited@hf.test', name: 'Invited', role: 'member', teamId: IDS.teams.north }), mutates: true,
    forbiddenFields: [{ passwordHash: 'x' }, { id: SOME_ID }, { disabled: true }, { createdAt: LONG_AGO }, { activated: true }] },
  { kind: 'list', route: 'GET /api/teams', resource: 'team' },
  { kind: 'action', route: 'POST /api/teams', body: () => ({ name: 'East' }), mutates: true,
    forbiddenFields: [{ id: SOME_ID }, { createdAt: LONG_AGO }] },
  { kind: 'action', route: 'GET /api/audit', okStatus: 200 },
  { kind: 'item', route: 'GET /api/files/:id', resource: 'file' },
  { kind: 'item', route: 'GET /api/files/:id/content', resource: 'file' },
  { kind: 'item', route: 'DELETE /api/files/:id', resource: 'file', allowed: (a, r) => a.role === 'admin' || a.id === r.ownerId, mutates: true },
  { kind: 'action', route: 'POST /api/files', okStatus: 201, mutates: true, multipart: { field: 'file', filename: 'receipt.png', bytes: TINY_PNG },
    // Anything beside the one file is refused, so a client cannot choose the owner, team or type of the new file.
    forbiddenFields: [{ ownerId: SOME_ID }, { teamId: IDS.teams.south }, { contentType: 'text/html' }, { storageKey: 'aaaaaa' }, { id: SOME_ID }] },

  // Notes. The list has 14 notes in the world and is read three at a time, so a leak on a later page is seen.
  { kind: 'list', route: 'GET /api/notes', resource: 'note',
    paginate: { query: 'limit=3', next: (j) => { const c: unknown = j?.nextCursor; return typeof c === 'string' ? `limit=3&cursor=${c}` : null; } } },
  { kind: 'item', route: 'GET /api/notes/:id', resource: 'note' },
  { kind: 'item', route: 'PATCH /api/notes/:id', resource: 'note', body: () => ({ title: 'Changed' }), mutates: true,
    allowed: (a, r) => a.role === 'admin' || a.id === r.ownerId,
    forbiddenFields: [{ ownerId: IDS.users.southCarol }, { teamId: IDS.teams.south }, { id: SOME_ID }, { createdAt: LONG_AGO }, { updatedAt: LONG_AGO }, { ownerName: 'x' }, { canEdit: true }, { attachment: null }, { attachmentFileId: SOME_ID }] },
  { kind: 'item', route: 'DELETE /api/notes/:id', resource: 'note', mutates: true,
    allowed: (a, r) => a.role === 'admin' || a.id === r.ownerId },
  { kind: 'action', route: 'POST /api/notes', body: () => ({ title: 'New' }), okStatus: 201, mutates: true,
    forbiddenFields: [{ ownerId: IDS.users.southCarol }, { teamId: IDS.teams.south }, { id: SOME_ID }, { createdAt: LONG_AGO }, { updatedAt: LONG_AGO }, { ownerName: 'x' }, { canEdit: true }, { attachmentFileId: SOME_ID }] },

  // Public routes: every actor, signed in or not, gets the same answer, nothing leaks and a refusal changes nothing.
  { kind: 'action', route: 'POST /api/auth/sign-in', body: () => ({ email: 'canary-user-northalice@hf.test', password: 'not the right password' }), okStatus: 401, mutates: true },
  { kind: 'action', route: 'POST /api/auth/sign-in', body: () => ({ email: 'canary-user-disableddave@hf.test', password: 'correct horse battery' }), okStatus: 401, mutates: true },
  { kind: 'action', route: 'POST /api/auth/sign-in', body: () => ({ email: 'canary-user-pendingpat@hf.test', password: 'correct horse battery' }), okStatus: 401, mutates: true },
  { kind: 'action', route: 'POST /api/auth/forgot-password', body: () => ({ email: `nobody-${String(++forgotCounter)}@hf.test` }), okStatus: 202 },
  { kind: 'action', route: 'POST /api/auth/accept-invite', body: () => ({ token: NEVER_ISSUED, password: 'a perfectly long password' }), okStatus: 400, mutates: true },
  { kind: 'action', route: 'POST /api/auth/reset-password', body: () => ({ token: NEVER_ISSUED, password: 'a perfectly long password' }), okStatus: 400, mutates: true },
];
