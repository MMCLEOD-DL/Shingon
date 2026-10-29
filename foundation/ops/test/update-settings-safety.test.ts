import { test, expect } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dockerCompose } from '../src/compose.js';
import { realFs, type DurableFs } from '../src/durable.js';
import { runUpdate, updateExitCode } from '../src/update.js';
import type { UpdateRecord } from '../src/journal.js';

for (const failure of ['before-rename', 'directory-open', 'directory-sync', 'restore-sync'] as const) {
  test(`real settings write failure at ${failure}: no unmigrated target image starts`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'hf-update-settings-'));
    const file = path.join(dir, '.env');
    await writeFile(file, 'APP_TAG=1.0.0\n', { mode: 0o600 });
    let directoryCalls = 0;
    const fail = (): never => { throw Object.assign(new Error('injected disk error'), { code: 'EIO' }); };
    const fs: DurableFs = { ...realFs, open: async (p, flags, mode) => {
      if (p === dir) {
        directoryCalls++;
        if (failure === 'directory-open' && directoryCalls === 1) return fail();
        const h = await realFs.open(p, flags, mode);
        return { writeFile: (data) => h.writeFile(data), close: () => h.close(), sync: async () => {
          if ((failure === 'directory-sync' && directoryCalls === 1) || failure === 'restore-sync') fail();
          await h.sync();
        } };
      }
      if (failure === 'before-rename' && flags === 'wx') return fail();
      return realFs.open(p, flags, mode);
    } };
    const starts: string[] = [], migrations: string[] = [];
    let restores = 0, cleared = false;
    let journal: Omit<UpdateRecord, 'updatedAt' | 'pid' | 'host'> | null = null;
    const compose = dockerCompose({ bundleDir: dir, project: 'test', fs, run: { run: async (_cmd, args) => {
      if (args.includes('up') && args.includes('app')) starts.push(await readFile(file, 'utf8'));
      if (args.includes('migrate')) migrations.push(await readFile(file, 'utf8'));
      return { code: 0, stdout: 'local-image', stderr: '' };
    } } });
    try {
      const result = await runUpdate({
        compose, client: 'Test', images: { app: 'highland/app', ops: 'highland/ops' },
        backup: async () => ({ snapshotId: 'abcdef1234567890' }), restoreDb: async () => { restores++; },
        waitReady: async () => ({ ok: true, detail: '' }), alert: { send: async () => {} }, record: async () => true,
        lock: { acquire: async () => true, release: async () => {} },
        journal: { read: async () => null, write: async (r) => { journal = r; }, clear: async () => { cleared = true; journal = null; } },
      }, { to: '1.1.0' });
      expect(await readFile(file, 'utf8')).toBe('APP_TAG=1.0.0\n');
      expect(migrations).toEqual([]);
      expect(starts.every((text) => text === 'APP_TAG=1.0.0\n')).toBe(true);
      if (failure === 'before-rename') {
        expect(result.outcome).toBe('cancelled');
        expect(restores).toBe(0);
        expect(starts).toHaveLength(1);
      } else if (failure === 'restore-sync') {
        expect(result.outcome).toBe('rollback-failed');
        expect(updateExitCode(result)).toBe(3);
        expect(starts).toEqual([]);
        expect(result.message).toContain('currently names 1.0.0, but its safe restoration could not be confirmed');
        expect(result.message).not.toContain('still names 1.1.0');
        expect(cleared).toBe(false);
        expect(journal).toMatchObject({ step: 'undo-failed', snapshot: 'abcdef1234567890' });
      } else {
        expect(result.outcome).toBe('rolled-back');
        expect(restores).toBe(1);
        expect(starts).toHaveLength(1);
        expect(cleared).toBe(true);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
}

test('unreadable tag after a failed write enters recovery, never a pre-change restart', async () => {
  let reads = 0, restored = false;
  const starts: string[] = [];
  const result = await runUpdate({
    compose: { imageAvailable: async () => true, stop: async () => {}, up: async (s) => { starts.push(s); },
      readTag: async () => { if (reads++ === 0) return '1.0.0'; throw new Error('unreadable'); },
      writeTag: async () => { throw new Error('write failed'); }, runOnce: async () => ({ ok: true, output: '' }) },
    client: 'Test', images: { app: 'highland/app', ops: 'highland/ops' },
    backup: async () => ({ snapshotId: 'abcdef1234567890' }), restoreDb: async () => { restored = true; },
    waitReady: async () => ({ ok: true, detail: '' }), alert: { send: async () => {} }, record: async () => true,
    lock: { acquire: async () => true, release: async () => {} },
  }, { to: '1.1.0' });
  expect(result.outcome).toBe('rollback-failed');
  expect(result.message).toContain('version is unknown');
  expect(result.message).not.toContain('Nothing was changed');
  expect(starts).not.toContain('app');
  expect(restored).toBe(true);
});
