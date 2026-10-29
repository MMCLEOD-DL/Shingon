import { test, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import { compareManifest, checkRestoredFiles, buildManifest } from '../src/manifest.js';
import { createTestDb } from '../../apps/server/test/helpers/testDb.js';

const expected = { createdAt: 'x', app: '1', foundation: '0.1.0', tables: { notes: 32, users: 10 }, files: { count: 16, bytes: 2_000_000 } };
test('a complete restore has no problems', () => {
  expect(compareManifest(expected, { tables: { notes: 32, users: 10, extra_new: 0 }, files: { count: 16, bytes: 2_000_000 } })).toEqual([]);
});
test('missing rows, tables and files are spelled out', () => {
  expect(compareManifest(expected, { tables: { notes: 0 }, files: { count: 15, bytes: 1_900_000 } })).toEqual([
    'Table notes has 32 rows in the backup record but 0 after restoring.',
    'Table users is missing after restoring.',
    'The backup record lists 16 files (2 MB) but 15 files (2 MB) came back.',
  ]);
});

test('restored files are checked against the restored files table, by id and never by name', async () => {
  const t = await createTestDb();
  const dir = await mkdtemp(path.join(tmpdir(), 'hf-manifest-'));
  const c = new pg.Client({ connectionString: t.url });
  await c.connect();
  try {
    const team = await c.query<{ id: string }>(`insert into teams (name) values ('North') returning id`);
    const user = await c.query<{ id: string }>(`insert into users (email, name, role, team_id, password_hash) values ('a@example.test', 'A', 'member', $1, 'x') returning id`, [team.rows[0]!.id]);
    const ins = async (key: string, size: number) => (await c.query<{ id: string }>(
      `insert into files (owner_id, storage_key, original_name, content_type, size, sha256) values ($1, $2, 'Private name.pdf', 'application/pdf', $3, 'h') returning id`,
      [user.rows[0]!.id, key, size])).rows[0]!.id;
    await ins('aaone', 3);
    const missing = await ins('bbtwo', 4);
    const wrong = await ins('ccthree', 5);
    for (const [k, n] of [['aaone', 3], ['ccthree', 2], ['ddextra', 9]] as const) {
      await mkdir(path.join(dir, k.slice(0, 2)), { recursive: true });
      await writeFile(path.join(dir, k.slice(0, 2), k), 'x'.repeat(n));
    }
    const r = await checkRestoredFiles(c, dir);
    expect(r.count).toBe(1);
    expect(r.bytes).toBe(3);
    expect(r.problems).toEqual([
      `1 files listed in the backed-up database did not come back (for example ${missing}).`,
      `1 restored files have the wrong size (for example ${wrong}).`,
    ]);
    expect(r.problems.join(' ')).not.toContain('Private name');

    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const m = await buildManifest(c, { app: '1.2.3', foundation: '0.1.0' });
    await c.query('COMMIT');
    expect(m.files).toEqual({ count: 3, bytes: 12 });
    expect(m.tables).toMatchObject({ teams: 1, users: 1, files: 3, notes: 0 });
    expect(m.tables).not.toHaveProperty('ops_runs');
    expect(m).toMatchObject({ app: '1.2.3', foundation: '0.1.0' });
  } finally {
    await c.end();
    await t.close();
    await rm(dir, { recursive: true, force: true });
  }
});
