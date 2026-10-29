import { test, expect } from 'vitest';
import { monitorChecks } from '../src/checks.js';
import { loadOpsConfig } from '../src/config.js';
import { TEST_BACKUP_PASSWORD, withServer } from './helpers.js';

const env = {
  INSTANCE_MODE: 'test', DATABASE_URL: 'postgres://app:x@127.0.0.1:1/app', APP_INTERNAL_URL: 'http://127.0.0.1:1', CLIENT_LABEL: 'Acme',
  BACKUP_REPOSITORY: 'sftp:backup@nas.test.lan:/srv/restic', BACKUP_PASSWORD: TEST_BACKUP_PASSWORD, HEALTH_TOKEN: 't'.repeat(32),
  OPS_UPLOADS_DIR: '/data/uploads', OPS_WORK_DIR: '/state/work',
};
const roomy = async () => ({ bsize: 4096, blocks: 1e8, bavail: 5e7 });
const byName = (cs: { name: string; ok: boolean; detail: string }[]) => Object.fromEntries(cs.map((c) => [c.name, c]));

test('low disk space is reported per folder, in GB and percent', async () => {
  const cfg = loadOpsConfig(env);
  const cs = byName(await monitorChecks({ cfg, statfs: async () => ({ bsize: 4096, blocks: 1e6, bavail: 50_000 }) }));
  expect(cs['disk:/data/uploads']).toMatchObject({ ok: false, detail: 'Disk space is low on /data/uploads: 0.2 GB free (5%).' });
  expect(cs['disk:/state']).toMatchObject({ ok: false, detail: 'Disk space is low on /state: 0.2 GB free (5%).' });
  // Plenty of percent but under 2 GiB is still low; plenty of both is fine.
  const small = byName(await monitorChecks({ cfg, statfs: async () => ({ bsize: 4096, blocks: 1e6, bavail: 400_000 }) }));
  expect(small['disk:/data/uploads']).toMatchObject({ ok: false, detail: 'Disk space is low on /data/uploads: 1.6 GB free (40%).' });
  expect(byName(await monitorChecks({ cfg, statfs: roomy }))['disk:/state']!.ok).toBe(true);
});

test('backups kept on the box are a standing critical problem', async () => {
  const cs = byName(await monitorChecks({ cfg: loadOpsConfig({ ...env, BACKUP_REPOSITORY: '/state/restic', BACKUP_ALLOW_LOCAL: 'true' }), statfs: roomy }));
  expect(cs['backup-location']).toMatchObject({ ok: false, critical: true, detail: 'Backups are being kept on this box only. This is a development setting and must be changed before real use.' });
  expect(byName(await monitorChecks({ cfg: loadOpsConfig(env), statfs: roomy }))['backup-location']!.ok).toBe(true);
});

test('settings warnings (such as a mismatched tunnel address) are standing critical problems', async () => {
  const cfg = loadOpsConfig({ ...env, TUNNEL_IP: '172.31.0.10' });
  const cs = byName(await monitorChecks({ cfg, statfs: roomy }));
  expect(cs['settings:1']).toMatchObject({ ok: false, critical: true });
  expect(cs['settings:1']!.detail).toMatch(/^TUNNEL_IP \(172\.31\.0\.10\) is not inside EDGE_SUBNET/);
  expect(cs['settings:1']!.detail).toMatch(/The front door stays down until this is fixed\.$/);
});

test('an app that does not answer is reported as such', async () => {
  const cs = await monitorChecks({ cfg: loadOpsConfig(env), statfs: roomy });
  expect(byName(cs)['app']).toEqual({ name: 'app', ok: false, detail: 'The app is not answering.' });
  expect(cs.some((c) => c.name.startsWith('app:'))).toBe(false);
});

test("the app's own checks come back as app:<name>, asked for with the health token", async () => {
  const { createServer } = await import('node:http');
  const seen: (string | undefined)[] = [];
  const srv = createServer((req, res) => {
    seen.push(req.headers['x-health-token'] as string | undefined);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'degraded', checks: [{ name: 'database', ok: true, detail: '' }, { name: 'backups', ok: false, detail: 'No backup has succeeded yet.' }] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const cfg = loadOpsConfig({ ...env, APP_INTERNAL_URL: `http://127.0.0.1:${String((srv.address() as { port: number }).port)}` });
    const cs = byName(await monitorChecks({ cfg, statfs: roomy }));
    expect(seen).toEqual(['t'.repeat(32)]);
    expect(cs['app']).toEqual({ name: 'app', ok: true, detail: '' });
    expect(cs['app:database']).toEqual({ name: 'app:database', ok: true, detail: '' });
    expect(cs['app:backups']).toEqual({ name: 'app:backups', ok: false, detail: 'No backup has succeeded yet.' });
  } finally {
    await new Promise<void>((r) => srv.close(() => { r(); }));
  }
});

test('the tunnel is checked only when it is enabled', async () => {
  expect(byName(await monitorChecks({ cfg: loadOpsConfig(env), statfs: roomy }))['tunnel']).toBeUndefined();
  const cfg = loadOpsConfig({ ...env, TUNNEL_ENABLED: 'true' });
  expect(byName(await monitorChecks({ cfg, statfs: roomy, tunnelUrl: 'http://127.0.0.1:1/ready' }))['tunnel'])
    .toEqual({ name: 'tunnel', ok: false, detail: 'The remote-access tunnel is down, so the operator cannot reach this box.' });
  await withServer(200, async (base) => {
    expect(byName(await monitorChecks({ cfg, statfs: roomy, tunnelUrl: `${base}/ready` }))['tunnel']!.ok).toBe(true);
  });
  await withServer(503, async (base) => {
    expect(byName(await monitorChecks({ cfg, statfs: roomy, tunnelUrl: `${base}/ready` }))['tunnel']!.ok).toBe(false);
  });
});

test('ops check prints one line per check and fails if any check fails', async () => {
  const { formatChecks } = await import('../src/checks.js');
  expect(formatChecks([{ name: 'app', ok: true, detail: '' }, { name: 'disk:/state', ok: false, detail: 'Disk space is low on /state: 0.2 GB free (5%).' }]))
    .toEqual({ lines: ['✓ app', '✗ disk:/state: Disk space is low on /state: 0.2 GB free (5%).'], ok: false });
  expect(formatChecks([{ name: 'app', ok: true, detail: '' }]).ok).toBe(true);
});

test('a disk that does not answer is reported within the time limit, not waited on', async () => {
  const started = Date.now();
  const cs = byName(await monitorChecks({ cfg: loadOpsConfig(env), statfs: () => new Promise(() => undefined), diskTimeoutMs: 100 }));
  expect(Date.now() - started).toBeLessThan(2000);
  expect(cs['disk:/data/uploads']).toEqual({ name: 'disk:/data/uploads', ok: false, detail: 'The free disk space on /data/uploads could not be checked: the disk did not answer in time.' });
});

test('an update record left in /state is a critical problem with plain recovery guidance; one whose update is still running is not', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'hf-rec-'));
  try {
    const work = path.join(dir, 'state', 'work');
    await mkdir(work, { recursive: true });
    const cfg = loadOpsConfig({ ...env, OPS_WORK_DIR: work });
    expect(byName(await monitorChecks({ cfg, statfs: roomy }))['update-record']).toMatchObject({ ok: true });
    const now = new Date('2026-10-26T21:00:00Z');
    const rec = { from: '0.1.5', to: '0.1.6', startedAt: '2026-10-26T20:00:00.000Z', updatedAt: '2026-10-26T20:58:00.000Z', step: 'finishing', snapshot: 'c323c601aaaa', pid: 1, host: 'x' };
    await writeFile(path.join(dir, 'state', 'update-in-progress.json'), JSON.stringify(rec));
    // A finishing update that is still running (its lock refreshed 10 s ago) is not a problem…
    const { utimes: ut } = await import('node:fs/promises');
    const runningLock = path.join(dir, 'state', 'update.lock');
    await writeFile(runningLock, JSON.stringify({ pid: 1, host: 'updater1', at: now.toISOString() }));
    await ut(runningLock, new Date(now.getTime() - 10e3), new Date(now.getTime() - 10e3));
    expect(byName(await monitorChecks({ cfg, statfs: roomy, now: () => now }))['update-record']).toMatchObject({ ok: true });
    // …but the same record with no update lock at all was left behind (the lock is released only after the record is cleared).
    await rm(runningLock);
    expect(byName(await monitorChecks({ cfg, statfs: roomy, now: () => now }))['update-record']).toMatchObject({ ok: false });
    await writeFile(path.join(dir, 'state', 'update-in-progress.json'), JSON.stringify({ ...rec, step: 'migrating' }));
    const c = byName(await monitorChecks({ cfg, statfs: roomy, now: () => now }))['update-record'] as { ok: boolean; critical?: boolean; detail: string };
    expect(c.ok).toBe(false);
    expect(c.critical).toBe(true);
    expect(c.detail).toBe('The update to 0.1.6 (from 0.1.5, started 26 October 2026 at 20:00) stopped part-way while updating the database for 0.1.6 (the database may be partly updated, and .env names 0.1.6), and was never finished or undone. Backup c323c601 holds the data from before the update. No further update will run until this is sorted out. See the runbook, section "Recovering from a failed update"; when it is sorted out, run: docker compose run --rm updater update --mark-recovered');
    // Round 3: another run (a restore test) holding the ops lock does not hide a leftover from the monitor.
    expect(byName(await monitorChecks({ cfg, statfs: roomy, now: () => now, opsLockHeld: async () => true }))['update-record']!.ok).toBe(false);
    // A routine update in progress: its lock names it and was refreshed lately (the heartbeat). Not a problem.
    const lock = path.join(dir, 'state', 'update.lock');
    await writeFile(lock, JSON.stringify({ pid: 1, host: 'updater1', at: now.toISOString() }));
    const { utimes } = await import('node:fs/promises');
    await utimes(lock, new Date(now.getTime() - 30e3), new Date(now.getTime() - 30e3));
    expect(byName(await monitorChecks({ cfg, statfs: roomy, now: () => now }))['update-record']!.ok).toBe(true);
    // Its heartbeat stopped two minutes ago (a crashed updater): a problem again.
    await utimes(lock, new Date(now.getTime() - 120e3), new Date(now.getTime() - 120e3));
    expect(byName(await monitorChecks({ cfg, statfs: roomy, now: () => now }))['update-record']!.ok).toBe(false);
    // An unreadable lock falls back to the ops lock probe (an error asking counts as "not held").
    await writeFile(lock, 'garbage');
    expect(byName(await monitorChecks({ cfg, statfs: roomy, now: () => now, opsLockHeld: async () => true }))['update-record']!.ok).toBe(true);
    expect(byName(await monitorChecks({ cfg, statfs: roomy, now: () => now, opsLockHeld: async () => { throw new Error('down'); } }))['update-record']!.ok).toBe(false);
    await rm(lock);
    await writeFile(path.join(dir, 'state', 'update-in-progress.json'), '{ broken');
    expect(byName(await monitorChecks({ cfg, statfs: roomy, now: () => now }))['update-record']!.ok).toBe(false);   // unreadable is never "no record"
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
