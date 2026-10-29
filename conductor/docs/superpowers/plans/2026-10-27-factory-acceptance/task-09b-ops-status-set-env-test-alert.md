# Task 9b: Foundation follow-ups, part 2 — `ops status --json`, `ops set-env`, `ops test-alert`

**Repo: `/root/highland-foundation`, branch `plan12-modules`.** Contract 7.9 items 3, 4 and 5.

Three small `ops` commands so the factory (and the operator) can read and set a box's state without parsing prose or editing `.env` with `awk`:
- **`ops status --json`**: one line of JSON with the health checks and the latest backup, restore-test and update runs. Run in the ops service: `docker compose exec -T ops node ops/dist/cli.js status --json`. Without `--json` it prints the same as plain lines.
- **`ops set-env`**: reads `KEY=value` lines from standard input, accepts only the known keys, and rewrites `.env` atomically. Run in the updater service, which is the only one that has the bundle folder and runs as root (the owner of `.env`): `docker compose run --rm -T updater set-env < settings.txt`. It never prints a value.
- **`ops test-alert`**: sends one plain test alert through every configured channel, so the operator can see it arrive. Run in the ops service: `docker compose run --rm ops test-alert`.

Plan 10 stays on its v0.1.0 routes (`psql`, `awk`) for now; moving it to these is a later Conductor follow-up (Contract 7.9).

**Files:**
- Create: `ops/src/status.ts`, `ops/src/setEnv.ts`, `ops/src/testAlert.ts`
- Modify: `ops/src/runs.ts` (`lastRun` gains `notBusy`), `ops/src/init.ts` (export `dotenvValue`), `ops/src/cli.ts` (three cases), `ops/src/init-cli.ts` (`USAGE`), `docs/RUNBOOK.md`, `CHANGELOG.md`
- Test: `ops/test/status.test.ts`, `ops/test/set-env.test.ts`, `ops/test/test-alert.test.ts`, `ops/test/init-cli.test.ts` (command list)

**Interfaces:**
- Consumes: `monitorChecks`, `Check` (`ops/src/checks.ts`, `monitor.ts`); `lastRun`, `outstandingUpdate`, `scrub` (`runs.ts`); `alertSecrets`, `redactAlert`, `redactingChannel`, `channelFromConfig`, `AlertChannel` (`alerts.ts`); `durableWrite`, `DurableFs` (`durable.ts`); `BACKEND_ENV_KEYS` (`config.ts`); `generateEnv` (`init.ts`); `ukDate` (`time.ts`).
- Produces:

```ts
// ops/src/runs.ts
lastRun(db, kind, opts: { okOnly: boolean; notBusy?: boolean })   // notBusy: skip runs that did not start because a lock was held

// ops/src/status.ts
interface RunView { at: string /* ISO */; ok: boolean; detail: string }
interface OpsStatus { schema: 1; client: string; at: string; ok: boolean;
  checks: { name: string; ok: boolean; critical: boolean; detail: string }[];
  runs: { backup: RunView | null; backupOk: RunView | null; restoreTest: RunView | null; restoreTestOk: RunView | null; update: RunView | null } | null;
  outstandingUpdate: { at: string; snapshotId: string | null } | null;
  problems: string[] }                                  // e.g. the ops log could not be read
collectStatus(d: { cfg: OpsConfig; db: Db; now: () => Date; checks: () => Promise<Check[]> }): Promise<OpsStatus>   // never throws
statusLines(s: OpsStatus): string[]                     // plain output
// cli: status [--json]; exit 0 when s.ok, 1 otherwise; the JSON is printed either way

// ops/src/setEnv.ts
SETTABLE_ENV_KEYS: readonly string[]                    // see Step 3
GENERATED_ENV_KEYS = ['DB_PASSWORD', 'HEALTH_TOKEN', 'BACKUP_PASSWORD', 'HF_BUNDLE_DIR', 'COMPOSE_PROJECT_NAME'] as const
parseSettings(input: string): { settings: { key: string; value: string }[]; problems: string[] }
applySettings(envText: string, settings: { key: string; value: string }[]): string   // replace KEY= or "# KEY=" line, else append
setEnvFile(file: string, input: string, fs?: DurableFs): Promise<{ ok: true; keys: string[] } | { ok: false; problems: string[] }>
// cli: set-env (no options); needs HF_BUNDLE_DIR; exit 0 set, 2 refused (nothing written)

// ops/src/testAlert.ts
sendTestAlert(d: { cfg: Pick<OpsConfig, 'client' | 'instanceMode' | 'alerts'>; channel: AlertChannel; now: () => Date; log: (l: string) => void }): Promise<{ ok: boolean; message: string }>
// cli: test-alert (no options); exit 0 sent, 1 not sent
```

- [ ] **Step 1: Write the failing status tests** (`ops/test/status.test.ts`)

Use the test database helper the ops tests already use (`createTestDb`, as in `backup.integration.test.ts`) and a fake `checks`:
- `'status lists every check and the latest runs, busy runs left out'`: insert `ops_runs` rows: backup ok at 01:00, backup busy (not ok) at 02:00, restore-test failed at 03:00, restore-test ok at 00:30, one update ok. `collectStatus` returns `runs.backup.at` 01:00 (the busy one skipped), `runs.restoreTest.ok === false`, `runs.restoreTestOk.at` 00:30, `outstandingUpdate: null`, `ok` equal to every check passing.
- `'secrets never appear'`: a check detail and a run detail containing the backup password and `postgres://app:pw@db/app` come out as `[hidden]` and `postgres://app:***@db/app`.
- `'a database that cannot be read still gives a status'`: a `db` whose queries reject → `runs: null`, `ok: false`, `problems: ['The ops log in the database could not be read, so the backup and update history is missing. Is the database running?']`, and the checks are still listed.
- `'the JSON is one line'`: `JSON.stringify(s)` round-trips and `statusLines(s)` gives `✓ app` / `✗ name: detail` lines followed by `Last backup: 27 October 2026 at 01:00, done.`-style lines (via `ukDate`).

Run: `npx vitest run ops/test/status.test.ts` → FAIL.

- [ ] **Step 2: Implement `status`**

- `runs.ts`: `notBusy` adds `eq(opsRuns.busy, false)` to the filter. Existing callers are unchanged.
- `status.ts`: `collectStatus` runs `checks()` and the five `lastRun` calls plus `outstandingUpdate`; the database part is in its own `try`, so a failure fills `problems` and leaves the checks. Every `detail` goes through `scrub` and then `redactAlert(…, alertSecrets(cfg))`. `ok` is every check passing and no problems.
- `cli.ts`: `case 'status'`: only `--json` allowed. Builds checks as `check` does (`monitorChecks({ cfg, opsLockHeld })`), uses `withDeps`. With `--json` prints `JSON.stringify(status)`; otherwise `statusLines`.

Run: `npx vitest run ops/test/status.test.ts` → PASS.

- [ ] **Step 3: Write the failing set-env tests** (`ops/test/set-env.test.ts`)

- `'every key ops init writes is either settable or generated'`: collect every `KEY` from `generateEnv({...minimal options...}).env` (set lines and `# KEY=` lines); each is in `SETTABLE_ENV_KEYS` or `GENERATED_ENV_KEYS`. (Task 10 adds the `OCR_*` lines to `ops init`; this test makes it add them here too.)
- `'the keys Conductor sets are all accepted'`: each of `APP_TAG, APP_IMAGE, OPS_IMAGE, IMAGE_PULL_POLICY, COMPOSE_PROFILES, SMTP_URL, EMAIL_FROM, BACKUP_REPOSITORY, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION, B2_ACCOUNT_ID, B2_ACCOUNT_KEY, RESTIC_REST_USERNAME, RESTIC_REST_PASSWORD, MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, MATRIX_ROOM_ID, ALERT_WEBHOOK_URL, HEARTBEAT_URL, TUNNEL_TOKEN, TUNNEL_ENABLED` (Plan 10 Task 8's list) is in `SETTABLE_ENV_KEYS`.
- `'parseSettings refuses unknown, generated, repeated and malformed lines, naming each'`: input `"MATRIX_ROOM_ID=!a:b\nFOO=1\nDB_PASSWORD=x\nMATRIX_ROOM_ID=!c:d\nnot a setting\n"` → problems, in order: `Line 2: FOO is not a setting ops knows.`, `Line 3: DB_PASSWORD is made by ops init and cannot be changed this way.`, `Line 4: MATRIX_ROOM_ID is given twice.`, `Line 5 is not KEY=value.` (the CLI adds `Nothing was changed.` after the list); blank lines and `#` comments are skipped; a value with a carriage return or NUL is refused.
- `'applySettings replaces the line or its commented form, else appends, keeping everything else'`: `.env` text with `# MATRIX_HOMESERVER=` and `SMTP_URL=old` and comments → both replaced in place, `HEARTBEAT_URL` appended at the end, every other line byte for byte the same. Values are written with `dotenvValue` (a value with a space or `$` comes out quoted the way `ops init` quotes it).
- `'setEnvFile writes atomically with the old mode and owner, and writes nothing on a problem'`: with a recording `DurableFs` (as `compose.test.ts` does for `writeTag`) the calls are open-temp, write, sync, close, chmod 0600, chown, rename; a refused input makes no `open` call and leaves the file unchanged. The result lists keys, never values.

Run: `npx vitest run ops/test/set-env.test.ts` → FAIL.

- [ ] **Step 4: Implement `set-env`**

- `init.ts`: export `dotenvValue` (no change to its behaviour).
- `setEnv.ts`: `SETTABLE_ENV_KEYS` is a literal, sorted list: every key `ops init` writes except `GENERATED_ENV_KEYS`, plus `COMPOSE_PROFILES` and every `BACKEND_ENV_KEYS` entry (`B2_ACCOUNT_ID`, `B2_ACCOUNT_KEY` included). `setEnvFile` reads the file (missing → `There is no .env in <dir>. Run ops init first.`), stats it for mode and owner, and calls `durableWrite`.
- `cli.ts`: `case 'set-env'`: no options; refuses when standard input is a terminal (`set-env reads KEY=value lines from standard input, for example: docker compose run --rm -T updater set-env < settings.txt`); needs `HF_BUNDLE_DIR` (same sentence style as `update`); on success prints `Set 3 settings in .env: MATRIX_HOMESERVER, MATRIX_ROOM_ID, SMTP_URL. Restart the services that use them: docker compose up -d`.

Run: `npx vitest run ops/test/set-env.test.ts` → PASS.

- [ ] **Step 5: Write the failing test-alert tests** (`ops/test/test-alert.test.ts`)

- `'a test alert goes out with the client name and says nothing is wrong'`: a recording channel named `Matrix` receives exactly one text: `[Acme] Test alert from ops on 27 October 2026 at 10:00. Nothing is wrong; this only checks that alerts arrive.` → `{ ok: true, message: 'Test alert sent to Matrix.' }`.
- `'a channel that fails is reported plainly'`: the channel rejects with `The alert webhook refused the alert (HTTP 500).` → `{ ok: false, message: 'The test alert could not be sent: The alert webhook refused the alert (HTTP 500).' }`.
- `'a demo box with no channel says the alert only went to the log'`: `channelFromConfig` for `instanceMode: 'demo'` and no channels → `{ ok: true, message: 'No alert channel is set, so the test alert went to the ops log only.' }`.

Run: `npx vitest run ops/test/test-alert.test.ts` → FAIL.

- [ ] **Step 6: Implement `test-alert`**, the `USAGE` lines and the docs

- `testAlert.ts`: `sendTestAlert` as above; whether a real channel is set is read from `cfg.alerts`.
- `cli.ts`: `case 'test-alert'`: no options; `config()`, then `sendTestAlert({ cfg, channel: redactingChannel(channelFromConfig(cfg, say), alertSecrets(cfg)), now: () => new Date(), log: say })`; prints the message; exit 0 or 1.
- `init-cli.ts` `USAGE` gains:
  - `status [--json]` — "Shows the health checks and the latest backup, restore test and update. --json prints it as one line of JSON."
  - `set-env` — "Reads KEY=value lines from standard input and writes them into .env (only settings ops knows; never the ones ops init made). Run it in the updater: docker compose run --rm -T updater set-env < settings.txt"
  - `test-alert` — "Sends a test alert through every alert channel."
- `ops/test/init-cli.test.ts`: the command list in `'ops help prints every command …'` gains `status`, `set-env`, `test-alert`.
- `docs/RUNBOOK.md`: under "What the alerts mean", one line on `ops test-alert`; under "Setting up a new deployment", `set-env` as the way to fill in the checklist values; under "Backups and restoring", `ops status`.
- `CHANGELOG.md` Unreleased: `- New ops commands: status [--json], set-env (from standard input, known settings only) and test-alert.`

Run: `npx vitest run ops` → PASS.

- [ ] **Step 7: Verify and commit**

Run: `npm run verify` → PASS (the docs test still sees every runbook section).

```bash
git add -A
git commit -m "feat: ops status --json, ops set-env from standard input, ops test-alert

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
