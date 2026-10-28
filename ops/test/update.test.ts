import { test, expect } from 'vitest';
import { runUpdate, httpWaitReady, frontDoorCheck, type UpdateDeps } from '../src/update.js';
import { updateExitCode, updateOutcomeJson, UPDATE_EXIT, UNKNOWN_UPDATE_MESSAGE } from '../src/update.js';
import { OpsBusyError } from '../src/opsLock.js';
import { ROLLBACK_FAILED_MARK } from '@hf/server/db/schema';

function fakes(over: Partial<{ images: boolean; backup: 'ok' | 'fail'; migrate: boolean; readyNew: boolean; readyOld: boolean; restoreThrows: boolean; locked: boolean }> = {}) {
  const o = { images: true, backup: 'ok', migrate: true, readyNew: true, readyOld: true, restoreThrows: false, locked: false, ...over };
  const log: string[] = [], alerts: string[] = [], records: [boolean, string][] = [];
  let tag = '1.0.0';
  const deps: UpdateDeps = {
    compose: {
      imageAvailable: async (i) => { log.push(`image ${i}`); return o.images; },
      stop: async (s) => { log.push(`stop ${s}`); },
      up: async (s) => { log.push(`up ${s}@${tag}`); },
      runOnce: async (s) => { log.push(`run ${s}@${tag}`); return { ok: o.migrate, output: o.migrate ? '' : 'error: column "x" does not exist' }; },
      readTag: async () => tag,
      writeTag: async (t) => { log.push(`tag ${t}`); tag = t; },
    },
    backup: async () => { log.push('backup'); if (o.backup === 'fail') throw new Error('The backup destination could not be reached (sftp:b@nas:/r).'); return { snapshotId: 'abcdef1234567890' }; },
    restoreDb: async (id) => { log.push(`restore ${id}`); if (o.restoreThrows) throw new Error('pg_restore failed'); },
    waitReady: async (v) => { log.push(`wait ${v}`); const ok = v === '1.1.0' ? o.readyNew : o.readyOld; return { ok, detail: ok ? '' : `the new version did not become healthy within 3 minutes` }; },
    alert: { send: async (t) => { alerts.push(t); } },
    record: async (ok, d) => { records.push([ok, d]); },
    client: 'Acme', images: { app: 'highland/app', ops: 'highland/ops' },
    lock: { acquire: async () => !o.locked, release: async () => { log.push('unlock'); } },
    timeoutMs: 1000,
  };
  return { deps, log, alerts, records, tag: () => tag };
}

test('happy path: stop app and monitor, backup, switch, migrate, start, check, monitor back', async () => {
  const f = fakes();
  expect(await runUpdate(f.deps, { to: '1.1.0' })).toEqual({ outcome: 'updated', message: '[Acme] Updated from 1.0.0 to 1.1.0. A backup (abcdef12) was taken first.' });
  expect(f.log).toEqual(['image highland/app:1.1.0', 'image highland/ops:1.1.0', 'stop app', 'stop ops', 'backup', 'tag 1.1.0', 'run migrate@1.1.0', 'up app@1.1.0', 'wait 1.1.0', 'up ops@1.1.0', 'unlock']);
  expect(f.alerts).toEqual(['[Acme] Updated from 1.0.0 to 1.1.0. A backup (abcdef12) was taken first.']);
  expect(f.records).toEqual([[true, '[Acme] Updated from 1.0.0 to 1.1.0. A backup (abcdef12) was taken first.']]);
});

test('backup destination unreachable: nothing changes and the old app comes back', async () => {
  const f = fakes({ backup: 'fail' });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('cancelled');
  expect(f.alerts[0]).toBe('[Acme] Update to 1.1.0 cancelled: The backup destination could not be reached (sftp:b@nas:/r). Nothing was changed; the app is running 1.0.0 again.');
  expect(f.log).not.toContain('tag 1.1.0');
  expect(f.log.slice(f.log.indexOf('backup') + 1)).toEqual(['up app@1.0.0', 'up ops@1.0.0', 'unlock']);   // the monitor comes back too
  expect(f.tag()).toBe('1.0.0');
});

test('a failed migration restores the backup and the old version', async () => {
  const f = fakes({ migrate: false });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('rolled-back');
  expect(f.log.slice(f.log.indexOf('run migrate@1.1.0') + 1)).toEqual(['stop app', 'restore abcdef1234567890', 'tag 1.0.0', 'up app@1.0.0', 'wait 1.0.0', 'up ops@1.0.0', 'unlock']);
  expect(f.alerts[0]).toBe('[Acme] Update to 1.1.0 failed (the database update failed), so it was undone automatically. The app is back on 1.0.0 with its data exactly as it was before the update.');
});

test('the new version never gets healthy: rolled back', async () => {
  const f = fakes({ readyNew: false });
  expect((await runUpdate(f.deps, { to: '1.1.0' })).outcome).toBe('rolled-back');
  expect(f.tag()).toBe('1.0.0');
});

test('if the undo fails too, the alert is urgent and names the backup', async () => {
  const f = fakes({ readyNew: false, restoreThrows: true });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('rollback-failed');
  expect(f.alerts[0]).toMatch(/^\[Acme\] URGENT: update to 1\.1\.0 failed \(.+\) and the automatic undo also failed \(pg_restore failed\)\. The app may be down\. Backup abcdef12 holds the data from before the update\./);
  expect(f.records[0]![0]).toBe(false);
});

test('missing images or a second update cancel before touching anything', async () => {
  const a = fakes({ images: false });
  expect((await runUpdate(a.deps, { to: '1.1.0' })).outcome).toBe('cancelled');
  expect(a.log).not.toContain('stop app');
  const b = fakes({ locked: true });
  expect(await runUpdate(b.deps, { to: '1.1.0' })).toEqual({ outcome: 'cancelled', message: 'Another update is already running.' });
  expect(b.log).toEqual([]);
});

// ── Beyond the brief: requirements carried from the Task 18/19 reviews ─────────────────────────────────────────────

test('missing images: the plain alert, and the record says it was not a lock refusal', async () => {
  const f = fakes({ images: false });
  f.deps.images = { app: 'registry.example.com/highland/app', ops: 'registry.example.com/highland/ops' };
  const busy: (boolean | undefined)[] = [];
  f.deps.record = async (ok, d, opts) => { f.records.push([ok, d]); busy.push(opts?.busy); };
  await runUpdate(f.deps, { to: '1.1.0' });
  expect(f.alerts).toEqual(['[Acme] Update to 1.1.0 cancelled: the new version is not on this box yet. Nothing was changed.']);
  expect(f.records).toEqual([[false, '[Acme] Update to 1.1.0 cancelled: the new version is not on this box yet. Nothing was changed.']]);
  expect(busy).toEqual([undefined]);
});

test('a second update is recorded once, as a busy refusal, with no alert; the lock is not released by the loser', async () => {
  const f = fakes({ locked: true });
  const recs: [boolean, string, boolean | undefined][] = [];
  f.deps.record = async (ok, d, opts) => { recs.push([ok, d, opts?.busy]); };
  await runUpdate(f.deps, { to: '1.1.0' });
  expect(recs).toEqual([[false, 'Another update is already running.', true]]);
  expect(f.alerts).toEqual([]);
  expect(f.log).not.toContain('unlock');
});

test('already on that version: cancelled, nothing touched, no alert', async () => {
  const f = fakes();
  expect(await runUpdate(f.deps, { to: '1.0.0' })).toEqual({ outcome: 'cancelled', message: 'Already on 1.0.0.' });
  expect(f.log).toEqual(['unlock']);
  expect(f.alerts).toEqual([]);
  expect(f.records).toEqual([[false, 'Already on 1.0.0.']]);
});

test('the whole update runs inside the ops lock (Task 18), so no backup, restore test or restore can interleave', async () => {
  const f = fakes();
  let inside = false;
  const seen: boolean[] = [];
  f.deps.exclusive = async (fn) => { inside = true; f.log.push('ops-lock'); try { return await fn(); } finally { inside = false; f.log.push('ops-unlock'); } };
  const wrap = f.deps.compose;
  f.deps.compose = { ...wrap, stop: async (s) => { seen.push(inside); await wrap.stop(s); }, up: async (s) => { seen.push(inside); await wrap.up(s); } };
  f.deps.backup = async () => { seen.push(inside); f.log.push('backup'); return { snapshotId: 'abcdef1234567890' }; };
  expect((await runUpdate(f.deps, { to: '1.1.0' })).outcome).toBe('updated');
  expect(seen.every(Boolean)).toBe(true);
  expect(f.log[0]).toBe('ops-lock');
  expect(f.log.slice(-2)).toEqual(['ops-unlock', 'unlock']);
});

test('a running backup or restore that keeps the ops lock cancels the update before anything is stopped (busy, no alert)', async () => {
  const f = fakes();
  const recs: [boolean, string, boolean | undefined][] = [];
  f.deps.record = async (ok, d, opts) => { recs.push([ok, d, opts?.busy]); };
  f.deps.exclusive = async () => { throw new OpsBusyError('busy'); };
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r).toEqual({ outcome: 'cancelled', message: 'A backup or restore is still running, so the update to 1.1.0 did not start. Nothing was changed. Try again when it has finished.' });
  expect(recs).toEqual([[false, r.message, true]]);
  expect(f.alerts).toEqual([]);
  expect(f.log).toEqual(['unlock']);
});

test('the database being unreachable for the ops lock cancels the update too, as a real failure with an alert', async () => {
  const f = fakes();
  const recs: [boolean, string, boolean | undefined][] = [];
  f.deps.record = async (ok, d, opts) => { recs.push([ok, d, opts?.busy]); };
  f.deps.exclusive = async () => { throw new OpsBusyError('The database could not be reached, so ops could not make sure nothing else is running. Check that the database is running.', true); };
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('cancelled');
  expect(r.message).toBe('[Acme] Update to 1.1.0 cancelled: The database could not be reached, so ops could not make sure nothing else is running. Check that the database is running. Nothing was changed.');
  expect(recs).toEqual([[false, r.message, undefined]]);
  expect(f.alerts).toEqual([r.message]);
});

test('an edge-check mismatch never causes a rollback: the update stands, with a plain warning', async () => {
  const f = fakes();
  f.deps.frontDoor = async () => 'Warning: the front door is not running because TUNNEL_IP and EDGE_SUBNET in .env do not match.';
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r).toEqual({ outcome: 'updated', message: '[Acme] Updated from 1.0.0 to 1.1.0. A backup (abcdef12) was taken first. Warning: the front door is not running because TUNNEL_IP and EDGE_SUBNET in .env do not match.' });
  expect(f.alerts).toEqual([r.message]);
  expect(f.records).toEqual([[true, r.message]]);
  expect(f.log).not.toContain('restore abcdef1234567890');
});

test('frontDoorCheck: a failing edge check gives a warning and leaves the front door alone; a passing one starts it', async () => {
  const calls: string[] = [];
  const compose = (edgeOk: boolean, upThrows = false): UpdateDeps['compose'] => ({
    imageAvailable: async () => true, stop: async () => undefined, readTag: async () => '1', writeTag: async () => undefined,
    runOnce: async (s) => { calls.push(`run ${s}`); return { ok: edgeOk, output: 'The front door has not been started because the tunnel settings do not match' }; },
    up: async (s) => { calls.push(`up ${s}`); if (upThrows) throw new Error('Docker could not start the front door.'); },
  });
  const bad = await frontDoorCheck(compose(false))();
  expect(bad).toMatch(/^Warning: TUNNEL_IP and EDGE_SUBNET in \.env do not match, so the front door \(web access\) was not restarted, and it will not start again until they are fixed\. The app itself is updated and healthy\./);
  expect(calls).toEqual(['run edge-check']);
  calls.length = 0;
  expect(await frontDoorCheck(compose(true))()).toBeUndefined();
  expect(calls).toEqual(['run edge-check', 'up proxy']);
  expect(await frontDoorCheck(compose(true, true))()).toMatch(/^Warning: the front door \(web access\) could not be started\./);
});

test('a monitor that does not restart still counts as updated, with the command to run', async () => {
  const f = fakes();
  const orig = f.deps.compose;
  const up = (s: string): Promise<void> => orig.up(s);
  f.deps.compose = { ...f.deps.compose, up: async (s) => { if (s === 'ops') throw new Error('no'); await up(s); } };
  expect((await runUpdate(f.deps, { to: '1.1.0' })).message).toBe('[Acme] Updated from 1.0.0 to 1.1.0. A backup (abcdef12) was taken first. (The monitor did not restart; run: docker compose up -d ops)');
});

test('rollback failure: the monitor is still started once, the record is not ok and says URGENT', async () => {
  const f = fakes({ migrate: false, restoreThrows: true });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('rollback-failed');
  expect(f.log.slice(f.log.indexOf('restore abcdef1234567890') + 1)).toEqual(['up ops@1.1.0', 'unlock']);
  expect(r.message).toBe('[Acme] URGENT: update to 1.1.0 failed (the database update failed) and the automatic undo also failed (pg_restore failed). The app may be down. Backup abcdef12 holds the data from before the update. The database and the uploaded files were not put back from it, and .env still names 1.1.0. See the runbook, section "Recovering from a failed update".');
  expect(f.records).toEqual([[false, r.message]]);
  // The monitor reads this mark from ops_runs (Task 19 /readyz) and keeps alerting until the operator has recovered.
  expect(r.message).toContain(ROLLBACK_FAILED_MARK);
});

test('the old version not getting healthy after the undo is a rollback failure too', async () => {
  const f = fakes({ readyNew: false, readyOld: false });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('rollback-failed');
  expect(r.message).toContain('and the automatic undo also failed (1.0.0 did not become healthy again: the new version did not become healthy within 3 minutes)');
  expect(r.message).toContain('The database and the uploaded files were put back from it, and .env names 1.0.0 again.');
});

test('a step that throws is handled, never escapes: stopping the app fails -> cancelled, app and monitor started again', async () => {
  const f = fakes();
  f.deps.compose = { ...f.deps.compose, stop: async (s) => { f.log.push(`stop ${s}`); if (s === 'app') throw new Error('Docker could not stop the app (docker compose stopped with code 1).'); } };
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('cancelled');
  expect(r.message).toBe('[Acme] Update to 1.1.0 cancelled: Docker could not stop the app (docker compose stopped with code 1). Nothing was changed; the app is running 1.0.0 again.');
  expect(f.log).not.toContain('backup');
  expect(f.log.slice(-3)).toEqual(['up app@1.0.0', 'up ops@1.0.0', 'unlock']);
});

test('the new version failing to start (compose up throws) rolls back with that reason', async () => {
  const f = fakes();
  const orig = f.deps.compose;
  const up = (s: string): Promise<void> => orig.up(s);
  f.deps.compose = { ...f.deps.compose, up: async (s) => { if (s === 'app' && f.tag() === '1.1.0') throw new Error('x'); await up(s); } };
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('rolled-back');
  expect(r.message).toContain('failed (the new version could not be started)');
});

test('when the old app cannot be started again after a cancelled update, the message says so instead of "running again"', async () => {
  const f = fakes({ backup: 'fail' });
  const orig = f.deps.compose;
  const up = (s: string): Promise<void> => orig.up(s);
  f.deps.compose = { ...f.deps.compose, up: async (s) => { if (s === 'app') throw new Error('x'); await up(s); } };
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('cancelled');
  expect(r.message).toBe('[Acme] Update to 1.1.0 cancelled: The backup destination could not be reached (sftp:b@nas:/r). Nothing was changed, but the app could not be started again: run docker compose up -d app ops');
});

test('a version that is not a Docker tag is refused before anything happens', async () => {
  const f = fakes();
  const r = await runUpdate(f.deps, { to: '1.1.0\nBACKUP_ALLOW_LOCAL=true' });
  expect(r.outcome).toBe('cancelled');
  expect(r.message).toBe('"1.1.0 BACKUP_ALLOW_LOCAL=true" is not a version name (letters, numbers, dots, dashes and underscores only).');
  expect(f.log).toEqual(['unlock']);
});

test('progress is logged in plain English', async () => {
  const f = fakes();
  const lines: string[] = [];
  f.deps.log = (l) => lines.push(l);
  await runUpdate(f.deps, { to: '1.1.0' });
  expect(lines[0]).toBe('Updating Acme from 1.0.0 to 1.1.0.');
  expect(lines).toContain('Taking a backup first.');
});

// ── httpWaitReady ─────────────────────────────────────────────────────────────────────────────────────────────────

function fakeApp(state: { version: string; status: string; checks?: { name: string; ok: boolean }[]; down?: boolean }) {
  const seen: { url: string; token: string | null }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    seen.push({ url: u, token: new Headers(init?.headers).get('x-health-token') });
    if (state.down === true) throw new TypeError('fetch failed');
    const body = u.endsWith('/api/version') ? { app: state.version } : { status: state.status, checks: state.checks };
    return new Response(JSON.stringify(body), { status: state.status === 'down' ? 503 : 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}
const healthy = [{ name: 'database', ok: true }, { name: 'migrations', ok: true }, { name: 'backups', ok: false }, { name: 'email', ok: false }];

test('httpWaitReady: right version, database and migrations ok -> ready, even with backups and email degraded; the token is sent', async () => {
  const a = fakeApp({ version: '1.1.0', status: 'degraded', checks: healthy });
  const r = await httpWaitReady({ appUrl: 'http://app:3000', healthToken: 'tok-123456', fetchImpl: a.fetchImpl, pollMs: 5 })('1.1.0', 1000);
  expect(r).toEqual({ ok: true, detail: '' });
  expect(a.seen.map((s) => s.url)).toEqual(['http://app:3000/api/version', 'http://app:3000/readyz']);
  expect(a.seen.find((s) => s.url.endsWith('/readyz'))?.token).toBe('tok-123456');
});

test('httpWaitReady: waits through a not-yet-ready app, then succeeds', async () => {
  const state = { version: '1.0.0', status: 'ok', checks: healthy, down: true };
  const a = fakeApp(state);
  setTimeout(() => { state.down = false; }, 30);
  setTimeout(() => { state.version = '1.1.0'; }, 60);
  expect((await httpWaitReady({ appUrl: 'http://app:3000', healthToken: 't', fetchImpl: a.fetchImpl, pollMs: 10 })('1.1.0', 2000)).ok).toBe(true);
});

test('httpWaitReady: each way of not being ready gives a plain reason when time runs out', async () => {
  const wait = (s: Parameters<typeof fakeApp>[0], v = '1.1.0') => httpWaitReady({ appUrl: 'http://app:3000', healthToken: 't', fetchImpl: fakeApp(s).fetchImpl, pollMs: 5 })(v, 30);
  expect((await wait({ version: '1.1.0', status: 'ok', down: true })).detail).toBe('version 1.1.0 did not become healthy within 1 minute: the app was not answering');
  expect((await wait({ version: '1.0.0', status: 'ok', checks: healthy })).detail).toBe('version 1.1.0 did not become healthy within 1 minute: the app reported version 1.0.0');
  expect((await wait({ version: '1.1.0', status: 'down', checks: [{ name: 'database', ok: false }, { name: 'migrations', ok: true }] })).detail).toBe('version 1.1.0 did not become healthy within 1 minute: its database check failed');
  expect((await wait({ version: '1.1.0', status: 'degraded', checks: [{ name: 'database', ok: true }, { name: 'migrations', ok: false }] })).detail).toBe('version 1.1.0 did not become healthy within 1 minute: its database updates check failed');
  expect((await wait({ version: '1.1.0', status: 'ok' })).detail).toBe('version 1.1.0 did not become healthy within 1 minute: it gave no detailed health answer (check that HEALTH_TOKEN is the same for the app and ops)');
});

// ── Fix round 1: the update record, refusals, image rules, precise undo state, mark-recovered ───────────────────────

import { markRecovered } from '../src/update.js';
import type { UpdateJournal, UpdateRecord } from '../src/journal.js';

function memJournal(initial: UpdateRecord | null = null, opts: { failWrite?: boolean } = {}) {
  let cur: UpdateRecord | null = initial;
  const steps: string[] = [];
  const j: UpdateJournal & { steps: string[]; current: () => UpdateRecord | null } = {
    steps,
    current: () => cur,
    read: async () => cur,
    write: async (r) => { if (opts.failWrite === true) throw Object.assign(new Error('the disk is full'), {}); steps.push(r.step + (r.snapshot !== undefined ? `@${r.snapshot.slice(0, 8)}` : '')); cur = { ...r, updatedAt: new Date().toISOString(), pid: 1, host: 'h' }; },
    clear: async () => { steps.push('clear'); cur = null; },
  };
  return j;
}

test('the update record is written before each step, names the backup once taken, and is cleared only after the outcome is stored', async () => {
  const f = fakes();
  const j = memJournal();
  f.deps.journal = j;
  // What the record said when each action happened: what a crash at that moment would leave behind.
  const at: string[] = [];
  const c = f.deps.compose;
  const step = (): string => j.current()?.step ?? 'none';
  f.deps.compose = { ...c, stop: async (s) => { at.push(`stop ${s}: ${step()}`); await c.stop(s); }, writeTag: async (t) => { at.push(`tag ${t}: ${step()}`); await c.writeTag(t); }, runOnce: async (s) => { at.push(`run ${s}: ${step()}`); return c.runOnce(s); }, up: async (s) => { at.push(`up ${s}: ${step()}`); await c.up(s); } };
  const d0 = f.deps;
  const backup = (k: 'pre-update') => d0.backup(k);
  f.deps = { ...d0, backup: async (k) => { at.push(`backup: ${step()}`); return backup(k); } };
  let storedWhileRecordExisted = false;
  f.deps.record = async () => { storedWhileRecordExisted = j.current() !== null; return true; };
  expect((await runUpdate(f.deps, { to: '1.1.0' })).outcome).toBe('updated');
  expect(at).toEqual(['stop app: stopping', 'stop ops: stopping', 'backup: backing-up', 'tag 1.1.0: switching', 'run migrate: migrating', 'up app: starting', 'up ops: finishing']);
  expect(j.steps).toEqual(['stopping', 'backing-up', 'switching@abcdef12', 'migrating@abcdef12', 'starting@abcdef12', 'finishing@abcdef12', 'clear']);
  expect(storedWhileRecordExisted).toBe(true);
});

test('a rollback is recorded as "undoing" before it starts', async () => {
  const f = fakes({ migrate: false });
  const j = memJournal();
  f.deps.journal = j;
  await runUpdate(f.deps, { to: '1.1.0' });
  expect(j.steps).toEqual(['stopping', 'backing-up', 'switching@abcdef12', 'migrating@abcdef12', 'undoing@abcdef12', 'finishing@abcdef12', 'clear']);
});

test('if the outcome cannot be stored, the update record stays, so the next run refuses', async () => {
  const f = fakes();
  const j = memJournal();
  f.deps.journal = j;
  f.deps.record = async () => false;
  await runUpdate(f.deps, { to: '1.1.0' });
  expect(j.current()?.step).toBe('finishing');
});

test('the update record cannot be written: nothing is touched', async () => {
  const f = fakes();
  f.deps.journal = memJournal(null, { failWrite: true });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r).toEqual({ outcome: 'cancelled', message: '[Acme] Update to 1.1.0 cancelled: the update record could not be written (the disk is full). Nothing was changed.' });
  expect(f.log).not.toContain('stop app');
});

const STEPS = ['stopping', 'backing-up', 'switching', 'migrating', 'starting', 'undoing', 'finishing'] as const;
test.each(STEPS)('a crash during "%s" leaves a record: the next update refuses with an URGENT alert naming the step, before "already on"', async (step) => {
  const f = fakes();
  const rec: UpdateRecord = { from: '1.0.0', to: '1.1.0', startedAt: '2026-10-26T20:00:00.000Z', updatedAt: '2026-10-26T20:01:00.000Z', step, pid: 9, host: 'gone', ...(step === 'stopping' ? {} : { snapshot: 'abcdef1234567890' }) };
  const j = memJournal(rec);
  f.deps.journal = j;
  f.deps.when = () => '26 October 2026 at 21:00';
  const recs: [boolean, string, string | undefined][] = [];
  f.deps.record = async (ok, d, o) => { recs.push([ok, d, o?.snapshotId]); return true; };
  const r = await runUpdate(f.deps, { to: '1.0.0' });   // the tag says 1.0.0: "already on" must not hide the leftover
  expect(r.outcome).toBe('cancelled');
  expect(r.message.startsWith(`[Acme] ${ROLLBACK_FAILED_MARK} 1.1.0 (from 1.0.0, started 26 October 2026 at 21:00) stopped part-way while `)).toBe(true);
  expect(r.message).toContain(step === 'stopping' ? 'No backup had been taken yet.' : 'Backup abcdef12 holds the data from before the update.');
  expect(r.message).toContain('docker compose run --rm updater update --mark-recovered');
  expect(f.alerts).toEqual([r.message]);
  expect(recs).toEqual([[false, r.message, step === 'stopping' ? undefined : 'abcdef1234567890']]);
  expect(f.log).toEqual(['unlock']);   // nothing touched
  expect(j.current()).toEqual(rec);    // the record stays until --mark-recovered
});

test('an earlier update whose undo failed, not yet marked as recovered, blocks new updates', async () => {
  const f = fakes();
  f.deps.outstanding = async () => ({ snapshotId: 'abcdef1234567890' });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('cancelled');
  expect(r.message).toBe('[Acme] Update to 1.1.0 cancelled: an earlier update could not be undone and has not been marked as recovered (backup abcdef12 holds the data from before it). Nothing was changed. Recover the box first (see the runbook, section "Recovering from a failed update"), then run: docker compose run --rm updater update --mark-recovered');
  expect(r.message).not.toContain(ROLLBACK_FAILED_MARK);   // a refusal is not a new failed undo
  expect(f.log).toEqual(['unlock']);
});

test('a failed --image-file load cancels the update before anything is touched', async () => {
  const f = fakes();
  f.deps.loadImages = async () => ({ ok: false, message: 'The image file x.tar could not be loaded (docker load stopped with code 1). Check the file is in the bundle folder and complete.' });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r).toEqual({ outcome: 'cancelled', message: '[Acme] Update to 1.1.0 cancelled: The image file x.tar could not be loaded (docker load stopped with code 1). Check the file is in the bundle folder and complete. Nothing was changed.' });
  expect(f.log).toEqual(['unlock']);
  expect(f.alerts).toEqual([r.message]);
});

test('default (unqualified) image names that are missing: refused with the image-file instructions, never "pulled"', async () => {
  const f = fakes({ images: false });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.message).toBe('[Acme] Update to 1.1.0 cancelled: the new version is not on this box yet. These images are never downloaded from Docker Hub; load them from a file made with docker save, kept in the bundle folder: docker compose run --rm updater update --to 1.1.0 --image-file <file> Nothing was changed.');
  const g = fakes({ images: false });
  g.deps.images = { app: 'registry.example.com/highland/app', ops: 'registry.example.com/highland/ops' };
  expect((await runUpdate(g.deps, { to: '1.1.0' })).message).toBe('[Acme] Update to 1.1.0 cancelled: the new version is not on this box yet. Nothing was changed.');
});

test('the current version\'s images must still be on the box (or a rollback would be impossible): refused before stopping', async () => {
  const f = fakes();
  f.deps.compose = { ...f.deps.compose, hasLocalImage: async (i) => { f.log.push(`local ${i}`); return !i.startsWith('highland/ops:'); } };
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.message).toBe('[Acme] Update to 1.1.0 cancelled: the images of the current version (1.0.0) are no longer on this box, so the update could not be undone if it failed. Load them again (from the file made with docker save, or from the registry) before updating. Nothing was changed.');
  expect(f.log).toEqual(['image highland/app:1.1.0', 'image highland/ops:1.1.0', 'local highland/app:1.0.0', 'local highland/ops:1.0.0', 'unlock']);
});

test('/state is handed back before every start of the monitor, in every path', async () => {
  for (const over of [{}, { backup: 'fail' as const }, { migrate: false }, { migrate: false, restoreThrows: true }]) {
    const f = fakes(over);
    f.deps.beforeStartOps = async () => { f.log.push('hand-over'); };
    await runUpdate(f.deps, { to: '1.1.0' });
    const i = f.log.findIndex((l) => l.startsWith('up ops'));
    expect(f.log[i - 1], JSON.stringify(over)).toBe('hand-over');
  }
});

test('the URGENT state says exactly what the undo put back: the database but not the uploads', async () => {
  const f = fakes({ migrate: false });
  f.deps.restoreDb = async (_id, progress) => { progress?.('database'); throw new Error('The uploaded files could not be replaced'); };
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('rollback-failed');
  expect(r.message).toContain('also failed (The uploaded files could not be replaced). The app may be down. Backup abcdef12 holds the data from before the update. The database was put back from it, but the uploaded files were not, and .env still names 1.1.0.');
});

test('every outcome after the backup records the backup id', async () => {
  for (const over of [{}, { migrate: false }, { migrate: false, restoreThrows: true }]) {
    const f = fakes(over);
    const ids: (string | undefined)[] = [];
    f.deps.record = async (_ok, _d, o) => { ids.push(o?.snapshotId); return true; };
    await runUpdate(f.deps, { to: '1.1.0' });
    expect(ids).toEqual(['abcdef1234567890']);
  }
});

function recoverDeps(o: { held?: boolean; record?: UpdateRecord | null; urgent?: boolean; ready?: boolean; stored?: boolean } = {}) {
  const j = memJournal(o.record ?? null);
  const recs: [boolean, string][] = [];
  const waited: string[] = [];
  let released = false;
  return {
    j, recs, waited, released: () => released,
    deps: {
      lock: { acquire: async () => o.held !== true, release: async () => { released = true; } },
      journal: j,
      outstanding: async () => (o.urgent === true ? { snapshotId: 'abcdef1234567890' } : null),
      readTag: async () => '1.0.0',
      waitReady: async (v: string) => { waited.push(v); return o.ready === false ? { ok: false, detail: 'version 1.0.0 did not become healthy within 1 minute: its database updates check failed' } : { ok: true, detail: '' }; },
      record: async (ok: boolean, d: string) => { recs.push([ok, d]); return o.stored !== false; },
    },
  };
}
const leftRec: UpdateRecord = { from: '1.0.0', to: '1.1.0', startedAt: '2026-10-26T20:00:00.000Z', updatedAt: '2026-10-26T20:00:00.000Z', step: 'migrating', snapshot: 'abcdef1234567890', pid: 1, host: 'x' };

test('mark-recovered: refuses while an update runs, or when there is nothing to clear', async () => {
  const a = recoverDeps({ held: true, urgent: true });
  expect(await markRecovered(a.deps)).toEqual({ ok: false, message: 'An update is running right now, so nothing was marked. Try again when it has finished.' });
  const b = recoverDeps();
  expect(await markRecovered(b.deps)).toEqual({ ok: false, message: 'There is no failed update to mark as recovered. Nothing was changed.' });
  expect(b.recs).toEqual([]);
  expect(b.released()).toBe(true);
});

test('mark-recovered: refuses unless the app is healthy on the version .env names', async () => {
  const r = recoverDeps({ urgent: true, record: leftRec, ready: false });
  const out = await markRecovered(r.deps);
  expect(out).toEqual({ ok: false, message: 'The box does not look recovered yet, so nothing was marked (version 1.0.0 did not become healthy within 1 minute: its database updates check failed). Check that the app is running the version in .env (APP_TAG=1.0.0) and that its database is up to date.' });
  expect(r.waited).toEqual(['1.0.0']);
  expect(r.recs).toEqual([]);
  expect(r.j.current()).toEqual(leftRec);
});

test('mark-recovered: when healthy, records an ok update (which clears the alert and the backup pause) and removes the record', async () => {
  const r = recoverDeps({ record: leftRec });
  expect(await markRecovered(r.deps)).toEqual({ ok: true, message: 'The operator marked the failed update as recovered: the app is healthy on 1.0.0.' });
  expect(r.recs).toEqual([[true, 'The operator marked the failed update as recovered: the app is healthy on 1.0.0.']]);
  expect(r.j.current()).toBeNull();
  const s = recoverDeps({ urgent: true, record: leftRec, stored: false });
  expect((await markRecovered(s.deps)).ok).toBe(false);
  expect(s.j.current()).toEqual(leftRec);   // nothing cleared when the ok record could not be stored
});

// ── Fix round 2 ───────────────────────────────────────────────────────────────────────────────────────────────────

test('N2: a failed undo leaves the record at "undo-failed" (not "finishing") before the monitor starts', async () => {
  const f = fakes({ migrate: false, restoreThrows: true });
  const j = memJournal();
  f.deps.journal = j;
  let stepWhenOpsStarted = '';
  const up = f.deps.compose.up.bind(f.deps.compose);
  f.deps.compose = { ...f.deps.compose, up: async (s) => { if (s === 'ops') stepWhenOpsStarted = j.current()?.step ?? 'none'; await up(s); } };
  f.deps.record = async () => false;   // the URGENT row cannot be stored
  expect((await runUpdate(f.deps, { to: '1.1.0' })).outcome).toBe('rollback-failed');
  expect(stepWhenOpsStarted).toBe('undo-failed');
  expect(j.current()?.step).toBe('undo-failed');   // kept, and always treated as left behind
});

function flakyJournal(failSteps: string[]) {
  const j = memJournal();
  const write = j.write.bind(j);
  j.write = async (r) => { if (failSteps.includes(r.step)) throw new Error('the disk is full'); await write(r); };
  return j;
}

test('N5: the record cannot be updated before any change: the update stops and the old version is started again', async () => {
  const f = fakes();
  f.deps.journal = flakyJournal(['backing-up']);
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.message).toBe('[Acme] Update to 1.1.0 cancelled: the update record could not be kept up to date (the disk is full). Nothing was changed; the app is running 1.0.0 again.');
  expect(f.log).not.toContain('backup');
  const g = fakes();
  g.deps.journal = flakyJournal(['switching']);
  const r2 = await runUpdate(g.deps, { to: '1.1.0' });
  expect(r2.message).toBe('[Acme] Update to 1.1.0 cancelled: the update record could not be kept up to date (the disk is full). Backup abcdef12 was taken. Nothing was changed; the app is running 1.0.0 again.');
  expect(g.log).not.toContain('tag 1.1.0');
  expect(g.tag()).toBe('1.0.0');
});

test('N5: after the first change, a step that cannot be written is replaced by "uncertain"', async () => {
  const f = fakes({ readyNew: false, restoreThrows: true });
  const j = flakyJournal(['starting']);
  f.deps.journal = j;
  f.deps.record = async () => false;
  await runUpdate(f.deps, { to: '1.1.0' });
  expect(j.steps).toEqual(['stopping', 'backing-up', 'switching@abcdef12', 'migrating@abcdef12', 'uncertain@abcdef12', 'undoing@abcdef12', 'undo-failed@abcdef12']);
});

test('N4: image names that point at Docker Hub are refused plainly before anything happens', async () => {
  for (const app of ['docker.io/highland/app', 'Index.Docker.IO/highland/app', 'registry-1.docker.io/highland/app']) {
    const f = fakes();
    f.deps.images = { app, ops: 'registry.example.com/highland/ops' };
    const r = await runUpdate(f.deps, { to: '1.1.0' });
    expect(r.message).toBe('[Acme] Update to 1.1.0 cancelled: APP_IMAGE or OPS_IMAGE in .env points at Docker Hub (docker.io), which Highland images never come from. Use your own registry (such as registry.example.com/highland/app) or load the images from a file with --image-file. Nothing was changed.');
    expect(f.log).toEqual(['unlock']);
  }
});

test('N6: if the ops log cannot be read to check for an earlier failed update, the update is refused (fail closed)', async () => {
  const f = fakes();
  f.deps.outstanding = async () => { throw new Error('connection refused'); };
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r).toEqual({ outcome: 'cancelled', message: '[Acme] Update to 1.1.0 cancelled: the ops log in the database could not be read to check for an earlier update that could not be undone, so nothing was changed. Check that the database is running, then try again.' });
  expect(f.log).toEqual(['unlock']);
});

test('item 8: a leftover-record refusal is flagged urgent (the CLI exits 3); other refusals are not', async () => {
  const f = fakes();
  f.deps.journal = memJournal({ from: '1.0.0', to: '1.1.0', startedAt: '2026-10-26T20:00:00Z', updatedAt: '2026-10-26T20:00:00Z', step: 'migrating', pid: 1, host: 'x' });
  expect((await runUpdate(f.deps, { to: '1.1.0' })).urgent).toBe(true);
  const g = fakes({ images: false });
  expect((await runUpdate(g.deps, { to: '1.1.0' })).urgent).toBeUndefined();
});

// ── update --json (Task 9a): one line of JSON on standard output, progress on standard error ─────────────────────────
test('update exit codes are unchanged and urgent wins', () => {
  expect(UPDATE_EXIT).toEqual({ updated: 0, cancelled: 1, 'rolled-back': 1, 'rollback-failed': 3 });
  expect(updateExitCode({ outcome: 'updated', message: 'x' })).toBe(0);
  expect(updateExitCode({ outcome: 'cancelled', message: 'x', urgent: true })).toBe(3);
});
test('the JSON outcome is one line with every field', () => {
  const line = updateOutcomeJson({ outcome: 'rolled-back', message: '[Acme] Update to 0.2.1 failed …\nsecond line' }, '0.2.1');
  expect(line).not.toContain('\n');
  expect(JSON.parse(line)).toEqual({ schema: 1, outcome: 'rolled-back', to: '0.2.1', message: '[Acme] Update to 0.2.1 failed … second line', urgent: false, exitCode: 1 });
});
test('a refusal before the update starts is JSON too, with exit code 2', () => {
  expect(JSON.parse(updateOutcomeJson({ refused: 'update needs exactly one of --to <version>, --status or --mark-recovered.', exitCode: 2 }, null)))
    .toEqual({ schema: 1, outcome: 'refused', to: null, message: 'update needs exactly one of --to <version>, --status or --mark-recovered.', urgent: false, exitCode: 2 });
});
test('an unexpected problem is "unknown", never "cancelled", and the line can carry the process\'s real exit code', () => {
  expect(UNKNOWN_UPDATE_MESSAGE).toBe('The update stopped because of an unexpected problem, so whether anything changed is not known. The details are on standard error. Check with: docker compose run --rm updater update --status');
  expect(JSON.parse(updateOutcomeJson('unknown', '0.2.1'))).toEqual({ schema: 1, outcome: 'unknown', to: '0.2.1', message: UNKNOWN_UPDATE_MESSAGE, urgent: false, exitCode: 1 });
  expect(JSON.parse(updateOutcomeJson({ outcome: 'updated', message: 'x' }, '0.2.1', 1)).exitCode).toBe(1);
});
test('a lock that cannot be removed at the end does not turn a finished update into an exception', async () => {
  const f = fakes();
  const logged: string[] = [];
  f.deps.lock = { acquire: async () => true, release: async () => { throw new Error('EBUSY: resource busy'); } };
  f.deps.log = (l) => { logged.push(l); };
  expect((await runUpdate(f.deps, { to: '1.1.0' })).outcome).toBe('updated');
  expect(logged).toContain('Warning: the update lock could not be removed: EBUSY: resource busy.');
});
