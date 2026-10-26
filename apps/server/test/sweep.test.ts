import { test, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { createTestDb } from './helpers/testDb.js';
import { makeTeam, makeUser } from './helpers/factories.js';
import { LocalDiskStorage } from '../src/files/storage.js';
import { sweepOrphans } from '../src/files/repo.js';
import { files } from '../src/db/schema/index.js';

test('the orphan sweep removes only old, unattached files, from storage and from the table', async () => {
  const t = await createTestDb();
  const storage = new LocalDiskStorage(mkdtempSync(path.join(tmpdir(), 'sw-')));
  const N = await makeTeam(t.db, 'N');
  const u = await makeUser(t.db, { role: 'member', teamId: N.id });
  const now = new Date('2026-11-02T12:00:00Z');
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600e3);
  async function addFile(key: string, createdAt: Date, attached: boolean) {
    const { size, sha256 } = await storage.put(key, Readable.from(['x']));
    const [row] = await t.db.insert(files).values({
      ownerId: u.id, teamId: N.id, storageKey: key, originalName: `${key}.png`, contentType: 'image/png', size, sha256, createdAt,
      ...(attached ? { attachedType: 'note', attachedId: '00000000-0000-4000-8000-000000000001' } : {}),
    }).returning();
    return row!;
  }
  const attachedOld = await addFile('aa0001', hoursAgo(48), true);   // old but attached: kept
  const fresh = await addFile('bb0002', hoursAgo(1), false);         // unattached but fresh (upload in progress): kept
  await addFile('cc0003', hoursAgo(25), false);                      // unattached and old: removed

  expect(await sweepOrphans(t.db, storage, hoursAgo(24))).toBe(1);

  const left = (await t.db.select({ id: files.id }).from(files)).map((r) => r.id).sort();
  expect(left).toEqual([attachedOld.id, fresh.id].sort());
  expect(await text(storage.get('aa0001'))).toBe('x');
  expect(await text(storage.get('bb0002'))).toBe('x');
  await expect(text(storage.get('cc0003'))).rejects.toThrow(/ENOENT/);
  await t.close();
});
