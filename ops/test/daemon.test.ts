import { test, expect } from 'vitest';
import { daemonJobs, onJobFailure, MONITOR_SCHEDULE, backupPause, prunePause, scheduledBackupJob, manualBackup, sweepLeftovers } from '../src/daemon.js';
import { Monitor } from '../src/monitor.js';
import { withOpsLock } from '../src/opsLock.js';
import { lastRun, type OpsDeps } from '../src/runs.js';
import { startScheduler } from '../src/scheduler.js';
import { BackupError, runBackup } from '../src/backup.js';
import { opsRuns } from '@hf/server/db/schema';
import { okBackup, withDeps } from './helpers.js';

async function holdLock(deps: OpsDeps): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void, reached!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  const got = new Promise<void>((r) => { reached = r; });
  const done = withOpsLock(deps, { waitMs: 0, busyMessage: 'busy' }, async () => { reached(); await wait; });
  await got;
  return { release, done };
}

test('the monitor keeps ticking while a scheduled backup waits for the ops lock, and the backup never piles up', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    const sent: string[] = [];
    let ticks = 0;
    const monitor = new Monitor({ checks: async () => { ticks++; return []; }, channel: { send: async (t) => { sent.push(t); } }, client: 'Acme' });
    let backupStarts = 0;
    const jobs = daemonJobs(deps, { send: async (t) => { sent.push(t); } }, monitor)
      .map((j) => (j.name === 'backup' ? { ...j, run: async () => { backupStarts++; await j.run(); } } : j));
    expect(jobs.find((j) => j.name === 'monitor')?.cron).toBe(MONITOR_SCHEDULE);
    // A manual clock: the test fires each job's timer itself, so nothing depends on real time passing.
    const fire: Record<string, () => Promise<unknown>> = {};
    const s = startScheduler(jobs, onJobFailure(deps, monitor), (_cron, name, f) => { fire[name] = f; return { stop: () => undefined }; });
    const held = await holdLock(deps);
    try {
      const firstBackup = fire['backup']!();          // waits for the lock (up to an hour)
      for (let i = 0; i < 5; i++) {
        expect(await fire['monitor']!()).toBe('ran');  // every monitor tick runs to the end meanwhile
        expect(await fire['backup']!()).toBe('skipped'); // and the next backups due are skipped, not stacked up
      }
      expect(ticks).toBe(5);
      expect(backupStarts).toBe(1);
      expect(rec.calls).toEqual([]);
      held.release();
      await held.done;
      expect(await firstBackup).toBe('ran');
    } finally {
      s.stop();
      held.release();
    }
    expect((await lastRun(deps.db, 'backup', { okOnly: true }))!.detail).toMatch(/^Backup 01234567 saved/);
    expect(await fire['backup']!()).toBe('ran');   // free again once the first finished
    expect(sent).toEqual([]);
  });
});

test('a failed scheduled job reaches the alert channel at once, named in plain English and with secrets hidden', async () => {
  await withDeps({}, async (deps, rec) => {
    const sent: string[] = [];
    const monitor = new Monitor({ checks: async () => [], channel: { send: async (t) => { sent.push(t); } }, client: 'Acme' });
    const hook = onJobFailure(deps, monitor);
    await hook('backup', new BackupError('Another backup or restore is running right now, so this backup did not start. Try again when it has finished.', true));
    await hook('audit-purge', Object.assign(new Error('The audit log could not be tidied. Check that the database is running and up to date.'), { reported: true }));
    await hook('restore-test', new Error(`connect failed for ${deps.cfg.backup.password}`));
    expect(sent).toEqual([
      '[Acme] Problem: the scheduled backup failed. Another backup or restore is running right now, so this backup did not start. Try again when it has finished.',
      '[Acme] Problem: the scheduled audit-log tidy-up failed. The audit log could not be tidied. Check that the database is running and up to date.',
      '[Acme] Problem: the scheduled restore test failed. It stopped because of an unexpected problem: connect failed for [hidden].',
    ]);
    expect(rec.logs.join('\n')).not.toContain(deps.cfg.backup.password);
  });
});

test('if the alert channel is down, the failure is still logged and nothing throws', async () => {
  await withDeps({}, async (deps, rec) => {
    const monitor = new Monitor({ checks: async () => [], channel: { send: () => Promise.reject(new Error('Matrix refused the alert (HTTP 502).')) }, client: 'Acme', log: deps.log });
    await onJobFailure(deps, monitor)('backup', new BackupError('The backup destination could not be reached (sftp:backup@nas.test.lan:/srv/restic).', true));
    expect(rec.logs).toEqual(['The alert about the failed scheduled backup could not be sent (it will be tried again at the next check): Matrix refused the alert (HTTP 502).']);
  });
});

test('a backup refused because the lock was busy is recorded as busy; a real failure is not', async () => {
  await withDeps({}, async (deps, rec) => {
    const held = await holdLock(deps);
    await expect(runBackup(deps, 'manual')).rejects.toThrow(/^Another backup or restore is running right now/);
    held.release();
    await held.done;
    rec.respond((c) => (c.cmd === 'restic' ? { code: 1, stdout: '', stderr: 'Fatal: wrong password or no key found' } : { code: 0, stdout: '', stderr: '' }));
    await expect(runBackup(deps, 'scheduled')).rejects.toThrow('The backup password does not match the backup destination.');
    const rows = await deps.db.select({ ok: opsRuns.ok, busy: opsRuns.busy }).from(opsRuns).orderBy(opsRuns.id);
    expect(rows).toEqual([{ ok: false, busy: true }, { ok: false, busy: false }]);
  });
});

test('while a failed undo is outstanding, the scheduled backup (and every prune) is skipped, recorded as busy and alerted; mark-recovered lifts it', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    const sent: string[] = [];
    const job = scheduledBackupJob(deps, { send: async (t) => { sent.push(t); } });
    await deps.db.insert(opsRuns).values({ kind: 'update', ok: false, detail: '[Acme Test Ltd] URGENT: update to 0.1.6 failed (x) and the automatic undo also failed (y).', snapshotId: 'c323c601aaaabbbb' });
    await job();
    expect(rec.calls.filter((c) => c.cmd === 'restic' || c.cmd === 'pg_dump')).toEqual([]);   // no backup, no forget
    const paused = 'Backups are paused because an update could not be undone: backup c323c601 holds the data from before it and must be kept as it is. Nothing is backed up or tidied away meanwhile. See the runbook, section "Recovering from a failed update"; when the box is recovered, run: docker compose run --rm updater update --mark-recovered';
    expect(sent).toEqual([`[Acme Test Ltd] ${paused}`]);
    const runs = await deps.db.select().from(opsRuns);
    expect(runs.find((r) => r.kind === 'backup')).toMatchObject({ ok: false, busy: true, detail: paused });
    // A cancelled update afterwards does not lift the pause; marking recovered does.
    await deps.db.insert(opsRuns).values({ kind: 'update', ok: false, detail: '[Acme Test Ltd] Update to 0.1.7 cancelled: an earlier update could not be undone and has not been marked as recovered.' });
    expect(await backupPause(deps)).toBe(paused);
    await deps.db.insert(opsRuns).values({ kind: 'update', ok: true, detail: 'The operator marked the failed update as recovered: the app is healthy on 0.1.5.' });
    expect(await backupPause(deps)).toBeNull();
    await job();
    expect(rec.calls.filter((c) => c.args[0] === 'forget')).toHaveLength(2);   // the pre-update rule and the daily rule
  });
});

test('an update record left in /state pauses scheduled backups too', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  await withDeps({}, async (deps) => {
    await mkdir(path.dirname(deps.cfg.workDir), { recursive: true });
    const file = path.join(path.dirname(deps.cfg.workDir), 'update-in-progress.json');
    await writeFile(file, JSON.stringify({ from: '0.1.5', to: '0.1.6', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), step: 'backing-up', pid: 1, host: 'x' }));
    expect(await backupPause(deps)).toMatch(/^Backups are paused because an update could not be undone\. Nothing is backed up/);
    // A finishing update that is still running (its lock's heartbeat is fresh) is not a leftover: the backup waits for it.
    await writeFile(file, JSON.stringify({ from: '0.1.5', to: '0.1.6', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), step: 'finishing', snapshot: 'abcdef12aaaa', pid: 1, host: 'x' }));
    await writeFile(path.join(path.dirname(deps.cfg.workDir), 'update.lock'), JSON.stringify({ pid: 1, host: 'updater1', at: new Date().toISOString() }));
    expect(await backupPause(deps)).toBeNull();
  });
});

test('round 3: "running" means the update lock\'s holder is alive (fresh heartbeat), not merely that someone holds the ops lock', async () => {
  const { mkdir, writeFile, utimes } = await import('node:fs/promises');
  const path = await import('node:path');
  await withDeps({}, async (deps) => {
    const state = path.dirname(deps.cfg.workDir);
    await mkdir(state, { recursive: true });
    await writeFile(path.join(state, 'update-in-progress.json'), JSON.stringify({ from: '0.1.5', to: '0.1.6', startedAt: new Date().toISOString(), updatedAt: new Date(Date.now() - 3600e3).toISOString(), step: 'migrating', pid: 1, host: 'x' }));
    // Another run (say, a long restore test) holding the ops lock does not hide a leftover.
    const held = await holdLock(deps);
    try {
      expect(await backupPause(deps)).not.toBeNull();
    } finally {
      held.release();
      await held.done;
    }
    // A routine update in progress: its lock names it and its heartbeat is fresh. No pause.
    const lock = path.join(state, 'update.lock');
    await writeFile(lock, JSON.stringify({ pid: 1, host: 'updater1', at: new Date().toISOString() }));
    expect(await backupPause(deps)).toBeNull();
    // Its heartbeat stopped (a crashed updater): left behind.
    const old = new Date(Date.now() - 5 * 60e3);
    await utimes(lock, old, old);
    expect(await backupPause(deps)).not.toBeNull();
    // A lock that cannot be read falls back to the ops lock plus the grace windows.
    await writeFile(lock, 'not json');
    const held2 = await holdLock(deps);
    try {
      expect(await backupPause(deps)).toBeNull();
    } finally {
      held2.release();
      await held2.done;
    }
  });
});

test('round 3: a backup that holds the ops lock never prunes while any update record is present, whatever its step or age', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const path = await import('node:path');
  await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    const state = path.dirname(deps.cfg.workDir);
    await mkdir(state, { recursive: true });
    // Fresh "finishing" with a fresh lock: the start-of-job check would let it through, but under the ops lock no update can be running.
    await writeFile(path.join(state, 'update-in-progress.json'), JSON.stringify({ from: '0.1.5', to: '0.1.6', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), step: 'finishing', snapshot: 'c323c601aaaabbbb', pid: 1, host: 'x' }));
    await writeFile(path.join(state, 'update.lock'), JSON.stringify({ pid: 1, host: 'updater1', at: new Date().toISOString() }));
    expect(await prunePause(deps)).toMatch(/^Backups are paused because an update could not be undone: backup c323c601/);
    await runBackup(deps, 'scheduled', { prunePause: () => prunePause(deps) });
    expect(rec.calls.some((c) => c.args[0] === 'backup')).toBe(true);
    expect(rec.calls.some((c) => c.args[0] === 'forget')).toBe(false);
  });
});

test('N6: if the ops log cannot be read, scheduled backups pause (fail closed)', async () => {
  await withDeps({}, async (deps) => {
    const broken = { ...deps, db: { execute: () => Promise.reject(new Error('connection refused')) } as unknown as OpsDeps['db'] };
    expect(await backupPause(broken)).toBe('Backups are paused for now because the ops log in the database could not be read to check for an update that could not be undone (is the database running?). Nothing is backed up or tidied away until it can be read.');
  });
});

test('item 7: a manual backup while paused is refused unless forced', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    await deps.db.insert(opsRuns).values({ kind: 'update', ok: false, detail: '[Acme Test Ltd] URGENT: update to 0.1.6 failed (x) and the automatic undo also failed (y).', snapshotId: 'c323c601aaaabbbb' });
    const r = await manualBackup(deps, { force: false, lockWaitMs: 0 });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Backups are paused because an update could not be undone: backup c323c601 .* A manual backup now would become "latest" in place of the backup the alert names, so it was not taken\. To take one anyway, run: docker compose run --rm ops backup --force$/);
    expect(rec.calls).toEqual([]);
    expect(await manualBackup(deps, { force: true, lockWaitMs: 0 })).toEqual({ ok: true });
    expect(rec.calls.some((c) => c.args[0] === 'backup')).toBe(true);
    expect(rec.calls.some((c) => c.args[0] === 'forget')).toBe(false);   // a manual backup never prunes
  });
});

test('item 9: the sweep removes update-record temp files older than an hour from /state, and keeps fresh ones and the record', async () => {
  const { mkdir, writeFile, utimes, readdir } = await import('node:fs/promises');
  const path = await import('node:path');
  await withDeps({}, async (deps) => {
    const state = path.dirname(deps.cfg.workDir);
    await mkdir(deps.cfg.workDir, { recursive: true });
    const old = path.join(state, '.update-in-progress.json.tmp-aaaa1111');
    await writeFile(old, '{');
    const twoHoursAgo = new Date(Date.now() - 2 * 3600e3);
    await utimes(old, twoHoursAgo, twoHoursAgo);
    await writeFile(path.join(state, '.update-in-progress.json.tmp-bbbb2222'), '{');
    await writeFile(path.join(state, 'update-in-progress.json'), '{}');
    const removed = await sweepLeftovers(deps);
    expect(removed).toContain('file .update-in-progress.json.tmp-aaaa1111');
    const left = await readdir(state);
    expect(left).toContain('.update-in-progress.json.tmp-bbbb2222');
    expect(left).toContain('update-in-progress.json');
    expect(left).not.toContain('.update-in-progress.json.tmp-aaaa1111');
  });
});
