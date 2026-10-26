import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { runBackup } from '../src/backup.js';
import { verifyLatestRestore, restoreDatabase } from '../src/restore.js';
import { lastRun } from '../src/runs.js';
import { withRealDeps, q, TEST_BACKUP_PASSWORD } from './helpers.js';

// restic answers `restic version`; it has no --version flag.
const has = (b: string, args = ['--version']) => { try { execFileSync(b, args, { stdio: 'ignore' }); return true; } catch { return false; } };

describe.runIf(has('restic', ['version']) && has('pg_dump') && has('pg_restore'))('real backup and restore test', () => {
  test('back up a seeded database and uploads, then prove the restore', async () => {
    await withRealDeps(async (deps, info) => {
      const { snapshotId } = await runBackup(deps, 'manual');
      expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);
      const v = await verifyLatestRestore(deps);
      expect(v).toEqual({ ok: true, problems: [] });
      expect((await lastRun(deps.db, 'restore-test', { okOnly: true }))!.detail).toMatch(/^Restore test passed: backup [0-9a-f]{8} from /);
      const leftover = await deps.db.execute(sql`select datname from pg_database where datname like 'hf_restore_test_%'`);
      expect(leftover.rows).toEqual([]);
      expect(info.logs.join('\n')).not.toContain(TEST_BACKUP_PASSWORD);
      const details = await deps.db.execute<{ detail: string }>(sql`select detail from ops_runs`);
      expect(JSON.stringify(details.rows)).not.toContain(TEST_BACKUP_PASSWORD);
    });
  }, 120_000);

  test('a rollback restore leaves nothing from the failed update behind, and the update can be tried again', async () => {
    await withRealDeps(async (deps, info) => {
      const { snapshotId } = await runBackup(deps, 'pre-update');
      const notesBefore = await q(info.url, 'select count(*)::int n from notes');
      // what a failed migration might leave behind
      await q(info.url, `create type update_mood as enum ('x'); create table update_probe (id int, mood update_mood); delete from notes;`);
      await restoreDatabase(deps, snapshotId, info.dbName);
      expect(await q(info.url, `select to_regclass('public.update_probe')::text r`)).toEqual([{ r: null }]);
      expect(await q(info.url, `select count(*)::int n from pg_type where typname = 'update_mood'`)).toEqual([{ n: 0 }]);
      expect(await q(info.url, 'select count(*)::int n from notes')).toEqual(notesBefore);
      // the same "migration" now applies cleanly again
      await q(info.url, `create type update_mood as enum ('x'); create table update_probe (id int, mood update_mood);`);
      expect(await lastRun(deps.db, 'backup', { okOnly: true })).not.toBeNull();   // ops' pool survived the forced drop
    });
  }, 120_000);

  test('an upload missing from the backup is reported by the restore test, by file id', async () => {
    await withRealDeps(async (deps, info) => {
      const [row] = await q(info.url, 'select id::text, storage_key from files order by id limit 1') as { id: string; storage_key: string }[];
      await rm(path.join(deps.cfg.uploadsDir, row!.storage_key.slice(0, 2), row!.storage_key));
      await runBackup(deps, 'manual');
      const v = await verifyLatestRestore(deps);
      expect(v.ok).toBe(false);
      expect(v.problems).toContain(`1 files listed in the backed-up database did not come back (for example ${row!.id}).`);
      expect(v.problems.some((p) => /^The backup record lists \d+ files/.test(p))).toBe(true);
      expect((await lastRun(deps.db, 'restore-test', { okOnly: false }))).toMatchObject({ ok: false });
    });
  }, 120_000);

  test('a damaged backup destination makes the restore test fail, and the failure is recorded', async () => {
    await withRealDeps(async (deps, info) => {
      await runBackup(deps, 'manual');
      const dataDir = path.join(info.dir, 'repo', 'data');
      for (const sub of await readdir(dataDir)) for (const f of await readdir(path.join(dataDir, sub))) await writeFile(path.join(dataDir, sub, f), 'damaged');
      const v = await verifyLatestRestore(deps);
      expect(v.ok).toBe(false);
      expect(v.problems.join(' ')).toMatch(/could not be restored/);
      expect(await lastRun(deps.db, 'restore-test', { okOnly: false })).toMatchObject({ ok: false });
      const leftover = await deps.db.execute(sql`select datname from pg_database where datname like 'hf_restore_test_%'`);
      expect(leftover.rows).toEqual([]);
    });
  }, 120_000);
});
