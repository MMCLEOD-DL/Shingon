import { test, expect } from 'vitest';
import { Monitor } from '../src/monitor.js';
import { stubDeps } from './helpers.js';

function rig(results: Array<Array<{ name: string; ok: boolean; detail: string }>>) {
  const sent: string[] = [], beats: string[] = [];
  let i = 0, now = new Date('2026-11-02T09:14:00Z');
  const m = new Monitor({
    checks: async () => results[Math.min(i++, results.length - 1)]!,
    channel: { send: async (t) => { sent.push(t); } }, client: 'Acme',
    heartbeatUrl: 'https://kuma.example/api/push/abc', now: () => now,
    fetchImpl: async (u: string | URL | Request) => { beats.push(u instanceof Request ? u.url : u.toString()); return new Response('ok'); },
  });
  return { m, sent, beats, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
const bad = [{ name: 'app:backups', ok: false, detail: 'The last successful backup was 31 hours ago.' }];
const good = [{ name: 'app:backups', ok: true, detail: '' }];

test('one blip is ignored; the second failure alerts once; recovery is announced', async () => {
  const r = rig([bad, bad, bad, good]);
  await r.m.tick(); expect(r.sent).toEqual([]);
  await r.m.tick(); expect(r.sent).toEqual(['[Acme] Problem: The last successful backup was 31 hours ago.']);
  await r.m.tick(); expect(r.sent).toHaveLength(1);
  await r.m.tick(); expect(r.sent[1]).toBe('[Acme] Fixed: The last successful backup was 31 hours ago. (now back to normal).');
});

test('a lasting problem is repeated every 6 hours', async () => {
  const r = rig([bad]);
  await r.m.tick(); await r.m.tick();
  r.advance(6 * 3600e3);
  await r.m.tick();
  expect(r.sent[1]).toBe('[Acme] Still a problem since 09:14: The last successful backup was 31 hours ago.');
});

test('if the alert cannot be sent, it is tried again next time', async () => {
  let fail = true; const sent: string[] = [];
  const m = new Monitor({ checks: async () => bad, client: 'Acme', channel: { send: async (t) => { if (fail) throw new Error('down'); sent.push(t); } } });
  await m.tick(); await m.tick();
  fail = false; await m.tick();
  expect(sent).toEqual(['[Acme] Problem: The last successful backup was 31 hours ago.']);
});

test('the heartbeat says up or down', async () => {
  const r = rig([good, bad]);
  await r.m.tick(); await r.m.tick();
  expect(r.beats).toEqual(['https://kuma.example/api/push/abc?status=up&msg=OK',
    'https://kuma.example/api/push/abc?status=down&msg=The%20last%20successful%20backup%20was%2031%20hours%20ago.']);
});

import { restoreTestJob } from '../src/daemon.js';
test('a failed restore test alerts at once, in plain English', async () => {
  const sent: string[] = [];
  const job = restoreTestJob({ ...stubDeps, verify: async () => ({ ok: false, problems: ['Table notes has 32 rows in the backup record but 0 after restoring.'] }) },
    { send: async (t) => { sent.push(t); } }, 'Acme');
  await job();
  expect(sent).toEqual(['[Acme] Problem: the restore test failed. Table notes has 32 rows in the backup record but 0 after restoring.']);
});

// ── Beyond the brief's five.

test('a passing restore test sends nothing', async () => {
  const sent: string[] = [];
  await restoreTestJob({ ...stubDeps, verify: async () => ({ ok: true, problems: [] }) }, { send: async (t) => { sent.push(t); } }, 'Acme')();
  expect(sent).toEqual([]);
});

test('a standing critical problem (a settings warning) alerts on the first check, is reminded every 6 hours, and is marked critical', async () => {
  const crit = [{ name: 'settings:1', ok: false, detail: 'TUNNEL_IP (172.31.0.10) is not inside EDGE_SUBNET (172.30.250.0/28).', critical: true }];
  const r = rig([crit]);
  await r.m.tick();
  expect(r.sent).toEqual(['[Acme] Critical problem: TUNNEL_IP (172.31.0.10) is not inside EDGE_SUBNET (172.30.250.0/28).']);
  r.advance(3 * 3600e3); await r.m.tick();
  expect(r.sent).toHaveLength(1);
  r.advance(3 * 3600e3); await r.m.tick();
  expect(r.sent[1]).toBe('[Acme] Still a critical problem since 09:14: TUNNEL_IP (172.31.0.10) is not inside EDGE_SUBNET (172.30.250.0/28).');
});

test('a blip that never alerted is not announced as fixed', async () => {
  const r = rig([bad, good, good]);
  await r.m.tick(); await r.m.tick(); await r.m.tick();
  expect(r.sent).toEqual([]);
});

test('"since" is shown in UK time (British Summer Time in summer)', async () => {
  const sent: string[] = [];
  let now = new Date('2026-07-01T08:05:00Z');
  const m = new Monitor({ checks: async () => bad, client: 'Acme', channel: { send: async (t) => { sent.push(t); } }, now: () => now });
  await m.tick(); await m.tick();
  now = new Date(now.getTime() + 6 * 3600e3);
  await m.tick();
  expect(sent[1]).toBe('[Acme] Still a problem since 09:05: The last successful backup was 31 hours ago.');
});

test('checks that throw become a failing "monitor" check; a heartbeat that fails is logged, never thrown', async () => {
  const sent: string[] = [], logs: string[] = [];
  const m = new Monitor({
    checks: () => Promise.reject(new Error('boom')), client: 'Acme', channel: { send: async (t) => { sent.push(t); } },
    heartbeatUrl: 'https://kuma.example/api/push/secretpush?x=1', log: (l) => logs.push(l),
    fetchImpl: (() => Promise.reject(new Error('ECONNREFUSED https://kuma.example/api/push/secretpush'))),
  });
  await m.tick(); await m.tick();
  expect(sent).toEqual(['[Acme] Problem: The health checks could not run.']);
  expect(logs.some((l) => l === 'The heartbeat could not be sent to the outside watcher.')).toBe(true);
  expect(logs.join('\n')).not.toContain('secretpush');
});

test('a heartbeat URL that already has a query gets & and the message is cut to 100 characters', async () => {
  const beats: string[] = [];
  const long = [{ name: 'x', ok: false, detail: 'a'.repeat(150) }];
  const m = new Monitor({ checks: async () => long, client: 'Acme', channel: { send: async () => undefined }, heartbeatUrl: 'https://kuma.example/push?token=1',
    fetchImpl: async (u: string | URL | Request) => { beats.push(u instanceof Request ? u.url : u.toString()); return new Response('ok'); } });
  await m.tick();
  expect(beats).toEqual([`https://kuma.example/push?token=1&status=down&msg=${'a'.repeat(100)}`]);
});

test('scheduler failures go out at once with no two-strike rule', async () => {
  const sent: string[] = [];
  const m = new Monitor({ checks: async () => [], client: 'Acme', channel: { send: async (t) => { sent.push(t); } } });
  await m.jobFailed('backup', 'The backup destination could not be reached (sftp:backup@nas:/srv).');
  expect(sent).toEqual(['[Acme] Problem: the scheduled backup failed. The backup destination could not be reached (sftp:backup@nas:/srv).']);
});
