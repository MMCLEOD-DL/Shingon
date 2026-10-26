import path from 'node:path';
import { request, type APIRequestContext } from '@playwright/test';
import type { NoteView, TeamView, UserView } from '@hf/shared';

export const BASE_URL = 'http://localhost:4319';
export const AUTH_DIR = path.join(import.meta.dirname, '.auth');
export const SHOTS_DIR = path.resolve(import.meta.dirname, '../../../reports/screenshots');
export const DEMO_PASSWORD = process.env['DEMO_PASSWORD'] || 'demo-password-1';
export const ADMIN_EMAIL = 'admin@demo.test';
export const MANAGER_EMAIL = 'ops.manager@demo.test';
export type Role = 'admin' | 'manager' | 'member';
export const authFile = (role: Role): string => path.join(AUTH_DIR, `${role}.json`);

export interface Fixtures { memberNoteWithPhoto: string; memberNoteTitle: string; salesNoteId: string }

/** The first Operations member, by email. The journeys' own flow.* accounts are never picked. */
export function pickMember(all: readonly UserView[]): UserView {
  const m = all
    .filter((u) => u.role === 'member' && u.teamName === 'Operations' && u.activated && !u.disabled && !u.email.startsWith('flow.'))
    .sort((a, b) => a.email.localeCompare(b.email))[0];
  if (!m) throw new Error('The demo data has no Operations member.');
  return m;
}

async function getJson<T>(api: APIRequestContext, url: string): Promise<T> {
  const res = await api.get(url);
  if (!res.ok()) throw new Error(`${url} answered ${String(res.status())}.`);
  return (await res.json()) as T;
}

let cached: Promise<Fixtures> | undefined;

/** Looks up the ids the specs need, through the API as the admin (using the stored sign-in). */
export function loadFixtures(): Promise<Fixtures> {
  cached ??= (async () => {
    const api = await request.newContext({ baseURL: BASE_URL, storageState: authFile('admin') });
    try {
      const { users } = await getJson<{ users: UserView[] }>(api, '/api/users');
      const { teams } = await getJson<{ teams: TeamView[] }>(api, '/api/teams');
      const member = pickMember(users);
      const sales = teams.find((t) => t.name === 'Sales');
      if (!sales) throw new Error('The demo data has no Sales team.');
      const all: NoteView[] = [];
      let cursor: string | null = null;
      do {
        const page: { notes: NoteView[]; nextCursor: string | null } = await getJson(api, `/api/notes?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        all.push(...page.notes);
        cursor = page.nextCursor;
      } while (cursor);
      const withPhoto = all.find((n) => n.ownerId === member.id && n.attachment !== null);
      const salesNote = all.find((n) => n.teamId === sales.id);
      if (!withPhoto || !salesNote) throw new Error('The demo data is missing the notes the tests need.');
      return { memberNoteWithPhoto: withPhoto.id, memberNoteTitle: withPhoto.title, salesNoteId: salesNote.id };
    } finally {
      await api.dispose();
    }
  })();
  return cached;
}
