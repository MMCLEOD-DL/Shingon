import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { LocalDiskStorage } from '../../../src/files/storage.js';
import { files } from '../../../src/db/schema/index.js';
import type { TestApp } from '../../helpers/testApp.js';
import type { IDS, WorldResource } from '../world.js';

const TINY_PNG = readFileSync(new URL('../../fixtures/files/tiny.png', import.meta.url));

type UserKey = Exclude<keyof (typeof IDS)['users'], 'pendingPat' | 'disabledPenny'>;
// One file per actor who can sign in or hold a session (Dave included), owned by them, in their team at upload time.
const OWNERS: { key: UserKey; team: 'north' | 'south' | null }[] = [
  { key: 'admin', team: null },
  { key: 'northManager', team: 'north' },
  { key: 'northAlice', team: 'north' },   // also her second note's photo (resources/notes.ts), so asking for a reading of it answers 409 in cases.ts
  { key: 'northBob', team: 'north' },
  { key: 'southManager', team: 'south' },
  { key: 'southCarol', team: 'south' },
  { key: 'disabledDave', team: 'north' },
];

export async function seedFiles(t: TestApp, ids: typeof IDS): Promise<WorldResource[]> {
  const storage = new LocalDiskStorage(t.config.uploadDir);
  const out: WorldResource[] = [];
  let n = 0;
  for (const o of OWNERS) {
    n++;
    const canary = `CANARY-file-${o.key}`;
    const id = `f1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const storageKey = `f${String(n).padStart(31, '0')}`;
    // The canary is also in the bytes (after the PNG's end marker, which readers ignore), so a leaked download is caught too.
    const bytes = Buffer.concat([TINY_PNG, Buffer.from(canary)]);
    const { size, sha256 } = await storage.put(storageKey, Readable.from([bytes]));
    const teamId = o.team === null ? null : ids.teams[o.team];
    await t.db.insert(files).values({
      id, ownerId: ids.users[o.key], teamId, storageKey, originalName: `${canary}.png`, contentType: 'image/png', size, sha256,
    });
    out.push({ type: 'file', key: o.key, id, ownerId: ids.users[o.key], teamId, canary, table: 'files' });
  }
  return out;
}
