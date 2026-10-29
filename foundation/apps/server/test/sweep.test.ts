import { test, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { utimes } from 'node:fs/promises';
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

test('a file the sweep cannot remove is logged by id and error code, and the rest are still swept', async () => {
  const t = await createTestDb();
  const real = new LocalDiskStorage(mkdtempSync(path.join(tmpdir(), 'sw-')));
  const N = await makeTeam(t.db, 'N');
  const u = await makeUser(t.db, { role: 'member', teamId: N.id });
  const old = new Date('2026-01-01T00:00:00Z');
  const ids: Record<string, string> = {};
  for (const key of ['dd0004', 'ee0005']) {
    const { size, sha256 } = await real.put(key, Readable.from(['x']));
    const [row] = await t.db.insert(files).values({ ownerId: u.id, teamId: N.id, storageKey: key, originalName: 'a.png', contentType: 'image/png', size, sha256, createdAt: old }).returning();
    ids[key] = row!.id;
  }
  const flaky = Object.assign(Object.create(real) as LocalDiskStorage, {
    delete: async (key: string) => { if (key === 'dd0004') throw Object.assign(new Error('/secret/path/dd0004 denied'), { code: 'EACCES' }); await real.delete(key); },
  });
  const logged: object[] = [];
  expect(await sweepOrphans(t.db, flaky, new Date('2026-06-01T00:00:00Z'), { error: (o) => { logged.push(o); } })).toBe(1);
  expect(logged).toEqual([{ fileId: ids['dd0004'], errName: 'Error', errCode: 'EACCES' }]);
  expect(JSON.stringify(logged)).not.toContain('secret');
  expect((await t.db.select({ id: files.id }).from(files)).map((r) => r.id)).toEqual([ids['dd0004']]);
  await t.close();
});

test('the disk sweep removes old objects with no row and old .tmp files, and keeps young ones and ones with a row', async () => {
  const t = await createTestDb();
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-'));
  const storage = new LocalDiskStorage(dir);
  const N = await makeTeam(t.db, 'N');
  const u = await makeUser(t.db, { role: 'member', teamId: N.id });
  const now = new Date();
  const age = async (rel: string, h: number) => { const d = new Date(now.getTime() - h * 3600e3); await utimes(path.join(dir, rel), d, d); };
  for (const key of ['ab0001', 'ab0002', 'ab0003']) await storage.put(key, Readable.from(['x']));
  await age('ab/ab0001', 48); await age('ab/ab0002', 1); await age('ab/ab0003', 48);
  const { size, sha256 } = { size: 1, sha256: 'a'.repeat(64) };
  await t.db.insert(files).values({ ownerId: u.id, teamId: N.id, storageKey: 'ab0003', originalName: 'a.png', contentType: 'image/png', size, sha256, attachedType: 'note', attachedId: '00000000-0000-4000-8000-000000000001' });
  writeFileSync(path.join(dir, 'ab', 'ab0004.0123456789ab.tmp'), 'partial');
  await age('ab/ab0004.0123456789ab.tmp', 48);
  writeFileSync(path.join(dir, 'ab', 'ab0005.0123456789ab.tmp'), 'partial');

  await sweepOrphans(t.db, storage, new Date(now.getTime() - 24 * 3600e3));
  const left = readdirSync(path.join(dir, 'ab')).sort();
  expect(left).toEqual(['ab0002', 'ab0003', 'ab0005.0123456789ab.tmp']);
  await t.close();
});

test('the disk listing ignores symlinks and odd names', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sw-'));
  const outside = mkdtempSync(path.join(tmpdir(), 'out-'));
  writeFileSync(path.join(outside, 'cd0001'), 'x');
  mkdirSync(path.join(dir, 'cd'));
  symlinkSync(path.join(outside, 'cd0001'), path.join(dir, 'cd', 'cd0001'));
  symlinkSync(outside, path.join(dir, 'ef'));
  writeFileSync(path.join(dir, 'cd', 'notes.txt'), 'x');
  const seen: string[] = [];
  for await (const o of new LocalDiskStorage(dir).list()) seen.push(o.key);
  expect(seen).toEqual([]);
});
