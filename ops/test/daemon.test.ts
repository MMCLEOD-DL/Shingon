import { test, expect } from 'vitest';
import { daemonJobs, onJobFailure } from '../src/daemon.js';
import { Monitor } from '../src/monitor.js';
import { withOpsLock } from '../src/opsLock.js';
import { lastRun, type OpsDeps } from '../src/runs.js';
import { startScheduler } from '../src/scheduler.js';
import { BackupError } from '../src/backup.js';
import { okBackup, withDeps } from './helpers.js';

async function holdLock(deps: OpsDeps): Promise<{ release: () => void; done: Promise<void> }> {
  let release!: () => void, reached!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  const got = new Promise<void>((r) => { reached = r; });
  const done = withOpsLock(deps, { waitMs: 0, busyMessage: 'busy' }, async () => { reached(); await wait; });
  await got;
  return { release, done };
}

test('the monitor keeps ticking every time while a scheduled backup waits for the ops lock, and the backup never piles up', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    const sent: string[] = [];
    let ticks = 0;
    const monitor = new Monitor({ checks: async () => { ticks++; return []; }, channel: { send: async (t) => { sent.push(t); } }, client: 'Acme' });
    let backupStarts = 0;
    // Every second instead of nightly / every minute, so the test is quick.
    const jobs = daemonJobs(deps, { send: async (t) => { sent.push(t); } }, monitor)
      .filter((j) => j.name === 'backup' || j.name === 'monitor')
      .map((j) => ({ ...j, cron: '* * * * * *', run: j.name === 'backup' ? async () => { backupStarts++; await j.run(); } : j.run }));
    expect(jobs.map((j) => j.name).sort()).toEqual(['backup', 'monitor']);
    const held = await holdLock(deps);
    const s = startScheduler(jobs, onJobFailure(deps, monitor));
    try {
      await new Promise((r) => setTimeout(r, 4200));
      expect(backupStarts).toBe(1);      // still waiting for the lock: later runs were skipped, not stacked up
      expect(rec.calls).toEqual([]);
      expect(ticks).toBeGreaterThanOrEqual(3);
      const before = ticks;
      await new Promise((r) => setTimeout(r, 1100));
      expect(ticks).toBeGreaterThan(before);
    } finally {
      s.stop();
      held.release();
      await held.done;
    }
    for (let i = 0; i < 100 && (await lastRun(deps.db, 'backup', { okOnly: true })) === null; i++) await new Promise((r) => setTimeout(r, 100));
    expect((await lastRun(deps.db, 'backup', { okOnly: true }))!.detail).toMatch(/^Backup 01234567 saved/);
    expect(sent).toEqual([]);
  });
}, 20_000);

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
    expect(rec.logs).toEqual(['The alert about the failed scheduled backup could not be sent: Matrix refused the alert (HTTP 502).']);
  });
});
