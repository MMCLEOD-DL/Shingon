import { describe, test, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, writeFile, utimes } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { runBackup, workFiles } from '../src/backup.js';
import { pgEnv } from '../src/pg.js';
import { execRunner } from '../src/runner.js';
import { verifyLatestRestore, restoreDatabase, restoreLive, scratchPrefix, stamp, type SwapFault } from '../src/restore.js';
import { createOpsDeps, daemonJobs, onJobFailure, sweepLeftovers } from '../src/daemon.js';
import { withOpsLock, lockKey, lockSessionName } from '../src/opsLock.js';
import type { OpsDeps } from '../src/runs.js';
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
    await expect(restoreDatabase(deps, 'c'.repeat(64), dbName)).rejects.toThrow(`The saved database could not be put back. The live database ${dbName} has not been changed.`);
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
    const oldDb = `${scratchPrefix(dbName)}${stamp(old)}`;
    const newDb = `${scratchPrefix(dbName)}${stamp(new Date())}`;
    // Another deployment's restore test on the same server: never this deployment's to remove, however old.
    const othersDb = `${scratchPrefix(`${dbName}_other`)}${stamp(old)}`;
    const admin = new pg.Client({ connectionString: deps.cfg.databaseUrl });
    await admin.connect();
    try {
      for (const n of [oldDb, newDb, othersDb, `${dbName}_incoming`, `${dbName}_old`]) await admin.query(`create database "${n}"`);
      const removed = await sweepLeftovers(deps);
      // The live database is there, so its _incoming and _old copies are leftovers.
      expect(removed.sort()).toEqual([`database ${dbName}_incoming`, `database ${dbName}_old`, `database ${oldDb}`, 'folder backup', 'folder restore-old', 'folder verify-old'].sort());
      expect(existsSync(path.join(deps.cfg.workDir, 'verify-new'))).toBe(true);
      expect(existsSync(path.join(deps.cfg.workDir, 'unrelated-old'))).toBe(true);
      const left = await admin.query<{ datname: string }>(`select datname from pg_database where datname in ($1, $2, $3, $4, $5) order by datname`, [oldDb, newDb, othersDb, `${dbName}_incoming`, `${dbName}_old`]);
      expect(left.rows.map((r) => r.datname)).toEqual([newDb, othersDb].sort());
    } finally {
      for (const n of [newDb, othersDb]) await admin.query(`drop database if exists "${n}"`).catch(() => undefined);
      await admin.end();
    }
  });
});

test('a failed scheduled job is logged once: failures that were already recorded are not logged again', async () => {
  await withDeps({}, async (deps, rec) => {
    const hook = onJobFailure(deps);
    await hook('restore-test', Object.assign(new Error('The restore test failed. x'), { reported: true }));
    expect(rec.logs).toEqual([]);
    await hook('some-job', new Error('boom'));
    expect(rec.logs).toEqual(['The scheduled some-job did not work: boom']);
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

/** Holds the ops lock from the test, as another run would, until `release` is called. */
async function holdLock(deps: OpsDeps): Promise<{ release: () => void; done: Promise<void> }> {
  const g = gate();
  const done = withOpsLock(deps, { waitMs: 0, busyMessage: 'busy' }, async () => { g.reach(); await g.wait; });
  await g.reached;
  return { release: g.release, done };
}

test('the startup sweep never drops _incoming or _old when the app database itself is missing, and says which to recover', async () => {
  await withDeps({}, async (base, rec) => {
    const missing = `hf_missing_${stamp(new Date())}`;
    const u = new URL(base.cfg.databaseUrl);
    u.pathname = `/${missing}`;
    const deps: OpsDeps = { ...base, cfg: { ...base.cfg, databaseUrl: u.toString() } };
    const admin = new pg.Client({ connectionString: base.cfg.databaseUrl });
    await admin.connect();
    try {
      for (const n of [`${missing}_old`, `${missing}_incoming`]) await admin.query(`create database "${n}"`);
      expect(await sweepLeftovers(deps)).toEqual([]);
      const left = await admin.query<{ datname: string }>(`select datname from pg_database where datname like $1 order by datname`, [`${missing}_%`]);
      expect(left.rows.map((r) => r.datname)).toEqual([`${missing}_incoming`, `${missing}_old`]);
      expect(rec.logs).toEqual([
        `Warning: the app database ${missing} is missing, but ${missing}_incoming (a restored copy) and ${missing}_old (the data from before an interrupted restore) still exists. Nothing has been removed. Rename the right one to ${missing} by hand (ALTER DATABASE … RENAME TO ${missing}).`,
      ]);
    } finally {
      for (const n of [`${missing}_old`, `${missing}_incoming`]) await admin.query(`drop database if exists "${n}"`).catch(() => undefined);
      await admin.end();
    }
  });
});

test('the sweep says in one plain line when it is skipped because another run is busy, or the database cannot be reached', async () => {
  await withDeps({}, async (deps, rec) => {
    const held = await holdLock(deps);
    expect(await sweepLeftovers(deps)).toEqual([]);
    held.release();
    await held.done;
    expect(rec.logs).toEqual(['Leftovers from earlier runs were not checked because another backup or restore is running. Ops checks again at its next start.']);
    rec.logs.length = 0;
    const u = new URL(deps.cfg.databaseUrl);
    u.port = '1';
    expect(await sweepLeftovers({ ...deps, cfg: { ...deps.cfg, databaseUrl: u.toString() } })).toEqual([]);
    expect(rec.logs).toEqual(['Leftovers from earlier runs were not checked because the database could not be reached. Ops checks again at its next start.']);
  });
});

test('a scheduled backup waits for a running restore test or restore instead of giving up', async () => {
  await withDeps({}, async (deps, rec) => {
    rec.respond(okBackup);
    const held = await holdLock(deps);
    const backup = daemonJobs(deps).find((j) => j.name === 'backup')!.run();
    await new Promise((r) => setTimeout(r, 1500));
    expect(rec.calls).toEqual([]);   // still waiting
    held.release();
    await held.done;
    await backup;
    expect((await lastRun(deps.db, 'backup', { okOnly: true }))!.detail).toMatch(/^Backup 01234567 saved/);
  });
});

test('the app check runs again once the lock is held: an app started while waiting stops the restore', async () => {
  await withDeps({}, async (deps, rec) => {
    const answers: ('stopped' | 'running')[] = ['stopped', 'running'];
    await expect(restoreLive(deps, 'latest', { appState: () => Promise.resolve(answers.shift() ?? 'running') })).rejects.toThrow(/^The app is still running, so nothing has been changed\. Stop both the app and ops first \(docker compose stop app ops\)/);
    expect(answers).toEqual([]);
    expect(rec.calls).toEqual([]);
  });
});

test("restoring ops' own database keeps the ops log entries newer than the backup, busy flag included", async () => {
  await withDeps({}, async (deps, rec) => {
    const url = deps.cfg.databaseUrl;
    const name = pgEnv(url).PGDATABASE;
    // The "backup": a real dump of the database as it is now, handed out by a stand-in for restic.
    const dumpFile = path.join(path.dirname(deps.cfg.workDir), 'backup.dump');
    await mkdir(path.dirname(dumpFile), { recursive: true });
    const d = await execRunner.run('pg_dump', ['--format=custom', '--no-owner', `--file=${dumpFile}`], { env: pgEnv(url), timeoutMs: 60_000 });
    expect(d.code, d.stderr).toBe(0);
    rec.respond(async (c) => {
      if (c.cmd === 'restic' && c.args[0] === 'restore') {
        const to = path.join(c.args[c.args.indexOf('--target') + 1]!, c.args[c.args.indexOf('--include') + 1]!);
        await mkdir(path.dirname(to), { recursive: true });
        await copyFile(dumpFile, to);
        return ok;
      }
      return execRunner.run(c.cmd, c.args, { env: c.env, ...(c.timeoutMs !== undefined ? { timeoutMs: c.timeoutMs } : {}) });
    });
    const later = new Date(Date.now() + 60e3).toISOString();
    await q(url, `insert into ops_runs (kind, ok, detail, busy, at) values
      ('backup', false, 'carried: refused while busy', true, '${later}'),
      ('restore-test', false, 'carried: a real failure', false, '${later}')`);
    await restoreDatabase(deps, 'c'.repeat(64), name);
    expect(await q(url, `select kind, ok, busy, detail from ops_runs where detail like 'carried:%' order by detail`)).toEqual([
      { kind: 'restore-test', ok: false, busy: false, detail: 'carried: a real failure' },
      // without busy, a refusal while another run held the lock would come back as "the last backup failed"
      { kind: 'backup', ok: false, busy: true, detail: 'carried: refused while busy' },
    ]);
  });
});

describe('every failure point of the database swap leaves the data under a name the message gives', () => {
  const dbs = async (url: string, name: string) => (await q(url, `select datname from pg_database where datname in ('${name}', '${name}_old', '${name}_incoming') order by datname`)).map((r) => r['datname']);
  const live = (url: string) => q(url, `select name from teams`);
  async function setup(deps: OpsDeps): Promise<{ name: string; url: string }> {
    await deps.db.execute(sql`insert into teams (name) values ('Still here')`);
    return { name: new URL(deps.cfg.databaseUrl).pathname.slice(1), url: deps.cfg.databaseUrl };
  }
  const withAt = (url: string, db: string): string => { const u = new URL(url); u.pathname = `/${db}`; return u.toString(); };

  test('moving the live database aside fails: it is untouched and the restored copy is removed', async () => {
    await withDeps({}, async (deps) => {
      const { name, url } = await setup(deps);
      await expect(restoreDatabase(deps, 'c'.repeat(64), name, { fault: 'aside' as SwapFault })).rejects.toThrow(`The live database could not be moved aside, so it has not been changed: ${name} still holds the data from before the restore. The restored copy has been removed.`);
      expect(await dbs(url, name)).toEqual([name]);
      expect(await live(url)).toEqual([{ name: 'Still here' }]);
    });
  });

  test('moving the restored copy into place fails: the live database is put back, and the copy is kept and named', async () => {
    await withDeps({}, async (deps) => {
      const { name, url } = await setup(deps);
      await expect(restoreDatabase(deps, 'c'.repeat(64), name, { fault: 'into-place' })).rejects.toThrow(`so the live database was put back as it was: ${name} holds the data from before the restore. The restored copy is kept as ${name}_incoming.`);
      expect(await dbs(url, name)).toEqual([name, `${name}_incoming`]);
      expect(await live(url)).toEqual([{ name: 'Still here' }]);   // connections allowed again
      await q(url, `drop database "${name}_incoming"`);
    });
  });

  test('putting the old one back also fails: both copies are kept, and the message says which holds what', async () => {
    await withDeps({}, async (deps) => {
      const { name, url } = await setup(deps);
      await expect(restoreDatabase(deps, 'c'.repeat(64), name, { fault: 'into-place-and-back' })).rejects.toThrow(`${name}_old holds the data from before the restore and ${name}_incoming holds the restored copy; rename one of them to ${name} by hand.`);
      expect(await dbs(withAt(url, 'postgres'), name)).toEqual([`${name}_incoming`, `${name}_old`]);
      // The sweep must not destroy them while the live database is missing.
      expect(await sweepLeftovers(deps)).toEqual([]);
      const admin = withAt(url, 'postgres');
      expect(await dbs(admin, name)).toEqual([`${name}_incoming`, `${name}_old`]);
      await q(admin, `alter database "${name}_old" with allow_connections true`);
      await q(admin, `alter database "${name}_old" rename to "${name}"`);
      await q(admin, `drop database "${name}_incoming"`);
      expect(await live(url)).toEqual([{ name: 'Still here' }]);
    });
  });

  test('dropping the old copy fails: the restore still counts, and the old copy is named for removal', async () => {
    await withDeps({}, async (deps, rec) => {
      const { name, url } = await setup(deps);
      await restoreDatabase(deps, 'c'.repeat(64), name, { fault: 'drop-old' });
      expect(await dbs(url, name)).toEqual([name, `${name}_old`]);
      expect(rec.logs).toContain(`The restore worked, but the copy of the database from before it (${name}_old) could not be removed. Remove it by hand when convenient.`);
      await q(url, `drop database "${name}_old"`);
    });
  });

  test('the lock is lost before the swap: nothing is renamed or dropped, and the message says where the copy is', async () => {
    await withDeps({}, async (deps, rec) => {
      const { name, url } = await setup(deps);
      rec.respond(async (c) => {
        if (c.cmd === 'pg_restore' && !c.args.includes('--list')) {
          await q(url, `select pg_terminate_backend(pid) from pg_stat_activity where application_name = '${lockSessionName(lockKey(name))}'`);
        }
        return ok;
      });
      await expect(restoreDatabase(deps, 'c'.repeat(64), name)).rejects.toThrow(`The restore stopped before changing anything because ops lost its lock (its database connection dropped). ${name} is unchanged; the restored copy is in ${name}_incoming.`);
      expect(await dbs(url, name)).toEqual([name, `${name}_incoming`]);
      expect(await live(url)).toEqual([{ name: 'Still here' }]);
      await q(url, `drop database "${name}_incoming"`);
    });
  });
});
