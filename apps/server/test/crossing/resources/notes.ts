import { eq } from 'drizzle-orm';
import { files, notes } from '../../../src/db/schema/index.js';
import type { TestApp } from '../../helpers/testApp.js';
import type { IDS, WorldResource } from '../world.js';

type UserKey = Exclude<keyof (typeof IDS)['users'], 'pendingPat' | 'disabledPenny'>;
// Two notes for each person who can sign in or hold a session (Dave included), so the list is longer than one small page.
// The second note of northAlice carries her seeded file as its photo, so a note's attachment is part of what is checked.
const OWNERS: { key: UserKey; team: 'north' | 'south' | null }[] = [
  { key: 'admin', team: null },
  { key: 'northManager', team: 'north' },
  { key: 'northAlice', team: 'north' },
  { key: 'northBob', team: 'north' },
  { key: 'southManager', team: 'south' },
  { key: 'southCarol', team: 'south' },
  { key: 'disabledDave', team: 'north' },
];

const BASE = Date.UTC(2026, 0, 1, 9, 0, 0);

export async function seedNotes(t: TestApp, ids: typeof IDS): Promise<WorldResource[]> {
  const out: WorldResource[] = [];
  let n = 0;
  for (const round of [0, 1]) {
    for (const o of OWNERS) {
      n++;
      // The first note keeps the plain key; the second adds a suffix. Each carries its own canary in its title and body.
      const key = round === 0 ? o.key : `${o.key}Second`;
      const canary = `CANARY-note-${key}`;
      const id = `e1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
      const teamId = o.team === null ? null : ids.teams[o.team];
      const withFile = round === 1 && o.key === 'northAlice';
      const fileId = withFile ? (await t.db.select({ id: files.id }).from(files).where(eq(files.ownerId, ids.users.northAlice)))[0]?.id ?? null : null;
      await t.db.insert(notes).values({
        id, ownerId: ids.users[o.key], teamId, title: canary, body: `${canary} body text`, attachmentFileId: fileId,
        createdAt: new Date(BASE + n * 60_000), updatedAt: new Date(BASE + n * 60_000),
      });
      if (fileId) await t.db.update(files).set({ attachedType: 'note', attachedId: id }).where(eq(files.id, fileId));
      out.push({ type: 'note', key, id, ownerId: ids.users[o.key], teamId, canary, table: 'notes' });
    }
  }
  return out;
}
