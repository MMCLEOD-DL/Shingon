import { test, expect } from 'vitest';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileJournal, isLeftover, stepText, UPDATE_RECORD, type UpdateRecord } from '../src/journal.js';

test('fileJournal: written atomically (no temp left), readable by all, read back, cleared', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hf-journal-'));
  try {
    const file = path.join(dir, UPDATE_RECORD);
    const j = fileJournal(file, { now: () => new Date('2026-10-26T20:00:05Z') });
    expect(await j.read()).toBeNull();
    await j.write({ from: '0.1.0', to: '0.1.1', startedAt: '2026-10-26T20:00:00.000Z', step: 'stopping' });
    await j.write({ from: '0.1.0', to: '0.1.1', startedAt: '2026-10-26T20:00:00.000Z', step: 'switching', snapshot: 'abcdef1234' });
    expect(await readdir(dir)).toEqual([UPDATE_RECORD]);
    expect((await stat(file)).mode & 0o777).toBe(0o644);
    expect(await j.read()).toMatchObject({ step: 'switching', snapshot: 'abcdef1234', updatedAt: '2026-10-26T20:00:05.000Z', pid: process.pid });
    expect(JSON.parse(await readFile(file, 'utf8'))).not.toHaveProperty('password');
    await j.clear();
    expect(await j.read()).toBeNull();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every step has a plain description of what the box may look like', () => {
  for (const step of ['stopping', 'backing-up', 'switching', 'migrating', 'starting', 'undoing', 'finishing'] as const) {
    expect(stepText({ step, from: '0.1.0', to: '0.1.1' }).length).toBeGreaterThan(20);
  }
});

test('isLeftover: anything but a finishing update in its last 10 minutes', () => {
  const r: UpdateRecord = { from: 'a', to: 'b', startedAt: '2026-10-26T20:00:00Z', updatedAt: '2026-10-26T20:00:00Z', step: 'finishing', pid: 1, host: 'h' };
  expect(isLeftover(r, new Date('2026-10-26T20:09:00Z'))).toBe(false);
  expect(isLeftover(r, new Date('2026-10-26T20:11:00Z'))).toBe(true);
  expect(isLeftover({ ...r, step: 'migrating' }, new Date('2026-10-26T20:00:01Z'))).toBe(true);
});

test('a record that cannot be written gives a plain reason, never a code or a path', async () => {
  const j = fileJournal('/nonexistent-folder-hf/update-in-progress.json');
  await expect(j.write({ from: 'a', to: 'b', startedAt: '2026-10-26T20:00:00Z', step: 'stopping' })).rejects.toThrow(/^the file or folder does not exist$/);
});
