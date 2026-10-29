# Task 18: Encrypted backups & tested restore

Spec §2.4 asks for "automatic backups and a restore that has actually been tested". Spec §4.6 adds: "restores are tested on a schedule … The backup destination varies by project … always encrypted, and never kept only on the same box."

How this task delivers it:
- restic encrypts every snapshot with `BACKUP_PASSWORD`.
- The destination is just `BACKUP_REPOSITORY`, so it can be client storage, operator storage or a bucket.
- Each backup holds a `pg_dump`, the uploads, and a **manifest** of row counts and file totals. The counts are taken **in the same database snapshot as the dump**, so they describe exactly what the dump holds even while people keep signing in and uploading during a scheduled backup. Otherwise the weekly exact-equality check would raise false alarms about busy tables such as `sessions`, and the operator would learn to ignore it.
- The scheduled restore test restores the newest snapshot into a scratch database and folder, then checks them against that manifest. A backup that cannot be restored is therefore found by a machine on Sunday morning, not by a client on the worst day.

**Files:**
- Create: `apps/server/src/db/schema/opsRuns.ts` and its migration
- Create: `ops/src/{runner,config,pg,manifest,backup,restore,runs,scheduler,daemon}.ts`
- Modify: `ops/src/cli.ts` (add `backup`, `restore-test`, `restore`, `daemon`)
- Test: `ops/test/{config,backup,manifest}.test.ts`, `ops/test/backup.integration.test.ts`, `ops/test/helpers.ts`

**Interfaces:**
- Consumes:
  - the server's migrations and `createTestDb` (Task 2), imported in tests by relative path `../../apps/server/test/helpers/testDb.js`;
  - `audit_purge_before` (Task 5);
  - the compose environment names (Task 17).
- Produces:
  - `Runner`, `runBackup`, `verifyLatestRestore`, `restoreDatabase`, `recordRun` (index).
  - `execRunner: Runner`: `spawn` with an explicit `env`, collecting output and enforcing the timeout. It **never logs args or env**.
  - `loadOpsConfig(env): OpsConfig`, which throws `OpsConfigError(problems)` with plain-English lines (same style as Task 2). `OpsConfig = { instanceMode: InstanceMode; databaseUrl: string; appInternalUrl: string; client: string; healthToken?: string; composeProject: string; backup: { repository: string; password: string; allowLocal: boolean; schedule: string; restoreTestSchedule: string; keep: string[]; backendEnv: Record<string, string> }; auditRetentionDays: number; workDir: string /* default '/state/work' */; uploadsDir: string /* default '/data/uploads' */; tunnelEnabled: boolean }`. Task 19 adds `alerts` and `heartbeatUrl`.
  - `assertOffBox(repo: string, allowLocal: boolean): void`.
  - `describeRepo(repo: string): string`: strips credentials, so `rest:https://u:p@nas:8000/acme` becomes `rest:https://nas:8000/acme`. Used in every message.
  - `pgEnv(databaseUrl): Record<'PGHOST' | 'PGPORT' | 'PGUSER' | 'PGPASSWORD' | 'PGDATABASE', string>`. The password never goes on a command line.
  - `buildManifest(client: pg.ClientBase, versions): Promise<Manifest>`, where `Manifest = { createdAt: string; tables: Record<string, number>; files: { count: number; bytes: number }; app: string; foundation: string }`. `client` is the connection holding the exported snapshot (backup step 3), so every count is read from the same snapshot `pg_dump` uses. `files` comes from the `files` **table** in that snapshot (`count(*)`, `coalesce(sum(size), 0)`), not from a walk of the uploads folder, which keeps changing.
  - `checkRestoredFiles(client: pg.ClientBase, uploadsRoot: string): Promise<{ count: number; bytes: number; problems: string[] }>`: for every row of the restored `files` table, the object at `<uploadsRoot>/<key[0..2]>/<key>` must exist with exactly `size` bytes. `count`/`bytes` total only the rows that pass. Extra objects on disk (uploads that arrived after the database snapshot) are ignored. Problems: `<n> files listed in the backed-up database did not come back (for example <file id>).` and `<n> restored files have the wrong size (for example <file id>).` (ids only, never file names, which may be personal data).
  - `compareManifest(expected: Manifest, actual: Omit<Manifest, 'createdAt' | 'app' | 'foundation'>): string[]`.
  - `OpsDeps = { cfg: OpsConfig; run: Runner; db: Db; now: () => Date; log: (line: string) => void }`. The pool behind `db` has a `pool.on('error', …)` handler that logs and carries on: `restoreDatabase` drops the database `WITH (FORCE)`, which kills the pool's idle connections, and an unhandled pool error would crash the daemon. The pool opens fresh connections on the next query.
  - Table `ops_runs(id bigserial pk, kind text not null check (kind in ('backup','restore-test','restore','update','audit-purge')), ok boolean not null, detail text not null, snapshot_id text, at timestamptz not null default now())`.
  - `lastRun(db, kind, { okOnly }): Promise<{ at: Date; ok: boolean; detail: string } | null>`, used by Task 19.
  - `startScheduler(jobs: { name: string; cron: string; run: () => Promise<void> }[], onFailure: (name: string, err: Error) => Promise<void>): { stop(): void }`, using croner with `timezone: 'Europe/London'` and `protect: true` (no overlap).
  - `ops daemon` schedules `backup` (`BACKUP_SCHEDULE`), `restore-test` (`RESTORE_TEST_SCHEDULE`) and `audit-purge` (daily at `15 3 * * *`: `SELECT audit_purge_before(now() - make_interval(days => AUDIT_RETENTION_DAYS))`). Task 19 adds the monitor to the same daemon.

**The work folder is fixed:** `<workDir>/backup/db.dump` and `<workDir>/backup/manifest.json` (in production `/state/work/backup/…`, the same path in `ops` and in `updater`, which share the `state` volume). restic groups snapshots by host **and paths** by default; a temporary or timestamped folder would make every snapshot its own group, so `forget` would never prune anything (storage grows forever) and `snapshots --latest 1` would return one snapshot per group. The fixed path, plus `--group-by host` on both commands, prevents both.

Backup steps (`runBackup`):
1. `assertOffBox`.
2. Run `restic cat config`. If it fails with `/unable to open config file|Is there a repository at the following location|repository does not exist/`, run `restic init` (the first backup creates the repository).
3. Open a dedicated `pg.Client` with `pgEnv`. Run `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` and `SELECT pg_export_snapshot() AS id`. Keep this transaction open until step 5 has finished; close it in `finally`.
4. Inside that transaction, write `<workDir>/backup/manifest.json` from `buildManifest(client, versions)`. The versions come from `GET ${APP_INTERNAL_URL}/api/version` **with the `x-health-token` header** (without it the app reveals only `app`, Task 16), with `unknown` if the app is down: a pre-update backup runs while the app is stopped.
5. Run `pg_dump --format=custom --no-owner --snapshot=<id> --file=<workDir>/backup/db.dump` with `pgEnv`. Then `COMMIT` and close the client.
6. Run `restic backup --json --host <slug of CLIENT_LABEL> --tag hf --tag <kind> <workDir>/backup/db.dump <workDir>/backup/manifest.json <uploadsDir>`. The snapshot id comes from the `"message_type":"summary"` line. (restic reads the uploads a few seconds after the database snapshot. A file uploaded in between is simply an extra object; a file **deleted** in between makes the restore test report it missing. That is a true statement about that backup, and rare, since the orphan sweep only touches files over a day old.)
7. For `kind === 'scheduled'` only: `restic forget --tag hf --group-by host --prune <BACKUP_KEEP split on spaces>`.
8. Remove the two work files, then `recordRun('backup', true, 'Backup <short id> saved to <describeRepo>: <n> MB.')`.

On failure, `recordRun('backup', false, <plain message>)` and throw `BackupError(<plain message>)`. The messages, from restic stderr:
- `/repository is already locked|unable to create lock/i` (checked first) → `The backup destination is busy with another backup or check (<describeRepo>). Try again in a few minutes.`
- `/unable to open repository|connection refused|no such host|timeout|network is unreachable/i` → `The backup destination could not be reached (<describeRepo>).`
- `/wrong password|no key found/i` → `The backup password does not match the backup destination.`
- `pg_dump` failing → `The database could not be read for the backup.`
- anything else → `The backup failed: <first stderr line, max 200 chars>.`

The restic environment is `{ RESTIC_REPOSITORY, RESTIC_PASSWORD, RESTIC_CACHE_DIR: '/state/restic-cache', plus whichever backend credential vars are non-empty }`.

Restore test (`verifyLatestRestore`):
1. `restic snapshots --json --tag hf --group-by host --latest 1` gives the newest snapshot. With `--group-by`, restic's JSON is a list of groups (`[{ "group_key": …, "snapshots": [ … ] }]`); take the newest `time` across the groups. If there is none: `There are no backups yet.`
2. If the snapshot is older than 26 hours: problem `The newest backup is <n> hours old (expected one every day).`
3. `restic restore <id> --target <workDir>/verify-<ts>`. restic keeps absolute paths under the target, so the dump is at `<target><workDir>/backup/db.dump` and the uploads under `<target><uploadsDir>`.
4. `CREATE DATABASE hf_restore_test_<ts>`, then `pg_restore --no-owner --dbname=hf_restore_test_<ts>`. Count the rows of every table, run `checkRestoredFiles` against the restored uploads, and pass both to `compareManifest`; add `checkRestoredFiles`' own problems.
5. **Always** (in `finally`) drop the scratch database and remove the folder.
6. `recordRun('restore-test', ok, ok ? 'Restore test passed: backup <id> from <date> restored completely.' : problems.join(' '))`.

`compareManifest` problem forms:
- `Table notes has 32 rows in the backup record but 0 after restoring.`
- `Table x is missing after restoring.`
- `The backup record lists 16 files (2 MB) but 15 files (2 MB) came back.`

`restoreDatabase(deps, snapshotId, targetDb)` restores the dump only, into a **freshly recreated** `targetDb`. Task 20's rollback uses it. `pg_restore --clean` is not enough: it drops only the objects that are in the dump, so tables, types and indexes created by a failed migration would survive, while `drizzle.__drizzle_migrations` went back to the old state, and the next attempt at that version would fail with `relation already exists`. So:
1. `restic restore <id> --target <workDir>/restore-<ts> --include <workDir>/backup/db.dump`.
2. Connect to the `postgres` maintenance database (same credentials, `PGDATABASE=postgres`) and run `DROP DATABASE IF EXISTS "<targetDb>" WITH (FORCE)`, then `CREATE DATABASE "<targetDb>"` (owned by the connecting role, the same role that owns everything in the dump). The identifier is checked against `/^[a-z_][a-z0-9_]{0,62}$/` first, because it cannot be a bind parameter.
3. `pg_restore --no-owner --dbname=<targetDb> <dump>`; a non-zero exit is a failure (`The saved database could not be put back.`).
4. Remove the folder in `finally`.

`ops restore <snapshot|latest> --yes-replace-live-data` (runbook only):
- refuses without the flag, or while `GET /healthz` on the app answers (`Stop the app first: docker compose stop app`);
- takes a `manual` safety backup first;
- restores the database (`restoreDatabase(…, 'app')`) and replaces the contents of `/data/uploads` with the snapshot's copy;
- runs `chown -R 1000:1000 /data/uploads` afterwards. Ops runs as root, and the app (user `node`, uid 1000) must still be able to save new uploads after a restore;
- records `restore`.

- [ ] **Step 1: Write the failing unit tests**

`ops/test/config.test.ts`:

```ts
import { test, expect } from 'vitest';
import { assertOffBox, describeRepo } from '../src/config.js';

test('backups must leave the box unless explicitly allowed for development', () => {
  for (const r of ['sftp:backup@nas.acme.lan:/srv/restic', 'rest:https://nas:8000/acme', 's3:https://s3.eu-west-2.amazonaws.com/acme-backups', 'b2:acme-backups:/hf'])
    expect(() => assertOffBox(r, false), r).not.toThrow();
  for (const r of ['/state/restic', 'local:/backups', 'relative/path']) {
    expect(() => assertOffBox(r, false), r).toThrow(/points at this box/);
    expect(() => assertOffBox(r, true), r).not.toThrow();
  }
});

test('credentials never appear when a destination is described', () => {
  expect(describeRepo('rest:https://user:secret@nas:8000/acme')).toBe('rest:https://nas:8000/acme');
  expect(describeRepo('sftp:backup@nas.acme.lan:/srv/restic')).toBe('sftp:backup@nas.acme.lan:/srv/restic');
});
```

`ops/test/manifest.test.ts`:

```ts
import { test, expect } from 'vitest';
import { compareManifest } from '../src/manifest.js';

const expected = { createdAt: 'x', app: '1', foundation: '0.1.0', tables: { notes: 32, users: 10 }, files: { count: 16, bytes: 2_000_000 } };
test('a complete restore has no problems', () => {
  expect(compareManifest(expected, { tables: { notes: 32, users: 10, extra_new: 0 }, files: { count: 16, bytes: 2_000_000 } })).toEqual([]);
});
test('missing rows, tables and files are spelled out', () => {
  expect(compareManifest(expected, { tables: { notes: 0 }, files: { count: 15, bytes: 1_900_000 } })).toEqual([
    'Table notes has 32 rows in the backup record but 0 after restoring.',
    'Table users is missing after restoring.',
    'The backup record lists 16 files (2 MB) but 15 files (2 MB) came back.',
  ]);
});
```

`ops/test/backup.test.ts` uses `fakeRunner(responder)` from `helpers.ts`, which records `{ cmd, args, env }` and returns `{ code, stdout, stderr }` from the responder. It also uses a real `createTestDb()` for the manifest and `ops_runs`.

```ts
test('first backup creates the repository; secrets go only in env', async () => {
  const calls = await withDeps({ BACKUP_REPOSITORY: 'sftp:b@nas:/r' }, async (deps, rec) => {
    rec.respond((c) => c.cmd === 'restic' && c.args[0] === 'cat' ? { code: 1, stdout: '', stderr: 'Fatal: unable to open config file: stat: no such file' }
      : c.cmd === 'restic' && c.args[0] === 'backup' ? { code: 0, stdout: '{"message_type":"summary","snapshot_id":"abcdef1234567890","total_bytes_processed":5242880}\n', stderr: '' }
      : { code: 0, stdout: '', stderr: '' });
    const r = await runBackup(deps, 'scheduled');
    expect(r.snapshotId).toBe('abcdef1234567890');
    return rec.calls;
  });
  expect(calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(['restic cat', 'restic init', 'pg_dump --format=custom', 'restic backup', 'restic forget']);
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
  const forget = calls.find((c) => c.args[0] === 'forget')!;
  expect(forget.args.slice(0, 5)).toEqual(['forget', '--tag', 'hf', '--group-by', 'host']);
});

test('a pre-update backup does not prune', async () => {
  const calls = await withDeps({}, async (deps, rec) => { rec.respond(okBackup); await runBackup(deps, 'pre-update'); return rec.calls; });
  expect(calls.some((c) => c.args[0] === 'forget')).toBe(false);
});
```

`withDeps(envOverrides, fn)`, `okBackup`, `deps0` and `TEST_BACKUP_PASSWORD` live in `helpers.ts`. `withDeps` creates the test DB, a temporary uploads dir and work dir, the config (with `BACKUP_ALLOW_LOCAL` false unless overridden, and `workDir`/`uploadsDir` pointing at the temporary folders) and `deps`, then cleans up. `deps0` exposes the config of the most recent `withDeps` call, so assertions can name the paths. The fake runner does not run `pg_dump`, but the snapshot export in step 3 is real (it runs against the test database), so the `--snapshot` value is a real snapshot id.

- [ ] **Step 2: Write the integration test (real restic and pg_dump)**

`ops/test/backup.integration.test.ts`:

```ts
import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
const has = (b: string) => { try { execFileSync(b, ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } };

describe.runIf(has('restic') && has('pg_dump') && has('pg_restore'))('real backup and restore test', () => {
  test('back up a seeded database and uploads, then prove the restore', async () => {
    await withRealDeps(async (deps) => {           // local temp repo, BACKUP_ALLOW_LOCAL=true, execRunner, seeded via seedDemo
      const { snapshotId } = await runBackup(deps, 'manual');
      expect(snapshotId).toMatch(/^[0-9a-f]{64}$/);
      const v = await verifyLatestRestore(deps);
      expect(v).toEqual({ ok: true, problems: [] });
      expect((await lastRun(deps.db, 'restore-test', { okOnly: true }))!.detail).toMatch(/^Restore test passed: backup [0-9a-f]{8} from /);
      const leftover = await deps.db.execute(sql`select datname from pg_database where datname like 'hf_restore_test_%'`);
      expect(leftover.rows).toEqual([]);
    });
  }, 120_000);

  test('a rollback restore leaves nothing from the failed update behind, and the update can be tried again', async () => {
    await withRealDeps(async (deps, info) => {     // info: { url, dbName } of the seeded test database
      const { snapshotId } = await runBackup(deps, 'pre-update');
      const notesBefore = await q(info.url, 'select count(*)::int n from notes');
      // what a failed migration might leave behind
      await q(info.url, `create type update_mood as enum ('x'); create table update_probe (id int, mood update_mood); delete from notes;`);
      await restoreDatabase(deps, snapshotId, info.dbName);
      expect(await q(info.url, `select to_regclass('public.update_probe')::text r`)).toEqual([{ r: null }]);
      expect(await q(info.url, `select count(*)::int n from pg_type where typname = 'update_mood'`)).toEqual([{ n: 0 }]);
      expect(await q(info.url, 'select count(*)::int n from notes')).toEqual(notesBefore);
      // the same "migration" now applies cleanly again
      await q(info.url, `create type update_mood as enum ('x'); create table update_probe (id int, mood update_mood);`);
      expect(await lastRun(deps.db, 'backup', { okOnly: true })).not.toBeNull();   // ops' pool survived the forced drop
    });
  }, 120_000);
});
```

`q(url, sql)` opens a fresh `pg.Client`, runs the SQL, closes, and returns `rows`. `withRealDeps` creates its database with `createTestDb()`, so the forced drop and recreate only ever touches that throwaway database.

When the tools are missing this suite is **skipped, not passed**. Step 6 runs it on the build machine, where `restic` is installed (`apt install restic`), and Task 21's smoke runs it inside the ops image.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run --project ops`
Expected: FAIL. The modules are missing.

- [ ] **Step 4: Implement**

Implement the modules exactly as specified above. Table names for the manifest come from `pg_tables WHERE schemaname = 'public'`, with an exact `count(*)` each. `ops_runs` itself is excluded, because it changes during the backup.

- [ ] **Step 5: Verify (any machine)**

Run: `npm run verify`
Expected: unit tests PASS (8 new). The integration suite reports as skipped if `restic` is absent.

- [ ] **Step 6: Verify (build machine with restic)**

Run: `apt-get install -y restic && npx vitest run --project ops test/backup.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: encrypted restic backups with manifest, scheduled restore test, safety-first restore

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
