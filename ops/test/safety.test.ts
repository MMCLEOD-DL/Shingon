import { test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile, utimes } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { runBackup, workFiles } from '../src/backup.js';
import { verifyLatestRestore, restoreDatabase, restoreLive, stamp } from '../src/restore.js';
import { createOpsDeps, onJobFailure, sweepLeftovers } from '../src/daemon.js';
import { lastRun } from '../src/runs.js';
import { withDeps, okBackup, q, type Call } from './helpers.js';

const ok = { code: 0, stdout: '', stderr: '' };
const BUSY_BACKUP = /^Another backup or restore is running right now, so this backup did not start\./;
const BUSY_RESTORE = /^Another backup or restore is running, so nothing has been changed\. Stop both the app and ops first \(docker compose stop app ops\)/;

/** A gate a fake restic call can wait on, plus a promise that says the call has been reached. */
function gate(): { reached: Promise<void>; reach: () => void; release: () => void; wait: Promise<void> } {
  let reach!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((r) => { reach = r; });
  const wait = new Promise<void>((r) => { release = r; });
  return { reached, reach, release, wait };
}

const snapshotsJson = (id = 'a'.repeat(64)) => ({ code: 0, stdout: JSON.stringify([{ group_key: {}, snapshots: [{ id, short_id: id.slice(0, 8), time: new Date().toISOString() }] }]), stderr: '' });

test('two overlapping backups: the second fails plainly, and the first one\'s work files are untouched', async () => {
  await withDeps({}, async (deps, rec) => {
    const g = gate();
    let manifestDuring = false;
    rec.respond(async (c) => {
      if (c.args[0] === 'backup') {
        g.reach();
        await g.wait;
        manifestDuring = existsSync(workFiles(deps.cfg.workDir).manifest);
        return okBackup(c);
      }
      return ok;
    });
    const first = runBackup(deps, 'manual');
    await g.reached;
    const before = rec.calls.length;
    await expect(runBackup(deps, 'manual')).rejects.toThrow(BUSY_BACKUP);
    expect(rec.calls.length).toBe(before);   // the loser ran nothing and touched nothing
    expect(existsSync(workFiles(deps.cfg.workDir).manifest)).toBe(true);
    g.release();
    await first;
    expect(manifestDuring).toBe(true);
    expect((await lastRun(deps.db, 'backup', { okOnly: true }))!.detail).toMatch(/^Backup 01234567 saved/);
  });
});

test('a restore refuses after waiting while a backup holds the lock, and goes ahead once the backup finishes', async () => {
  await withDeps({}, async (deps, rec) => {
    const g = gate();
    rec.respond(async (c) => {
      if (c.args[0] === 'backup') { g.reach(); await g.wait; return okBackup(c); }
      return c.args[0] === 'snapshots' ? snapshotsJson() : ok;
    });
    const backup = runBackup(deps, 'manual');
    await g.reached;
    const started = Date.now();
    await expect(restoreLive(deps, 'latest', { lockWaitMs: 400 })).rejects.toThrow(BUSY_RESTORE);
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    // Waits: released 300 ms into a 5 s wait, the restore goes ahead (and stops later only because the fake restic restores nothing).
    const waiting = restoreLive(deps, 'latest', { lockWaitMs: 5000 }).then(() => null, (e: unknown) => e as Error);
    setTimeout(() => { g.release(); }, 300);
    await backup;
    const err = await waiting;
    expect(err?.message).toMatch(/does not contain the uploads folder/);
  });
});

test('a backup refuses while a restore holds the lock, and the restore\'s own safety backup runs under that lock', async () => {
  await withDeps({}, async (deps, rec) => {
    const g = gate();
    rec.respond(async (c) => {
      if (c.args[0] === 'restore') { g.reach(); await g.wait; return ok; }
      return c.args[0] === 'snapshots' ? snapshotsJson() : okBackup(c);
    });
    const restore = restoreLive(deps, 'latest').then(() => null, (e: unknown) => e as Error);
    await g.reached;
    // The safety backup already ran inside the restore, tagged so it is never pruned.
    const safety = rec.calls.find((c: Call) => c.args[0] === 'backup')!;
    expect(safety.args.slice(4, 8)).toEqual(['--tag', 'hf', '--tag', 'safety']);
    expect(safety.args).not.toContain('manual');
    await expect(runBackup(deps, 'scheduled')).rejects.toThrow(BUSY_BACKUP);
    g.release();
    expect((await restore)?.message).toMatch(/does not contain the uploads folder/);
  });
});

test('the app counts as stopped only when the connection is refused: a server that never answers blocks the restore', async () => {
  const sockets = new Set<import('node:net').Socket>();
  const server: Server = createServer(() => { /* never answers */ });
  server.on('connection', (s) => { sockets.add(s); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await withDeps({ APP_INTERNAL_URL: `http://127.0.0.1:${String(port)}` }, async (deps, rec) => {
      await expect(restoreLive(deps, 'latest', { appCheckTimeoutMs: 300 })).rejects.toThrow(/^The app may still be running \(it did not answer clearly\), so nothing has been changed\. Stop both the app and ops first \(docker compose stop app ops\)/);
      expect(rec.calls).toEqual([]);
    });
  } finally {
    for (const s of sockets) s.destroy();
    server.close();
  }
});

test('an empty database is never backed up, so it can never become a "verified" latest backup', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    await deps.db.execute(sql.raw('drop schema public cascade; create schema public'));
    await expect(runBackup(deps, 'scheduled')).rejects.toThrow("The database looks empty, so I did not back it up. Check that DATABASE_URL points at the app's database and that its migrations have run.");
    expect(rec.calls.some((c) => c.cmd === 'pg_dump' || c.args[0] === 'backup')).toBe(false);
    expect(rec.logs.join('\n')).toMatch(/The database looks empty/);
  });
});

test('a restore test fails when the backup record lists no tables, or not the core tables', async () => {
  for (const tables of [{}, { notes: 3 }]) {
    await withDeps({}, async (deps, rec) => {
      rec.respond(async (c) => {
        if (c.args[0] === 'snapshots') return snapshotsJson('b'.repeat(64));
        if (c.args[0] === 'restore') {
          const restored = workFiles(path.join(c.args[3]!, deps.cfg.workDir));
          await mkdir(restored.dir, { recursive: true });
          await writeFile(restored.manifest, JSON.stringify({ createdAt: 'x', app: '1', foundation: '1', tables, files: { count: 0, bytes: 0 } }));
          await writeFile(restored.dump, 'x');
        }
        return ok;
      });
      const r = await verifyLatestRestore(deps);
      expect(r).toEqual({ ok: false, problems: ['The record of backup bbbbbbbb lists no tables, or not the users and files tables, so it cannot prove that a restore works.'] });
      expect(rec.calls.some((c) => c.cmd === 'pg_restore')).toBe(false);
      expect(await lastRun(deps.db, 'restore-test', { okOnly: false })).toMatchObject({ ok: false });
    });
  }
});

test('a restore that fails part-way leaves the live database exactly as it was, with nothing half-made left behind', async () => {
  await withDeps({}, async (deps, rec) => {
    const dbName = new URL(deps.cfg.databaseUrl).pathname.slice(1);
    await deps.db.execute(sql`insert into teams (name) values ('Still here')`);
    rec.respond((c) => (c.cmd === 'pg_restore' && !c.args.includes('--list') ? { code: 1, stdout: '', stderr: 'pg_restore: error: boom' } : ok));
    await expect(restoreDatabase(deps, 'c'.repeat(64), dbName)).rejects.toThrow('The saved database could not be put back. The live database has not been changed.');
    const restoreCall = rec.calls.find((c) => c.cmd === 'pg_restore' && !c.args.includes('--list'))!;
    expect(restoreCall.args).toContain(`--dbname=${dbName}_incoming`);
    expect(await q(deps.cfg.databaseUrl, `select name from teams`)).toEqual([{ name: 'Still here' }]);
    expect(await q(deps.cfg.databaseUrl, `select count(*)::int n from pg_database where datname = '${dbName}_incoming'`)).toEqual([{ n: 0 }]);
  });
});

test('at start the daemon removes leftovers of interrupted runs older than an hour, and nothing newer', async () => {
  await withDeps({}, async (deps) => {
    const dbName = new URL(deps.cfg.databaseUrl).pathname.slice(1);
    const old = new Date(Date.now() - 2 * 3600e3);
    for (const d of ['verify-old', 'restore-old', 'verify-new', 'backup', 'unrelated-old']) await mkdir(path.join(deps.cfg.workDir, d), { recursive: true });
    for (const d of ['verify-old', 'restore-old', 'unrelated-old']) await utimes(path.join(deps.cfg.workDir, d), old, old);
    const oldDb = `hf_restore_test_${stamp(old)}`;
    const newDb = `hf_restore_test_${stamp(new Date())}`;
    const admin = new pg.Client({ connectionString: deps.cfg.databaseUrl });
    await admin.connect();
    try {
      for (const n of [oldDb, newDb, `${dbName}_incoming`]) await admin.query(`create database "${n}"`);
      const removed = await sweepLeftovers(deps);
      expect(removed.sort()).toEqual([`database ${dbName}_incoming`, `database ${oldDb}`, 'folder backup', 'folder restore-old', 'folder verify-old'].sort());
      expect(existsSync(path.join(deps.cfg.workDir, 'verify-new'))).toBe(true);
      expect(existsSync(path.join(deps.cfg.workDir, 'unrelated-old'))).toBe(true);
      const left = await admin.query<{ datname: string }>(`select datname from pg_database where datname in ($1, $2, $3)`, [oldDb, newDb, `${dbName}_incoming`]);
      expect(left.rows.map((r) => r.datname)).toEqual([newDb]);
    } finally {
      await admin.query(`drop database if exists "${newDb}"`).catch(() => undefined);
      await admin.end();
    }
  });
});

test('a failed scheduled job is logged once: failures that were already recorded are not logged again', async () => {
  await withDeps({}, async (deps, rec) => {
    const hook = onJobFailure(deps);
    await hook('restore-test', Object.assign(new Error('The restore test failed. x'), { reported: true }));
    expect(rec.logs).toEqual([]);
    await hook('audit-purge', new Error('boom'));
    expect(rec.logs).toEqual(['The scheduled audit-purge did not work: boom']);
  });
});

test('the manifest is dated by the ops clock', async () => {
  await withDeps({}, async (deps, rec) => {
    deps.now = () => new Date('2026-01-02T03:04:05.000Z');
    let createdAt = '';
    rec.respond((c) => {
      if (c.args[0] === 'backup') createdAt = (JSON.parse(readFileSync(workFiles(deps.cfg.workDir).manifest, 'utf8')) as { createdAt: string }).createdAt;
      return okBackup(c);
    });
    await runBackup(deps, 'manual');
    expect(createdAt).toBe('2026-01-02T03:04:05.000Z');
  });
});

test('the pool ops builds survives its idle connections being killed (as a restore does), and reconnects', async () => {
  await withDeps({}, async (base) => {
    const logs: string[] = [];
    const { deps, close } = createOpsDeps(base.cfg, (l) => logs.push(l));
    try {
      const pid = (await deps.db.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;
      await q(base.cfg.databaseUrl, `select pg_terminate_backend(${String(pid)})`);
      for (let i = 0; i < 50 && logs.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
      expect(logs).toEqual(['A database connection dropped while idle (for example during a restore). Ops will reconnect when it next needs the database.']);
      expect((await deps.db.execute<{ one: number }>(sql`select 1 as one`)).rows).toEqual([{ one: 1 }]);
    } finally {
      await close();
    }
  });
});
