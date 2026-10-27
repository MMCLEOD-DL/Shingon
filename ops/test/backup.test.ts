import { describe, test, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { runBackup, BackupError } from '../src/backup.js';
import { pgEnv } from '../src/pg.js';
import { verifyLatestRestore, restoreDatabase, restoreLive, scratchPrefix } from '../src/restore.js';
import { lastRun } from '../src/runs.js';
import { purgeAuditLog, onJobFailure } from '../src/daemon.js';
import { withDeps, okBackup, deps0, TEST_BACKUP_PASSWORD } from './helpers.js';

const ok = { code: 0, stdout: '', stderr: '' };

test('first backup creates the repository; secrets go only in env', async () => {
  const calls = await withDeps({ BACKUP_REPOSITORY: 'sftp:b@nas:/r' }, async (deps, rec) => {
    rec.respond((c) => c.cmd === 'restic' && c.args[0] === 'cat' ? { code: 1, stdout: '', stderr: 'Fatal: unable to open config file: stat: no such file' }
      : c.cmd === 'restic' && c.args[0] === 'backup' ? { code: 0, stdout: '{"message_type":"summary","snapshot_id":"abcdef1234567890","total_bytes_processed":5242880}\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' });
    const r = await runBackup(deps, 'scheduled');
    expect(r.snapshotId).toBe('abcdef1234567890');
    return rec.calls;
  });
  expect(calls.map((c) => `${c.cmd} ${c.args[0] ?? ''}`)).toEqual(['restic cat', 'restic init', 'pg_dump --format=custom', 'restic backup', 'restic forget', 'restic forget']);
  for (const c of calls) {
    expect(c.args.join(' ')).not.toContain(TEST_BACKUP_PASSWORD);
    expect(c.args.join(' ')).not.toMatch(/postgres:\/\//);
  }
  expect(calls.find((c) => c.args[0] === 'backup')!.env.RESTIC_PASSWORD).toBe(TEST_BACKUP_PASSWORD);
});

test('an unreachable destination fails loudly, in plain English, and is recorded', async () => {
  await withDeps({ BACKUP_REPOSITORY: 'rest:https://u:pw@nas:8000/acme' }, async (deps, rec) => {
    rec.respond((c) => c.cmd === 'restic' ? { code: 1, stdout: '', stderr: 'Fatal: unable to open repository at rest:https://u:***@nas:8000/acme: dial tcp: connection refused' } : { code: 0, stdout: '', stderr: '' });
    await expect(runBackup(deps, 'pre-update')).rejects.toThrow('The backup destination could not be reached (rest:https://nas:8000/acme).');
    expect(await lastRun(deps.db, 'backup', { okOnly: false })).toMatchObject({ ok: false, detail: 'The backup destination could not be reached (rest:https://nas:8000/acme).' });
  });
});

test('the dump and the manifest come from one snapshot, from a fixed folder, and snapshots are grouped by host', async () => {
  const calls = await withDeps({}, async (deps, rec) => { rec.respond(okBackup); await runBackup(deps, 'scheduled'); return rec.calls; });
  const dump = calls.find((c) => c.cmd === 'pg_dump')!;
  expect(dump.args.some((a) => /^--snapshot=[0-9A-F]+-[0-9A-F]+-\d+$/.test(a))).toBe(true);
  expect(dump.args).toContain(`--file=${deps0.cfg.workDir}/backup/db.dump`);
  const backup = calls.find((c) => c.args[0] === 'backup')!;
  expect(backup.args).toEqual(expect.arrayContaining([`${deps0.cfg.workDir}/backup/db.dump`, `${deps0.cfg.workDir}/backup/manifest.json`, deps0.cfg.uploadsDir]));
  const [pre, forget] = calls.filter((c) => c.args[0] === 'forget');
  // Scheduled and manual backups only. Safety backups are outside every policy (never pruned); pre-update backups are
  // outside the daily one too, because a failed update's alert names one (Task 20 review): they have their own rule,
  // applied first and without pruning.
  expect(pre!.args).toEqual(['forget', '--tag', 'hf,pre-update', '--group-by', 'host', '--host', 'acme-test-ltd', '--keep-last', '5', '--keep-within', '30d']);
  expect(forget!.args.slice(0, 5)).toEqual(['forget', '--tag', 'hf,scheduled', '--tag', 'hf,manual']);
  expect(forget!.args.slice(5, 10)).toEqual(['--group-by', 'host', '--host', 'acme-test-ltd', '--prune']);
  expect(forget!.args).not.toContain('safety');
  expect(forget!.args.join(' ')).not.toContain('pre-update');
});

test('a pre-update backup does not prune', async () => {
  const calls = await withDeps({}, async (deps, rec) => { rec.respond(okBackup); await runBackup(deps, 'pre-update'); return rec.calls; });
  expect(calls.some((c) => c.args[0] === 'forget')).toBe(false);
});

test('a successful backup is recorded, tidies its work files and names the host and kind', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    await runBackup(deps, 'manual');
    const backup = rec.calls.find((c) => c.args[0] === 'backup')!;
    expect(backup.args.slice(0, 8)).toEqual(['backup', '--json', '--host', 'acme-test-ltd', '--tag', 'hf', '--tag', 'manual']);
    expect(await lastRun(deps.db, 'backup', { okOnly: true })).toMatchObject({ ok: true, detail: 'Backup 01234567 saved to sftp:backup@nas.test.lan:/srv/restic: 3 MB.' });
    expect(existsSync(`${deps.cfg.workDir}/backup/db.dump`)).toBe(false);
    expect(existsSync(`${deps.cfg.workDir}/backup/manifest.json`)).toBe(false);
    const runs = await deps.db.execute<{ snapshot_id: string }>(sql`select snapshot_id from ops_runs where kind = 'backup'`);
    expect(runs.rows).toEqual([{ snapshot_id: '0123456789abcdef0123456789abcdef' }]);
  });
});

test('restic is always given a time limit, and a destination that never answers gives a plain, recorded failure', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond((c) => c.cmd === 'restic' ? { code: -1, stdout: '', stderr: '', timedOut: true } : ok);
    await expect(runBackup(deps, 'scheduled')).rejects.toThrow(/^The backup destination did not answer within 2 minutes \(sftp:backup@nas\.test\.lan:\/srv\/restic\)\./);
    for (const c of rec.calls) expect(c.timeoutMs, `${c.cmd} ${c.args[0]!}`).toBeGreaterThan(0);
    expect((await lastRun(deps.db, 'backup', { okOnly: false }))!.ok).toBe(false);
  });
});

test('busy, wrong-password, unreadable-database and unknown failures each have their own plain message, with no secret', async () => {
  const cases: [Parameters<typeof withDeps>[0], (c: { cmd: string; args: string[] }) => { code: number; stdout: string; stderr: string }, string][] = [
    [{}, (c) => c.cmd === 'restic' ? { code: 1, stdout: '', stderr: 'Fatal: unable to create lock in backend: repository is already locked by PID 7' } : ok,
      'The backup destination is busy with another backup or check (sftp:backup@nas.test.lan:/srv/restic). Try again in a few minutes.'],
    [{}, (c) => c.cmd === 'restic' ? { code: 1, stdout: '', stderr: 'Fatal: wrong password or no key found' } : ok, 'The backup password does not match the backup destination.'],
    [{}, (c) => c.cmd === 'pg_dump' ? { code: 1, stdout: '', stderr: 'pg_dump: error: connection failed' } : ok, 'The database could not be read for the backup.'],
    [{}, (c) => c.cmd === 'restic' && c.args[0] === 'backup' ? { code: 1, stdout: '', stderr: `\nFatal: something odd happened ${TEST_BACKUP_PASSWORD}\nmore` } : ok,
      'The backup failed (restic stopped with code 1).'],
    [{}, (c) => c.cmd === 'restic' ? { code: 1, stdout: '', stderr: 'Fatal: unable to open config file: unexpected HTTP response (401): 401 Unauthorized' } : ok,
      'The backup destination refused the sign-in details (sftp:backup@nas.test.lan:/srv/restic). Check the destination\'s user name and password settings.'],
    [{}, (c) => c.cmd === 'restic' ? { code: 1, stdout: '', stderr: 'Fatal: Save(<data/ab>) failed: unexpected HTTP response (500): 500 Internal Server Error' } : ok,
      'The backup destination had a fault of its own (HTTP 500) (sftp:backup@nas.test.lan:/srv/restic). Try again later; if it keeps happening, check the destination.'],
    [{}, (c) => c.cmd === 'restic' && c.args[0] === 'backup' ? { code: 1, stdout: '', stderr: 'Fatal: unable to save snapshot: write /srv/x: no space left on device' } : ok,
      'There is not enough disk space for the backup, either at the backup destination (sftp:backup@nas.test.lan:/srv/restic) or in the ops work folder on this box.'],
    [{}, (c) => c.cmd === 'restic' && c.args[0] === 'cat' ? { code: 1, stdout: '', stderr: 'Fatal: some other trouble' } : ok,
      'The backup failed (restic stopped with code 1).'],
  ];
  for (const [env, respond, message] of cases) {
    await withDeps(env, async (deps, rec) => {
      rec.respond(respond);
      const err = await runBackup(deps, 'scheduled').then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(BackupError);
      expect((err as Error).message).toBe(message);
      expect((await lastRun(deps.db, 'backup', { okOnly: false }))!.detail).toBe(message);
      expect(rec.logs.join('\n')).not.toContain(TEST_BACKUP_PASSWORD);
    });
  }
});

test('a local repository is refused before anything runs unless BACKUP_ALLOW_LOCAL is true', async () => {
  await withDeps({ BACKUP_ALLOW_LOCAL: 'true', BACKUP_REPOSITORY: '/srv/restic' }, async (deps, rec) => {
    rec.respond(okBackup);
    deps.cfg.backup.allowLocal = false;   // as if the flag were switched off after start-up
    await expect(runBackup(deps, 'manual')).rejects.toThrow(/points at this box/);
    expect(rec.calls).toEqual([]);
    expect((await lastRun(deps.db, 'backup', { okOnly: false }))!.detail).toMatch(/points at this box/);
  });
  await withDeps({ BACKUP_ALLOW_LOCAL: 'true', BACKUP_REPOSITORY: '/srv/restic' }, async (deps, rec) => {
    rec.respond(okBackup);
    await runBackup(deps, 'manual');
    // The standing warning is written down with every backup, and logged.
    expect((await lastRun(deps.db, 'backup', { okOnly: true }))!.detail).toMatch(/Warning: this backup is kept on this same machine \(BACKUP_ALLOW_LOCAL=true\)/);
    expect(rec.logs.join('\n')).toMatch(/BACKUP_ALLOW_LOCAL/);
  });
});

test('restore test: no backups yet, and a destination it cannot read, are both recorded as failures', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond((c) => c.args[0] === 'snapshots' ? { code: 0, stdout: '[]', stderr: '' } : ok);
    expect(await verifyLatestRestore(deps)).toEqual({ ok: false, problems: ['There are no backups yet.'] });
    expect(await lastRun(deps.db, 'restore-test', { okOnly: false })).toMatchObject({ ok: false, detail: 'There are no backups yet.' });
    expect(rec.calls.find((c) => c.args[0] === 'snapshots')!.args).toEqual(['snapshots', '--json', '--tag', 'hf,scheduled', '--tag', 'hf,manual', '--tag', 'hf,pre-update', '--group-by', 'host', '--host', 'acme-test-ltd', '--latest', '1']);
  });
  await withDeps({}, async (deps, rec) => {
    const at = new Date(Date.now() - 30 * 3600e3).toISOString();
    rec.respond((c) => c.args[0] === 'snapshots'
      ? { code: 0, stdout: JSON.stringify([{ group_key: { hostname: 'acme' }, snapshots: [{ id: 'f'.repeat(64), short_id: 'ffffffff', time: at }] }]), stderr: '' }
      : c.args[0] === 'restore' ? { code: 1, stdout: '', stderr: 'Fatal: load index: ciphertext verification failed' } : ok);
    const r = await verifyLatestRestore(deps);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([
      'The newest backup is 30 hours old (expected one every day).',
      'Backup ffffffff could not be restored: some of the saved data could not be read back from sftp:backup@nas.test.lan:/srv/restic, so the copy there may be damaged.',
    ]);
    expect((await lastRun(deps.db, 'restore-test', { okOnly: false }))!.detail).toBe(r.problems.join(' '));
    const leftover = await deps.db.execute(sql`select datname from pg_database where starts_with(datname, ${scratchPrefix(pgEnv(deps.cfg.databaseUrl).PGDATABASE)})`);
    expect(leftover.rows).toEqual([]);
  });
});

test('restore-test scratch databases are named per deployment: hf_rt_<lock key in hex>_', () => {
  expect(scratchPrefix('app')).toMatch(/^hf_rt_[0-9a-f]{8}_$/);
  expect(scratchPrefix('app')).toBe(scratchPrefix('app'));
  expect(scratchPrefix('app')).not.toBe(scratchPrefix('app2'));
  // the longest app database name ops accepts still leaves a legal (≤63 character) scratch name
  expect(`${scratchPrefix('x'.repeat(54))}${'2'.repeat(14)}_abcdef`.length).toBeLessThanOrEqual(63);
});

test('a rollback restore refuses a database name that is not a plain identifier, before touching anything', async () => {
  await withDeps({}, async (deps, rec) => {
    await expect(restoreDatabase(deps, 'abc', 'app"; drop database x; --')).rejects.toThrow(/not a database name ops can restore into/);
    expect(rec.calls).toEqual([]);
  });
});

test('ops restore refuses while the app answers, before touching anything', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => { res.end('{"status":"ok"}'); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await withDeps({ APP_INTERNAL_URL: `http://127.0.0.1:${String(port)}` }, async (deps, rec) => {
      await expect(restoreLive(deps, 'latest')).rejects.toThrow(/^The app is still running, so nothing has been changed\. Stop both the app and ops first \(docker compose stop app ops\)/);
      expect(rec.calls).toEqual([]);
    });
  } finally {
    server.close();
  }
});

test('ops restore chooses "latest" before its safety backup, and a failure names the safety backup to go back to', async () => {
  await withDeps({}, async (deps, rec) => {
    const at = new Date().toISOString();
    rec.respond((c) => c.args[0] === 'snapshots'
      ? { code: 0, stdout: JSON.stringify([{ group_key: {}, snapshots: [{ id: 'a'.repeat(64), short_id: 'aaaaaaaa', time: at }] }]), stderr: '' }
      : okBackup(c));
    // The fake restic restores nothing, so the uploads folder is missing from the "restored" copy.
    const err = await restoreLive(deps, 'latest').then(() => null, (e: unknown) => e as Error);
    expect(err?.message).toBe('Backup aaaaaaaa does not contain the uploads folder, so nothing has been changed. The data as it was before this restore is in safety backup 01234567: restore that id (not latest) to go back.');
    const order = rec.calls.map((c) => `${c.cmd} ${c.args[0] ?? ''}`);
    expect(order.indexOf('restic snapshots')).toBeLessThan(order.indexOf('restic backup'));
    expect(rec.calls.find((c) => c.args[0] === 'restore')!.args.slice(0, 2)).toEqual(['restore', 'a'.repeat(64)]);
    expect(await lastRun(deps.db, 'restore', { okOnly: false })).toMatchObject({ ok: false, detail: err!.message });
  });
});

test('the daily audit-log tidy-up uses the retention setting and is recorded', async () => {
  await withDeps({ AUDIT_RETENTION_DAYS: '30' }, async (deps) => {
    await deps.db.execute(sql`insert into audit_log (actor_label, action, at) values ('system', 'seed.demo', now() - interval '40 days'), ('system', 'seed.demo', now() - interval '10 days')`);
    expect(await purgeAuditLog(deps)).toBe(1);
    expect(await lastRun(deps.db, 'audit-purge', { okOnly: true })).toMatchObject({ detail: 'Audit log tidied: 1 entry older than 30 days removed.' });
  });
});

test('a failed audit-log tidy-up is recorded and logged once, and marked so the failure hook does not log it again', async () => {
  await withDeps({}, async (deps, rec) => {
    await deps.db.execute(sql`drop function audit_purge_before(timestamptz)`);
    const err = await purgeAuditLog(deps).then(() => null, (e: unknown) => e as Error & { reported?: boolean });
    expect(err?.reported).toBe(true);
    const line = 'The audit log could not be tidied. Check that the database is running and up to date.';
    expect(rec.logs).toEqual([line]);
    await onJobFailure(deps)('audit-purge', err!);
    expect(rec.logs).toEqual([line]);
    expect(await lastRun(deps.db, 'audit-purge', { okOnly: false })).toMatchObject({ ok: false, detail: line });
  });
});

test('a scheduled backup asked to pause pruning saves the backup but tidies nothing away', async () => {
  const calls = await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    await runBackup(deps, 'scheduled', { prunePause: async () => 'Backups are paused because an update could not be undone.' });
    expect(rec.logs).toContain('Old backups were not tidied away. Backups are paused because an update could not be undone.');
    return rec.calls;
  });
  expect(calls.some((c) => c.args[0] === 'forget')).toBe(false);
  expect(calls.some((c) => c.args[0] === 'backup')).toBe(true);
});

describe('ops restore <backup id> checks the backup was made by this box', () => {
  const snap = (host: string) => ({ code: 0, stdout: JSON.stringify([{ id: 'b'.repeat(64), short_id: 'bbbbbbbb', time: new Date().toISOString(), hostname: host }]), stderr: '' });

  test("another box's backup is refused before the safety backup, and nothing is changed", async () => {
    await withDeps({}, async (deps, rec) => {
      rec.respond((c) => c.args[0] === 'snapshots' ? snap('other-client') : okBackup(c));
      const err = await restoreLive(deps, 'bbbbbbbb').then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toBe('Backup bbbbbbbb was made by another box ("other-client"), not this one ("acme-test-ltd"), so nothing has been changed. To put another box\'s backup on this one on purpose, run the restore again with --any-host.');
      expect(rec.calls.map((c) => c.args.slice(0, 3))).toEqual([['snapshots', '--json', 'bbbbbbbb']]);
      expect(await lastRun(deps.db, 'restore', { okOnly: false })).toMatchObject({ ok: false, detail: err!.message });
    });
  });

  test('--any-host lets it through (after the safety backup), and says so in the log', async () => {
    await withDeps({}, async (deps, rec) => {
      rec.respond((c) => c.args[0] === 'snapshots' ? snap('other-client') : okBackup(c));
      // The fake restic restores nothing, so the restore stops at the missing uploads folder: far enough to prove the check passed.
      const err = await restoreLive(deps, 'bbbbbbbb', { anyHost: true }).then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toMatch(/^Backup bbbbbbbb does not contain the uploads folder, so nothing has been changed\./);
      expect(rec.logs).toContain('Backup bbbbbbbb was made by another box ("other-client"); restoring it here because --any-host was given.');
      expect(rec.calls.find((c) => c.args[0] === 'restore')!.args.slice(0, 2)).toEqual(['restore', 'b'.repeat(64)]);
    });
  });

  test("this box's own backup by id goes ahead without --any-host; an unknown id is refused plainly", async () => {
    await withDeps({}, async (deps, rec) => {
      rec.respond((c) => c.args[0] === 'snapshots' ? snap('acme-test-ltd') : okBackup(c));
      const err = await restoreLive(deps, 'bbbbbbbb').then(() => null, (e: unknown) => e as Error);
      expect(err?.message).toMatch(/^Backup bbbbbbbb does not contain the uploads folder/);
      rec.respond((c) => c.args[0] === 'snapshots' ? { code: 0, stdout: '[]', stderr: '' } : okBackup(c));
      await expect(restoreLive(deps, 'cccccccc')).rejects.toThrow('There is no backup cccccccc at sftp:backup@nas.test.lan:/srv/restic, so nothing has been changed.');
    });
  });
});
