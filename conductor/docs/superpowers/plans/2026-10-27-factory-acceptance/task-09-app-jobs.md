# Task 9: Scheduled app jobs

**Repo: `/root/highland-foundation`.**

**Decision (Ruling 8):** spec §5's "scheduled jobs" module is **covered by the ops scheduler**, extended with an app-job registry. A new module would duplicate what `ops/src/scheduler.ts` already does well: croner in UK time, no overlapping runs, and failure alerts through the operator's channel.

The parts that are missing for client jobs (a monthly report email, a "you have unconfirmed receipts" reminder) are:
- a place for client features to declare jobs;
- **exactly once per due time**, even across ops restarts;
- **catching up once** after downtime (Review Focus 5);
- run history the operator can read.

App jobs run in the ops container, never in the app (Ruling 8). The ops container is stopped during an update (Plan 6 Ruling 6), so a job never runs against a half-migrated database.

**Files:**
- Create: `apps/server/src/jobs/registry.ts`, `apps/server/src/jobs/index.ts` (the import list client apps add their job files to, like `seed/seeders/index.ts`; empty in the foundation), `apps/server/src/db/schema/jobRuns.ts` + generated migration, `ops/src/appJobs.ts`
- Modify: `apps/server/package.json` (export `./jobs` like `./db`), `ops/src/daemon.ts` (start app jobs when `scheduled-jobs` is on; `JOB_LABEL` uses each job's `label`), `ops/src/config.ts` (reads `APP_PROFILE` like the server), `ops/src/cli.ts` (`ops jobs`: lists app jobs with their last run), `CHANGELOG.md`
- Test: `ops/test/app-jobs.test.ts`, `apps/server/test/jobs-registry.test.ts`

**Interfaces:**
- Consumes: `Job`, `startScheduler`, `guardJob`, `ScheduleFn` (`ops/src/scheduler.ts`); `OpsDeps`, `recordRun` (`ops/src/runs.ts`); the alert channel and `onFailure` path in `daemon.ts`; `moduleOn`, `loadAppProfile` (Task 1).
- Produces: `AppJob`, `registerAppJob`, `appJobs`, `clearAppJobs`, `dueSince`, `claimRun`, `runAppJob`, `catchUpAppJobs` (index).

Table `job_runs`:
- `job text not null`, `due_at timestamptz not null`, primary key `(job, due_at)`;
- `started_at timestamptz not null`, `finished_at timestamptz null`, `ok boolean null`, `summary text null` (the job's one-line summary, or the failure's first line; at most 500 characters, no secrets).

Rules:
- `registerAppJob` refuses a name that is not kebab-case, a duplicate name, an empty label, and a cron expression croner cannot parse, each with a plain sentence (thrown at import time, so `npm test` catches it).
- `claimRun` inserts `(job, due_at, started_at)` with `on conflict do nothing` and returns whether the row was inserted. A run therefore happens at most once per due time, whoever tries.
- The scheduled path: croner fires at a due time → `runAppJob(deps, job, dueAt)` where `dueAt` is the scheduled minute (croner's current run time truncated to the minute) → claim → `job.run(ctx)` → `finished_at`, `ok`, `summary`. A throw sets `ok = false` with the first line, then re-throws, so the existing `onFailure` sends `[<client>] Problem: the scheduled job "<label>" failed. <first line>`.
- Catch-up at ops start, for each job with `catchUp: 'once'`: `after` = the latest `due_at` in `job_runs` for that job; with no row at all, nothing is caught up (a new job starts from now). `dueSince(cron, after, now)` gives the latest missed due time, or null. That one run happens; the slots in between are skipped and logged as `<label>: missed N runs while the box was off; ran once to catch up.`
- `catchUp: 'skip'` jobs never catch up.
- When `scheduled-jobs` is **not** on and jobs are registered, ops logs one line at start: `2 scheduled jobs are written but switched off. Add "scheduled-jobs" to app-profile.json to run them.` and runs none.

- [ ] **Step 1: Write the failing tests**

`ops/test/app-jobs.test.ts` (uses the test database helper, a manual `ScheduleFn`, and a fixed clock):

```ts
test('dueSince finds the latest missed slot, or nothing', () => {
  const monthly = '0 7 1 * *';                                              // 07:00 UK time on the 1st
  expect(dueSince(monthly, new Date('2026-03-01T07:00:00Z'), new Date('2026-05-10T12:00:00Z'))).toEqual(new Date('2026-05-01T06:00:00Z'));   // BST
  expect(dueSince(monthly, new Date('2026-05-01T06:00:00Z'), new Date('2026-05-10T12:00:00Z'))).toBeNull();
});

test('a due time runs once, however many times it is fired', async () => {
  let runs = 0;
  const job: AppJob = { name: 'count', label: 'counter', cron: '* * * * *', catchUp: 'skip', run: async () => { runs++; return 'ok'; } };
  const due = new Date('2026-03-02T09:00:00Z');
  expect(await runAppJob(deps, job, due)).toBe('ran');
  expect(await runAppJob(deps, job, due)).toBe('already-ran');
  expect(runs).toBe(1);
  expect(await lastRun(deps.db, 'count')).toMatchObject({ ok: true, summary: 'ok' });
});

test('after downtime a monthly job catches up once, not once per missed month', async () => {
  let runs = 0;
  const job: AppJob = { name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => { runs++; return 'sent'; } };
  await seedRun(deps.db, 'monthly-report', new Date('2026-02-01T07:00:00Z'));
  deps.now = () => new Date('2026-05-10T12:00:00Z');
  expect(await catchUpAppJobs(deps, [job])).toEqual(['monthly-report']);
  expect(runs).toBe(1);
  expect(deps.logged).toContain('monthly report: missed 3 runs while the box was off; ran once to catch up.');
  expect(await catchUpAppJobs(deps, [job])).toEqual([]);                    // a restart straight after does nothing
});

test('a brand-new job does not catch up', async () => { /* no job_runs rows -> [] */ });
test('skip jobs never catch up', async () => {});
test('a failing job is recorded and alerted with its label, and the schedule carries on', async () => {
  /* run throws Error('Mail server refused\nstack…') -> row ok=false summary 'Mail server refused'; channel got
     '[Acme] Problem: the scheduled job "monthly report" failed. Mail server refused'; the next fire still runs */
});
test('with scheduled-jobs off, registered jobs are not started and one line says so', async () => {});
```

`apps/server/test/jobs-registry.test.ts`:
- refuses `'Monthly Report'` (not kebab-case), a duplicate name, an empty label and the cron `'61 * * * *'`, each with its sentence;
- `appJobs()` returns jobs in registration order; `clearAppJobs()` empties it;
- `'the foundation registers no jobs'`: after importing `src/jobs/index.ts`, `appJobs()` is empty.
- `'registered jobs need the module switched on'`: when `appJobs().length > 0`, the repo's `app-profile.json` must list `scheduled-jobs`; otherwise the test fails with `Jobs are registered but app-profile.json does not switch on scheduled-jobs.` This catches a client app that forgets the flag at build time, not on the box.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run ops/test/app-jobs.test.ts apps/server/test/jobs-registry.test.ts` → FAIL.

- [ ] **Step 3: Implement** the registry, table, migration and `ops/src/appJobs.ts` as specified. `dueSince` uses croner with `timezone: 'Europe/London'`: walk `nextRun` from `after` while the result is `<= now`, returning the last one and the count. Stop after 10 000 steps; a `* * * * *` job after a long outage is capped, never a hang. In `daemon.ts`, map each app job to an ops `Job` whose `run` computes `dueAt` and calls `runAppJob`, append them to the job list given to `startScheduler`, and call `catchUpAppJobs` once before the scheduler starts. `ops jobs` prints one line per job: label, schedule, last run (UK time), and the outcome.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run ops apps/server` → PASS. `npm run verify` → PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ops): scheduled app jobs in the ops scheduler — once per due time, catch up once after downtime, alerts by label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
