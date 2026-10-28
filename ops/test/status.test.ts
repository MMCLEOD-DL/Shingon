import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import type { Db } from '@hf/server/db';
import { opsRuns } from '@hf/server/db/schema';
import { collectStatus, statusCli, statusCrashLine, statusLines, type OpsStatus, type StatusCliIo } from '../src/status.js';
import type { Check } from '../src/checks.js';
import type { OpsDeps } from '../src/runs.js';
import { TEST_BACKUP_PASSWORD, withDeps } from './helpers.js';

const at = (hhmm: string): Date => new Date(`2026-10-27T${hhmm}:00Z`);   // GMT on 27 October 2026, so UK time is the same
const allOk: Check[] = [{ name: 'app', ok: true, detail: '' }, { name: 'disk:/data/uploads', ok: true, detail: '' }];

/** A database whose every query rejects, as when the database container is down. */
function brokenDb(): Db {
  const fail = (): Promise<never> => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432'));
  const chain: unknown = new Proxy(() => undefined, {
    get: (_t, p) => (p === 'then' ? (res: unknown, rej: (e: unknown) => void) => fail().then(res as never, rej) : chain),
    apply: () => chain,
  });
  return chain as Db;
}

describe('collectStatus', () => {
  test('status lists every check and the latest runs, busy runs left out', async () => {
    await withDeps({}, async (deps) => {
      await deps.db.insert(opsRuns).values([
        { kind: 'backup', ok: true, detail: 'Backup done (3.0 MB).', snapshotId: 'aaaa1111', at: at('01:00') },
        { kind: 'backup', ok: false, busy: true, detail: 'Backup not started: another backup or restore is running.', at: at('02:00') },
        { kind: 'restore-test', ok: false, detail: 'The restore test failed: the uploads did not match.', at: at('03:00') },
        { kind: 'restore-test', ok: true, detail: 'Restore test passed.', at: at('00:30') },
        { kind: 'update', ok: true, detail: 'Updated to 0.2.1.', at: at('00:10') },
      ]);
      const checks: Check[] = [...allOk, { name: 'tunnel', ok: false, critical: true, detail: 'The remote-access tunnel is down.' }];
      const s = await collectStatus({ cfg: deps.cfg, db: deps.db, now: () => at('10:00'), checks: async () => checks });
      expect(s.schema).toBe(1);
      expect(s.client).toBe('Acme Test Ltd');
      expect(s.at).toBe('2026-10-27T10:00:00.000Z');
      expect(s.checks).toEqual([
        { name: 'app', ok: true, critical: false, detail: '' },
        { name: 'disk:/data/uploads', ok: true, critical: false, detail: '' },
        { name: 'tunnel', ok: false, critical: true, detail: 'The remote-access tunnel is down.' },
      ]);
      expect(s.runs).toEqual({
        backup: { at: '2026-10-27T01:00:00.000Z', ok: true, detail: 'Backup done (3.0 MB).' },
        backupOk: { at: '2026-10-27T01:00:00.000Z', ok: true, detail: 'Backup done (3.0 MB).' },
        restoreTest: { at: '2026-10-27T03:00:00.000Z', ok: false, detail: 'The restore test failed: the uploads did not match.' },
        restoreTestOk: { at: '2026-10-27T00:30:00.000Z', ok: true, detail: 'Restore test passed.' },
        update: { at: '2026-10-27T00:10:00.000Z', ok: true, detail: 'Updated to 0.2.1.' },
      });
      expect(s.outstandingUpdate).toBeNull();
      expect(s.problems).toEqual([]);
      expect(s.ok).toBe(false);   // the tunnel check fails
      const fine = await collectStatus({ cfg: deps.cfg, db: deps.db, now: () => at('10:00'), checks: async () => allOk });
      expect(fine.ok).toBe(true);
    });
  });

  test('an update whose undo failed is outstanding until marked recovered', async () => {
    await withDeps({}, async (deps) => {
      await deps.db.insert(opsRuns).values({ kind: 'update', ok: false, detail: '[Acme Test Ltd] URGENT: update to 0.2.1 failed (x) and the automatic undo also failed (y).', snapshotId: 'c323c601', at: at('04:00') });
      const s = await collectStatus({ cfg: deps.cfg, db: deps.db, now: () => at('10:00'), checks: async () => allOk });
      expect(s.outstandingUpdate).toEqual({ at: '2026-10-27T04:00:00.000Z', snapshotId: 'c323c601' });
      expect(s.runs?.update?.ok).toBe(false);
    });
  });

  test('a history with no runs gives nulls, and an empty box is still ok when the checks pass', async () => {
    await withDeps({}, async (deps) => {
      const s = await collectStatus({ cfg: deps.cfg, db: deps.db, now: () => at('10:00'), checks: async () => allOk });
      expect(s.runs).toEqual({ backup: null, backupOk: null, restoreTest: null, restoreTestOk: null, update: null });
      expect(s.ok).toBe(true);
      expect(statusLines(s)).toContain('Last backup: none yet.');
    });
  });

  test('secrets never appear', async () => {
    await withDeps({}, async (deps) => {
      await deps.db.insert(opsRuns).values({ kind: 'backup', ok: false, detail: `Backup failed with ${TEST_BACKUP_PASSWORD} near postgres://app:pw@db/app and https://app:pw@nas.test.lan/x`, at: at('01:00') });
      const s = await collectStatus({
        cfg: deps.cfg, db: deps.db, now: () => at('10:00'),
        checks: async () => [{ name: 'app', ok: false, detail: `The app said ${TEST_BACKUP_PASSWORD} and postgres://app:pw@db/app` }],
      });
      const line = JSON.stringify(s);
      expect(line).not.toContain(TEST_BACKUP_PASSWORD);
      expect(line).not.toContain(':pw@');
      // scrub() first gives postgres://app:***@db/app; redactAlert() then hides any database address whole (its standing rule).
      expect(s.checks[0]!.detail).toBe('The app said [hidden] and [database address hidden]');
      expect(s.runs!.backup!.detail).toBe('Backup failed with [hidden] near [database address hidden] and https://app:***@nas.test.lan/x');
      expect(statusLines(s).join('\n')).not.toContain(TEST_BACKUP_PASSWORD);
    });
  });

  test('a database that cannot be read still gives a status', async () => {
    await withDeps({}, async (deps) => {
      const s = await collectStatus({ cfg: deps.cfg, db: brokenDb(), now: () => at('10:00'), checks: async () => allOk });
      expect(s.runs).toBeNull();
      expect(s.outstandingUpdate).toBeNull();
      expect(s.ok).toBe(false);
      expect(s.problems).toEqual(['The ops log in the database could not be read, so the backup and update history is missing. Is the database running?']);
      expect(s.checks.map((c) => c.name)).toEqual(['app', 'disk:/data/uploads']);
    });
  });

  test('checks that throw are a problem, never a calm status', async () => {
    await withDeps({}, async (deps) => {
      const s = await collectStatus({ cfg: deps.cfg, db: deps.db, now: () => at('10:00'), checks: async () => { throw new Error(`boom ${TEST_BACKUP_PASSWORD}`); } });
      expect(s.ok).toBe(false);
      expect(s.checks).toEqual([]);
      expect(s.problems).toEqual(['The health checks could not be run, so the state of the app, the disks and the tunnel is not known.']);
    });
  });

  test('the JSON is one line', async () => {
    await withDeps({}, async (deps) => {
      await deps.db.insert(opsRuns).values([
        { kind: 'backup', ok: true, detail: 'Backup done.', at: at('01:00') },
        { kind: 'restore-test', ok: false, detail: 'The restore test failed: the uploads did not match.', at: at('03:00') },
        { kind: 'restore-test', ok: true, detail: 'Restore test passed.', at: at('00:30') },
      ]);
      const s = await collectStatus({
        cfg: deps.cfg, db: deps.db, now: () => at('10:00'),
        checks: async () => [{ name: 'app', ok: true, detail: '' }, { name: 'tunnel', ok: false, detail: 'The remote-access tunnel is down.' }],
      });
      const line = JSON.stringify(s);
      expect(line).not.toContain('\n');
      expect(JSON.parse(line)).toEqual(s);
      expect(statusLines(s)).toEqual([
        '✓ app',
        '✗ tunnel: The remote-access tunnel is down.',
        'Last backup: 27 October 2026 at 01:00, done.',
        'Last restore test: 27 October 2026 at 03:00, failed: The restore test failed: the uploads did not match.',
        'Last restore test that passed: 27 October 2026 at 00:30.',
        'Last update: none yet.',
      ]);
    });
  });
});

/** As update-cli.test.ts: standard output and error line by line, deps on a fresh test database in INSTANCE_MODE=demo. */
function io(checks: () => Promise<Check[]> = async () => allOk, db?: Db) {
  const out: string[] = [];
  const err: string[] = [];
  const o: StatusCliIo = {
    out: (l) => { out.push(...l.split('\n')); },
    err: (l) => { err.push(...l.split('\n')); },
    checks: () => checks(),
    withDeps: (fn, log) => withDeps({ INSTANCE_MODE: 'demo' }, async (deps) => {
      await mkdir(path.dirname(deps.cfg.workDir), { recursive: true });
      const d: OpsDeps = { ...deps, log, ...(db !== undefined ? { db } : {}) };
      try {
        return await fn(d);
      } catch (e) {
        err.push((e as Error).message);
        return 1;
      }
    }),
  };
  return { o, out, err };
}

describe('ops status', () => {
  test('--json on a demo box: exactly one line on standard output, the status as JSON; exit 0 when all is well', async () => {
    const t = io();
    expect(await statusCli(['--json'], t.o)).toBe(0);
    expect(t.out).toHaveLength(1);
    const s = JSON.parse(t.out[0]!) as OpsStatus;
    expect(s).toMatchObject({ schema: 1, client: 'Acme Test Ltd', ok: true, problems: [], outstandingUpdate: null });
    expect(s.checks).toHaveLength(2);
  });

  test('--json with a failing check or an unreadable database: still one line, exit 1', async () => {
    const t = io(async () => [{ name: 'app', ok: false, detail: `down ${TEST_BACKUP_PASSWORD}` }], brokenDb());
    expect(await statusCli(['--json'], t.o)).toBe(1);
    expect(t.out).toHaveLength(1);
    expect(t.out[0]).not.toContain(TEST_BACKUP_PASSWORD);
    const s = JSON.parse(t.out[0]!) as OpsStatus;
    expect(s.ok).toBe(false);
    expect(s.runs).toBeNull();
  });

  test('without --json: plain lines on standard output, no JSON', async () => {
    const t = io();
    expect(await statusCli([], t.o)).toBe(0);
    expect(t.out).toEqual(['✓ app', '✓ disk:/data/uploads', 'Last backup: none yet.', 'Last restore test: none yet.', 'Last update: none yet.']);
    expect(t.err).toEqual([]);
  });

  test('an unexpected throw under --json gives one line that is never calmer than reality', async () => {
    const t = io();
    t.o.withDeps = async (_fn, log) => { log('Ops stopped because of an unexpected problem: x.'); return 1; };
    expect(await statusCli(['--json'], t.o)).toBe(1);
    expect(t.out).toHaveLength(1);
    const s = JSON.parse(t.out[0]!) as OpsStatus;
    expect(s).toMatchObject({ schema: 1, ok: false, checks: [], runs: null, outstandingUpdate: null });
    expect(s.problems).toEqual(['The status could not be collected because of an unexpected problem, so nothing about this box is known. The details are on standard error.']);
    expect(t.err).toContain('Ops stopped because of an unexpected problem: x.');
  });

  test('settings that cannot be read: one line under --json, exit 2', async () => {
    const t = io();
    t.o.withDeps = async () => 2;
    expect(await statusCli(['--json'], t.o)).toBe(2);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out[0]!).problems).toEqual(['The ops settings could not be read, so no status could be collected. The problem is on standard error.']);
  });

  test('anything but --json is a usage error (exit 2); with --json it still prints one line', async () => {
    const t = io();
    expect(await statusCli(['--verbose'], t.o)).toBe(2);
    expect(t.out).toEqual([]);
    expect(t.err[0]).toBe('status takes only --json.');
    const j = io();
    expect(await statusCli(['--json', '--verbose'], j.o)).toBe(2);
    expect(j.out).toHaveLength(1);
    expect(JSON.parse(j.out[0]!).problems).toEqual(['status takes only --json.']);
  });

  test('a crash that escapes the command: the last-resort line, only for status --json', () => {
    const line = statusCrashLine(['status', '--json']);
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ schema: 1, ok: false, runs: null });
    expect(statusCrashLine(['status'])).toBeUndefined();
    expect(statusCrashLine(['update', '--json'])).toBeUndefined();
  });
});
