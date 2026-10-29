# Task 19: Health checks, monitor & alerts

Spec §2.4: "health monitoring that alerts the **operator** before the client notices". Spec §4.6: "Every deployment reports health to the operator … The default is the operator's existing Matrix setup."

The pieces:
- **The app** reports its own readiness: database, storage, migrations, mail backlog, backup freshness and restore-test result.
- **The ops monitor** adds what the app cannot see: whether the app answers at all, disk space, the tunnel, and backups set to stay on the box.
- It alerts on the **second** consecutive failure, so a blip does not page anyone. It reminds every 6 hours while a problem lasts, and says when it is fixed.
- A heartbeat to an external watcher covers "the whole box is off", which nothing inside the box can report.

**Files:**
- Create: `apps/server/src/health/{checks,routes}.ts` (replacing the minimal `/healthz` from Task 17)
- Create: `ops/src/{monitor,alerts,checks}.ts`
- Modify: `ops/src/daemon.ts` (run the monitor every 60 s; route scheduler failures to the channel), `ops/src/cli.ts` (`check`), `ops/src/config.ts` (alert settings)
- Test: `apps/server/test/health.test.ts`, `ops/test/{monitor,alerts,checks}.test.ts`

**Interfaces:**
- Consumes: `ops_runs` (Task 18), `email_outbox` (Task 6), `Storage.check` (Task 9), `Config.healthToken` (Task 2), the compose env names (Task 17), `startScheduler` (Task 18).
- Produces:
  - `GET /healthz` (public: "liveness for Docker and the monitor") → `{ status: 'ok' }`.
  - `GET /readyz` (public: "readiness; details only with the health token") →
    - 200 `{ status: 'ok' | 'degraded' }`, or 503 `{ status: 'down' }`;
    - with header `x-health-token` equal to `HEALTH_TOKEN` (checked with `hasHealthToken` from Task 16), the body adds `checks: { name, ok, detail }[]`;
    - `down` only when `database` fails; any other failing check makes it `degraded`.
  - `runReadinessChecks(deps: { db; storage; now }): Promise<Check[]>` with check names, in order:
    1. `database`: `select 1` within 2 s, otherwise `The database is not answering.`
    2. `storage`: `Storage.check()`, otherwise `Uploaded files cannot be saved (storage is not writable).`
    3. `migrations`: the number of entries in `drizzle/meta/_journal.json` compared with the rows in `drizzle.__drizzle_migrations`, otherwise `The database is missing <n> updates.`
    4. `email`:
       - the oldest pending mail more than 15 minutes old → `1 email is waiting to be sent (the oldest for <m> minutes).` / `<n> emails are waiting to be sent (the oldest for <m> minutes).`
       - any `failed` mail in the last 24 h → `<n> emails could not be sent in the last day.`
    5. `backups`: the last successful backup is less than 26 h old, otherwise `The last successful backup was <h> hours ago.` / `No backup has succeeded yet.`
    6. `restore-test`: the latest restore-test run passed and its last success is less than 8 days old, otherwise `The last restore test failed: <detail>` / `No restore test has passed in the last 8 days.`
  - `ops/src/alerts.ts`:
    - `AlertChannel { send(text: string): Promise<void> }`
    - `matrixChannel({ homeserver, accessToken, roomId, fetchImpl? })`
    - `webhookChannel(url, fetchImpl?)`: POSTs JSON `{ text }`.
    - `allChannels(channels)`: sends to every channel and rejects only if all of them fail.
    - `logChannel(log)`: writes `ALERT <text>` to the log.
    - `channelFromConfig(cfg: Pick<OpsConfig, 'instanceMode' | 'alerts'>, log)`, where `OpsConfig.alerts = { matrix?: { homeserver: string; accessToken: string; roomId: string }; webhookUrl?: string }`:
      - **every configured channel is always used, in every mode**: Matrix when all three `MATRIX_*` values are set, the webhook when `ALERT_WEBHOOK_URL` is set, both through `allChannels` when both are;
      - `logChannel` is used **only** when no channel is configured **and** the mode is `demo` or `test` (so the smoke, which runs in demo mode with a webhook, gets real alerts);
      - in production mode with no channel configured, `loadOpsConfig` has already refused to start with `No alert channel is set. Set MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN and MATRIX_ROOM_ID, or ALERT_WEBHOOK_URL.`
  - `ops/src/checks.ts`, `monitorChecks(deps): Promise<Check[]>`:
    - the app's `/readyz` with the token (5 s timeout). Each of its checks is returned as `app:<name>`. If the request fails: `app` → `The app is not answering.`
    - `disk:/data/uploads` and `disk:/state` via `fs.statfs`: a failure when free space is below 10 % **or** below 2 GiB → `Disk space is low on <path>: <x> GB free (<p>%).`
    - `backup-location`: fails while `BACKUP_ALLOW_LOCAL=true` → `Backups are being kept on this box only. This is a development setting and must be changed before real use.`
    - `tunnel` (only when `TUNNEL_ENABLED=true`): `GET http://tunnel:2000/ready` → `The remote-access tunnel is down, so the operator cannot reach this box.`
  - `new Monitor({ checks: () => Promise<Check[]>, channel, client: string, heartbeatUrl?, failAfter = 2, remindEveryMs = 6 * 3600e3, now = () => new Date(), fetchImpl? })`, with `.tick(): Promise<void>`.
  - Alert texts (exact; times are Europe/London `HH:mm`):
    - `[<client>] Problem: <detail>`
    - `[<client>] Still a problem since <HH:mm>: <detail>`
    - `[<client>] Fixed: <detail of the original problem> (now back to normal).`
    - Scheduler failures go out at once, with no two-strike rule: `[<client>] Problem: the scheduled <job> failed. <plain message>`
  - Heartbeat (Uptime Kuma push format): on every tick, `GET <heartbeatUrl>?status=up&msg=OK`. While any check is failing: `?status=down&msg=<first failing detail, url-encoded, max 100 chars>`. If the URL already has a query, use `&` instead of `?`.
  - `restoreTestJob(deps: OpsDeps, channel: AlertChannel, client: string): () => Promise<void>`: runs `verifyLatestRestore`. When the result is `ok: false`, it sends `[<client>] Problem: the restore test failed. <problems joined by a space>` at once, even though nothing threw. The daemon schedules this job, not the bare `verifyLatestRestore`.
  - `ops check` prints one line per check (`✓ name` or `✗ name: detail`) and exits 1 if any fail.

- [ ] **Step 1: Write the failing tests**

`apps/server/test/health.test.ts`:

```ts
import { test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestApp } from './helpers/testApp.js';

const TOKEN = 'h'.repeat(32);
let t: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => { t = await createTestApp({ healthToken: TOKEN }); });
afterAll(async () => { await t.close(); });

test('without the token only the status is shown', async () => {
  const r = await t.app.inject({ method: 'GET', url: '/readyz' });
  expect(r.statusCode).toBe(200);
  expect(r.json()).toEqual({ status: 'degraded' });         // no backup yet
  const wrong = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': 'nope' } });
  expect(wrong.json()).toEqual({ status: 'degraded' });
});

test('with the token, each check explains itself', async () => {
  await t.db.execute(sql`insert into email_outbox (to_address, template, data, created_at, next_attempt_at) values ('a@hf.test', 'password-changed', '{}', now() - interval '22 minutes', now())`);
  const r = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': TOKEN } });
  const byName = Object.fromEntries(r.json().checks.map((c: any) => [c.name, c]));
  expect(Object.keys(byName)).toEqual(['database', 'storage', 'migrations', 'email', 'backups', 'restore-test']);
  expect(byName.database.ok).toBe(true);
  expect(byName.migrations.ok).toBe(true);
  expect(byName.email).toMatchObject({ ok: false, detail: '1 email is waiting to be sent (the oldest for 22 minutes).' });
  expect(byName.backups).toMatchObject({ ok: false, detail: 'No backup has succeeded yet.' });
});

test('fresh backup and passing restore test turn those checks green', async () => {
  await t.db.execute(sql`insert into ops_runs (kind, ok, detail) values ('backup', true, 'x'), ('restore-test', true, 'y')`);
  await t.db.execute(sql`update email_outbox set status = 'sent'`);
  const r = await t.app.inject({ method: 'GET', url: '/readyz', headers: { 'x-health-token': TOKEN } });
  expect(r.json().status).toBe('ok');
});
```

`ops/test/monitor.test.ts`:

```ts
import { test, expect } from 'vitest';
import { Monitor } from '../src/monitor.js';

function rig(results: Array<Array<{ name: string; ok: boolean; detail: string }>>) {
  const sent: string[] = [], beats: string[] = [];
  let i = 0, now = new Date('2026-11-02T09:14:00Z');
  const m = new Monitor({
    checks: async () => results[Math.min(i++, results.length - 1)]!,
    channel: { send: async (t) => { sent.push(t); } }, client: 'Acme',
    heartbeatUrl: 'https://kuma.example/api/push/abc', now: () => now,
    fetchImpl: (async (u: string) => { beats.push(String(u)); return new Response('ok'); }) as typeof fetch,
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
```

Append to `ops/test/monitor.test.ts`:

```ts
import { restoreTestJob } from '../src/daemon.js';
test('a failed restore test alerts at once, in plain English', async () => {
  const sent: string[] = [];
  const job = restoreTestJob({ ...stubDeps, verify: async () => ({ ok: false, problems: ['Table notes has 32 rows in the backup record but 0 after restoring.'] }) } as never,
    { send: async (t) => { sent.push(t); } }, 'Acme');
  await job();
  expect(sent).toEqual(['[Acme] Problem: the restore test failed. Table notes has 32 rows in the backup record but 0 after restoring.']);
});
```

(For testability, `restoreTestJob` takes `deps.verify` when present and otherwise uses `verifyLatestRestore(deps)`. `stubDeps` is a minimal `OpsDeps` from `helpers.ts`.)

`ops/test/alerts.test.ts`:

```ts
test('Matrix: the right room, the token in the header only, plain text body', async () => {
  await withServer(200, async (base, seen) => {
    await matrixChannel({ homeserver: base, accessToken: 'syt_secret_123', roomId: '!abc:highlandautomations.com' }).send('[Acme] Problem: x');
    expect(seen[0].method).toBe('PUT');
    expect(seen[0].url).toMatch(/^\/_matrix\/client\/v3\/rooms\/!abc%3Ahighlandautomations\.com\/send\/m\.room\.message\/hf-/);
    expect(seen[0].auth).toBe('Bearer syt_secret_123');
    expect(seen[0].body).toEqual({ msgtype: 'm.text', body: '[Acme] Problem: x' });
  });
});
test('a Matrix error never repeats the token', async () => {
  await withServer(403, async (base) => {
    const e = await matrixChannel({ homeserver: base, accessToken: 'syt_secret_123', roomId: '!r:x' }).send('t').catch((x) => x);
    expect(String(e.message)).toBe('Matrix refused the alert (HTTP 403).');
    expect(String(e.message)).not.toContain('syt_secret_123');
  });
});
```

```ts
test('configured channels are used even in demo mode; the log is only the fallback', async () => {
  await withServer(200, async (base, seen) => {
    const logged: string[] = [];
    await channelFromConfig({ instanceMode: 'demo', alerts: { webhookUrl: `${base}/hook` } }, (l) => logged.push(l)).send('[Demo] Problem: The app is not answering.');
    expect(seen).toHaveLength(1);
    expect(seen[0].body).toEqual({ text: '[Demo] Problem: The app is not answering.' });
    expect(logged).toEqual([]);
  });
  const logged: string[] = [];
  await channelFromConfig({ instanceMode: 'demo', alerts: {} }, (l) => logged.push(l)).send('[Demo] Problem: x');
  expect(logged).toEqual(['ALERT [Demo] Problem: x']);
});
```

`withServer(status, fn)` is a `node:http` server on `127.0.0.1:0` that records `{ method, url, auth, body }`. It is the same pattern as Conductor's `withLocalServer`; put it in `ops/test/helpers.ts`.

`ops/test/checks.test.ts`: `monitorChecks` with injected `statfs` returning `{ bsize: 4096, blocks: 1e6, bavail: 50_000 }` (5 %, about 0.2 GB) gives `Disk space is low on /data/uploads: 0.2 GB free (5%).` With `BACKUP_ALLOW_LOCAL=true`, the `backup-location` check fails with the exact sentence above. With the app URL pointing at a closed port, the result is `app` with `The app is not answering.`

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project apps/server test/health.test.ts && npx vitest run --project ops`
Expected: FAIL.

- [ ] **Step 3: Implement**

- Server: `health/checks.ts` and `routes.ts` as specified. `readyz` runs the checks in parallel with a 3 s overall timeout.
- Ops: `monitor.ts` keeps per-check state `{ fails, alertedAt: Date | null, since: Date | null, detail }`.
  - It marks a check as alerted only after `channel.send` resolves.
  - The "Fixed" message is sent only for checks that were alerted.
  - Heartbeat errors are logged, never thrown.
- `daemon.ts` builds the channel, a `Monitor` whose `checks = () => monitorChecks(deps)` runs every 60 s (no overlap), and the scheduler from Task 18 with `onFailure` sending the scheduler failure text.
- The restore-test entry in the scheduler is `restoreTestJob(…)`.

- [ ] **Step 4: Add the crossing coverage**

`/healthz` and `/readyz` are public, so the harness's public-route leak test covers them. Confirm `crossing.md` still says `0 problems`.

- [ ] **Step 5: Verify**

Run: `npm run verify`
Expected: all tests PASS (15 new).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: readiness checks, ops monitor with two-strike Matrix alerts, reminders, recovery and heartbeat

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
