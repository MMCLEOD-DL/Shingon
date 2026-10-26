import { test, expect } from 'vitest';
import { runUpdate, httpWaitReady, frontDoorCheck, type UpdateDeps } from '../src/update.js';
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
  expect(r.message).toBe('[Acme] URGENT: update to 1.1.0 failed (the database update failed) and the automatic undo also failed (pg_restore failed). The app may be down. Backup abcdef12 holds the data from before the update. The database and uploaded files were not put back from it, and .env still names 1.1.0. See the runbook, section "Recovering from a failed update".');
  expect(f.records).toEqual([[false, r.message]]);
  // The monitor reads this mark from ops_runs (Task 19 /readyz) and keeps alerting until the operator has recovered.
  expect(r.message).toContain(ROLLBACK_FAILED_MARK);
});

test('the old version not getting healthy after the undo is a rollback failure too', async () => {
  const f = fakes({ readyNew: false, readyOld: false });
  const r = await runUpdate(f.deps, { to: '1.1.0' });
  expect(r.outcome).toBe('rollback-failed');
  expect(r.message).toContain('and the automatic undo also failed (1.0.0 did not become healthy again: the new version did not become healthy within 3 minutes)');
  expect(r.message).toContain('The database and uploaded files were put back from it, and .env names 1.0.0 again.');
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
