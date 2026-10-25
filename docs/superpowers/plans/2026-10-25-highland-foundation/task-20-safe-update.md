# Task 20: Safe update & automatic rollback

Spec §2.4: "updates that take a backup first and roll back automatically if health checks fail". Spec §4.8: "Every update takes a backup first and rolls back automatically if the health checks fail."

`ops update --to <version>` runs in the on-demand `updater` container, the only one with the Docker socket (Ruling 7). It works through a fixed sequence:
1. stop the app, so no write can be lost (Ruling 6), and stop the `ops` daemon, so its 60-second monitor does not page "The app is not answering." during a planned stop, and its scheduled backup or restore test cannot hold the restic lock and make the pre-update backup fail;
2. take an encrypted backup;
3. switch the image tag;
4. migrate;
5. start;
6. wait for the new version to be healthy.

Any failure after the backup restores the database from that backup and brings the previous version back. Every outcome reaches the operator as a plain-English alert.

**Files:**
- Create: `ops/src/{compose,update,lock}.ts`
- Modify: `ops/src/cli.ts` (`update --to <tag>`, `update --status`)
- Create: `deploy/test/broken-image.Dockerfile` (used only by the Docker verification below and by Task 21's smoke)
- Test: `ops/test/update.test.ts`, `ops/test/compose.test.ts`

**Interfaces:**
- Consumes: `runBackup`, `restoreDatabase`, `recordRun` (Task 18); `AlertChannel` and `channelFromConfig` (Task 19); `GET /readyz` and `GET /api/version` (Tasks 16 and 19); `Runner` (Task 18).
- Produces:

```ts
// compose.ts
export interface Compose {
  imageAvailable(image: string): Promise<boolean>;   // `docker image inspect`, else `docker pull` (true if either succeeds)
  stop(service: string): Promise<void>;              // docker compose stop <service>
  up(service: string): Promise<void>;                // docker compose up -d --no-deps <service>
  runOnce(service: string): Promise<{ ok: boolean; output: string }>;   // docker compose run --rm --no-deps <service>
  readTag(): Promise<string>;                        // APP_TAG from <bundleDir>/.env
  writeTag(tag: string): Promise<void>;              // rewrite only the APP_TAG line, via temp file + rename
}
export function dockerCompose(o: { run: Runner; bundleDir: string; project: string }): Compose;
// every command is `docker compose --project-directory <bundleDir> -p <project> …`
// update.ts
export interface UpdateDeps {
  compose: Compose;
  backup(kind: 'pre-update'): Promise<{ snapshotId: string }>;
  restoreDb(snapshotId: string): Promise<void>;
  waitReady(version: string, timeoutMs: number): Promise<{ ok: boolean; detail: string }>;
  alert: AlertChannel; record(ok: boolean, detail: string): Promise<void>;
  client: string; images: { app: string; ops: string };   // repo names, e.g. 'highland/app'
  lock: { acquire(): Promise<boolean>; release(): Promise<void> };
  timeoutMs?: number;                                       // default 180000
}
export type UpdateOutcome = { outcome: 'updated' | 'cancelled' | 'rolled-back' | 'rollback-failed'; message: string };
export async function runUpdate(deps: UpdateDeps, opts: { to: string }): Promise<UpdateOutcome>;
export function httpWaitReady(o: { appUrl: string; healthToken: string; fetchImpl?: typeof fetch; pollMs?: number }): UpdateDeps['waitReady'];
// lock.ts — /state/update.lock created with O_EXCL; a lock older than 1 hour is treated as stale and replaced
export function fileLock(path: string, now?: () => Date): UpdateDeps['lock'];
```

`httpWaitReady` polls every `pollMs` (default 3000). It is satisfied when **both** of these hold:
- `GET /api/version` → `app === version`;
- `GET /readyz` with the token → `status !== 'down'`, and the checks named `database` and `migrations` are `ok`.

`backups` or `email` being degraded must not fail an update.

**The sequence and the exact messages.** Here `<from>` is the current tag, `<to>` the requested one, and `<id>` the first 8 characters of the snapshot id.

| Step | On failure | Outcome | Alert text |
|---|---|---|---|
| 0. Take the lock | already held | cancelled | (none; CLI prints `Another update is already running.`) |
| 1. `<to> === <from>` | n/a | cancelled | (none; `Already on <to>.`) |
| 2. Both images available | missing | cancelled | `[<client>] Update to <to> cancelled: the new version is not on this box yet. Nothing was changed.` |
| 3. `stop app`, then `stop ops` | n/a | n/a | n/a |
| 4. Pre-update backup | throws | cancelled, after `up app` and `up ops` | `[<client>] Update to <to> cancelled: <backup error message> Nothing was changed; the app is running <from> again.` |
| 5. `writeTag(to)`, `runOnce('migrate')` | not ok | rollback, reason `the database update failed` | see below |
| 6. `up app`, `waitReady(to)` | not ok | rollback, reason `<detail>` | see below |
| 7. `up ops` | throws | still `updated`; the message gets ` (The monitor did not restart; run: docker compose up -d ops)` appended | n/a |
| 8. Done | n/a | updated | `[<client>] Updated from <from> to <to>. A backup (<id>) was taken first.` |

Rollback (`ops` is already stopped from step 3):
1. `stop app`;
2. `restoreDb(snapshotId)`. This recreates the `app` database from the backup (Task 18 `restoreDatabase`), so nothing the failed migration created survives and the same version can be tried again later;
3. `writeTag(from)`;
4. `up app`;
5. `waitReady(from)`;
6. `up ops`.

If that succeeds, the outcome is `rolled-back`: `[<client>] Update to <to> failed (<reason>), so it was undone automatically. The app is back on <from> with its data exactly as it was before the update.`

If any rollback step throws or is not ready, the outcome is `rollback-failed`. Even then, `up ops` is still attempted once (best effort, errors ignored), so the monitor is watching the box while the operator responds. The alert is: `[<client>] URGENT: update to <to> failed (<reason>) and the automatic undo also failed (<detail>). The app may be down. Backup <id> holds the data from before the update. See the runbook, section "Recovering from a failed update".`

`record(ok, message)` is called once with the final outcome (`ok` only for `updated`). The lock is always released, in `finally`.

- [ ] **Step 1: Write the failing tests**

`ops/test/update.test.ts`:

```ts
import { test, expect } from 'vitest';
import { runUpdate, type UpdateDeps } from '../src/update.js';

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
```

`ops/test/compose.test.ts`:
- `dockerCompose` with a `fakeRunner` issues `docker compose --project-directory /opt/hf -p acme up -d --no-deps app`, and so on.
- `writeTag('1.1.0')` on a temporary `.env` containing `A=1\nAPP_TAG=1.0.0\nB=2\n` gives `A=1\nAPP_TAG=1.1.0\nB=2\n`, and leaves no temp file behind.
- `writeTag` on a file with no `APP_TAG` line throws `The deployment settings (.env) have no APP_TAG line.`
- `fileLock`: the first `acquire` gives true and the second false; after `release`, true again; a lock file dated 2 hours ago is replaced.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project ops test/update.test.ts test/compose.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `compose.ts`, `lock.ts`, `update.ts` and the CLI**

- `cli.ts update --to <tag>` wires the real dependencies:
  - `dockerCompose` with the project name from `COMPOSE_PROJECT_NAME`;
  - `backup` = `runBackup(deps, 'pre-update')`;
  - `restoreDb` = `restoreDatabase(deps, id, 'app')`, run **after** the app is stopped. It drops and recreates `app` from the `postgres` maintenance database, then restores the dump (Task 18);
  - `httpWaitReady({ appUrl: 'http://app:3000', … })`;
  - `channelFromConfig`, `recordRun('update', …)`, `fileLock('/state/update.lock')`.
- It prints the outcome message and exits 0 for `updated`, 1 for `cancelled` or `rolled-back`, and 2 for `rollback-failed`.
- `update --status` prints the last 5 `update` rows from `ops_runs`.

- [ ] **Step 4: Verify (any machine)**

Run: `npm run verify`
Expected: all tests PASS (10 new).

- [ ] **Step 5: Verify for real (Docker build machine)**

`deploy/test/broken-image.Dockerfile`:

```dockerfile
ARG BASE
FROM ${BASE}
CMD ["node", "-e", "console.error('deliberately broken build for the rollback test'); process.exit(1)"]
```

Run, in the bundle from Task 17 Step 7 (set `HF_BUNDLE_DIR=/tmp/hf-bundle` and `COMPOSE_PROJECT_NAME=hfsmoke` in its `.env`; both reach the updater through the shared `x-ops-env` settings, as do `BACKUP_ALLOW_LOCAL=true` and the local repository that bundle uses):
```bash
cd /root/highland-foundation && npm run images                           # 0.1.0
docker tag highland/app:0.1.0 highland/app:0.1.1 && docker tag highland/ops:0.1.0 highland/ops:0.1.1
docker build -f deploy/test/broken-image.Dockerfile --build-arg BASE=highland/app:0.1.0 -t highland/app:0.1.2 deploy/test
docker tag highland/ops:0.1.0 highland/ops:0.1.2
cd /tmp/hf-bundle && docker compose up -d && sleep 20 && docker compose exec app node apps/server/dist/seed/cli.js >/dev/null
N0=$(docker compose exec -T db psql -U app -d app -tAc 'select count(*) from notes')
docker compose run --rm updater update --to 0.1.1; echo "exit $?"
docker compose run --rm updater update --to 0.1.2; echo "exit $?"
N1=$(docker compose exec -T db psql -U app -d app -tAc 'select count(*) from notes')
grep '^APP_TAG=' .env; curl -fsS localhost:8080/api/version; echo; [ "$N0" = "$N1" ] && echo DATA-INTACT
docker compose down -v
```
Expected:
- the first update prints `[Demo] Updated from 0.1.0 to 0.1.1. A backup (…) was taken first.` and `exit 0`;
- the second prints `[Demo] Update to 0.1.2 failed (…), so it was undone automatically. The app is back on 0.1.1 …` and `exit 1`;
- `APP_TAG=0.1.1`;
- `/api/version` shows `"app":"0.1.1"`;
- `DATA-INTACT`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: safe update — stop, encrypted pre-update backup, migrate, health gate, automatic rollback

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
