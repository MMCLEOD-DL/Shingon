import { test, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jobRuns } from '@hf/server/db/schema';
import type { AppJob } from '@hf/server/jobs';
import type { Db } from '@hf/server/db';
import { catchUpAppJobs, claimRun, describeAppJobs, dueSince, lastJobRun, runAppJob, scheduleAppJobs } from '../src/appJobs.js';
import { onJobFailure } from '../src/daemon.js';
import { Monitor } from '../src/monitor.js';
import { startScheduler } from '../src/scheduler.js';
import type { OpsDeps } from '../src/runs.js';
import { withDeps } from './helpers.js';

let dir = '';
let profileOn = '';
let profileOff = '';
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'hf-app-jobs-'));
  profileOn = path.join(dir, 'on.json');
  profileOff = path.join(dir, 'off.json');
  await writeFile(profileOn, JSON.stringify({ schema: 1, modules: ['scheduled-jobs'], policy: { outbound: [], residency: 'uk' } }));
  await writeFile(profileOff, JSON.stringify({ schema: 1, modules: [], policy: { outbound: [], residency: 'uk' } }));
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

type TestDeps = OpsDeps & { logged: string[] };

/** OpsDeps on a fresh test database with scheduled-jobs on (unless `on` is false), a fixed clock and the log kept as `logged`. */
async function withJobDeps(fn: (deps: TestDeps) => Promise<void>, on = true): Promise<void> {
  await withDeps({ APP_PROFILE: on ? profileOn : profileOff }, async (base, rec) => {
    const deps = Object.assign(base, { logged: rec.logs, now: () => new Date('2026-03-02T09:00:20Z') });
    await fn(deps);
  });
}

/** A finished, successful run recorded for `due`, as if it ran before the box was switched off. */
async function seedRun(db: Db, job: string, due: Date): Promise<void> {
  await db.insert(jobRuns).values({ job, dueAt: due, startedAt: due, finishedAt: due, ok: true, summary: 'sent' });
}

test('dueSince finds the latest missed slot, or nothing', () => {
  const monthly = '0 7 1 * *';                                              // 07:00 UK time on the 1st
  expect(dueSince(monthly, new Date('2026-03-01T07:00:00Z'), new Date('2026-05-10T12:00:00Z'))).toEqual(new Date('2026-05-01T06:00:00Z'));   // BST
  expect(dueSince(monthly, new Date('2026-05-01T06:00:00Z'), new Date('2026-05-10T12:00:00Z'))).toBeNull();
  // A due time exactly now counts as due.
  expect(dueSince(monthly, new Date('2026-04-01T06:00:00Z'), new Date('2026-05-01T06:00:00Z'))).toEqual(new Date('2026-05-01T06:00:00Z'));
});

test('dueSince is capped, never a hang: an every-minute job after a year off still finds the latest minute', () => {
  const started = Date.now();
  expect(dueSince('* * * * *', new Date('2025-01-01T00:00:00Z'), new Date('2026-01-01T12:34:56Z'))).toEqual(new Date('2026-01-01T12:34:00Z'));
  expect(Date.now() - started).toBeLessThan(5000);
});

test('a due time runs once, however many times it is fired', async () => {
  await withJobDeps(async (deps) => {
    let runs = 0;
    const job: AppJob = { name: 'count', label: 'counter', cron: '* * * * *', catchUp: 'skip', run: async () => { runs++; return 'ok'; } };
    const due = new Date('2026-03-02T09:00:00Z');
    expect(await runAppJob(deps, job, due)).toBe('ran');
    expect(await runAppJob(deps, job, due)).toBe('already-ran');
    expect(runs).toBe(1);
    expect(await lastJobRun(deps.db, 'count')).toMatchObject({ ok: true, summary: 'ok' });
    // Whoever tries, the first claim wins and every later one is refused.
    expect(await claimRun(deps.db, 'count', due, deps.now())).toBe(false);
    expect(await claimRun(deps.db, 'count', new Date('2026-03-02T09:01:00Z'), deps.now())).toBe(true);
  });
});

test('the job gets the database, a log and its due time; its summary is one line of at most 500 characters with secrets hidden', async () => {
  await withJobDeps(async (deps) => {
    let seen: { dueAt: Date; hasDb: boolean } | undefined;
    const job: AppJob = {
      name: 'report', label: 'report', cron: '0 7 1 * *', catchUp: 'skip',
      run: async (ctx) => {
        seen = { dueAt: ctx.dueAt, hasDb: typeof ctx.db.select === 'function' };
        ctx.log(`talking to ${deps.cfg.databaseUrl}`);
        return `${'x'.repeat(600)}\nsecond line`;
      },
    };
    const due = new Date('2026-03-01T07:00:00Z');
    await runAppJob(deps, job, due);
    expect(seen).toEqual({ dueAt: due, hasDb: true });
    const row = await lastJobRun(deps.db, 'report');
    expect(row?.summary).toBe('x'.repeat(500));
    expect(deps.logged.join('\n')).not.toContain(deps.cfg.databaseUrl);
    expect(deps.logged.some((l) => l.startsWith('report: talking to '))).toBe(true);
  });
});

test('after downtime a monthly job catches up once, not once per missed month', async () => {
  await withJobDeps(async (deps) => {
    let runs = 0;
    const job: AppJob = { name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => { runs++; return 'sent'; } };
    await seedRun(deps.db, 'monthly-report', new Date('2026-02-01T07:00:00Z'));
    deps.now = () => new Date('2026-05-10T12:00:00Z');
    expect(await catchUpAppJobs(deps, [job])).toEqual(['monthly-report']);
    expect(runs).toBe(1);
    expect(deps.logged).toContain('monthly report: missed 3 runs while the box was off; ran once to catch up.');
    expect((await lastJobRun(deps.db, 'monthly-report'))?.dueAt).toEqual(new Date('2026-05-01T06:00:00Z'));
    expect(await catchUpAppJobs(deps, [job])).toEqual([]);                    // a restart straight after does nothing
    expect(runs).toBe(1);
  });
});

test('a run cut short by an ops restart is never run again for that due time', async () => {
  await withJobDeps(async (deps) => {
    let runs = 0;
    const job: AppJob = { name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => { runs++; return 'sent'; } };
    const due = new Date('2026-05-01T06:00:00Z');
    expect(await claimRun(deps.db, 'monthly-report', due, due)).toBe(true);  // started, then ops stopped mid-job
    deps.now = () => new Date('2026-05-10T12:00:00Z');
    expect(await catchUpAppJobs(deps, [job])).toEqual([]);
    expect(await runAppJob(deps, job, due)).toBe('already-ran');
    expect(runs).toBe(0);
    expect(await describeAppJobs(deps, [job])).toEqual([
      'monthly report — "0 7 1 * *" (UK time) — last run 1 May 2026 at 07:00: started but did not finish (ops stopped part-way through).',
    ]);
  });
});

test('a brand-new job does not catch up', async () => {
  await withJobDeps(async (deps) => {
    let runs = 0;
    const job: AppJob = { name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => { runs++; return 'sent'; } };
    deps.now = () => new Date('2026-05-10T12:00:00Z');
    expect(await catchUpAppJobs(deps, [job])).toEqual([]);
    expect(runs).toBe(0);
    expect(await lastJobRun(deps.db, 'monthly-report')).toBeNull();
  });
});

test('skip jobs never catch up', async () => {
  await withJobDeps(async (deps) => {
    let runs = 0;
    const job: AppJob = { name: 'reminder', label: 'receipt reminder', cron: '0 9 * * 1', catchUp: 'skip', run: async () => { runs++; } };
    await seedRun(deps.db, 'reminder', new Date('2026-02-02T09:00:00Z'));
    deps.now = () => new Date('2026-05-10T12:00:00Z');
    expect(await catchUpAppJobs(deps, [job])).toEqual([]);
    expect(runs).toBe(0);
  });
});

test('a failing job is recorded and alerted with its label, and the schedule carries on', async () => {
  await withJobDeps(async (deps) => {
    const sent: string[] = [];
    const monitor = new Monitor({ checks: async () => [], channel: { send: async (t) => { sent.push(t); } }, client: 'Acme' });
    let calls = 0;
    const job: AppJob = {
      name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once',
      run: async () => {
        calls++;
        if (calls === 1) throw new Error(`Mail server refused (password ${deps.cfg.backup.password})\n    at send (mail.js:1:1)`);
        return 'sent';
      },
    };
    const failure = onJobFailure(deps, monitor);
    const fire: Record<string, (at?: Date) => Promise<unknown>> = {};
    const s = startScheduler(await scheduleAppJobs(deps, [job], failure), failure, (_cron, name, f) => { fire[name] = f; return { stop: () => undefined }; });
    try {
      expect(await fire['monthly-report']!(new Date('2026-03-01T07:00:00.004Z'))).toBe('ran');
      expect(await lastJobRun(deps.db, 'monthly-report')).toMatchObject({ dueAt: new Date('2026-03-01T07:00:00Z'), ok: false, summary: 'Mail server refused (password [hidden])' });
      expect(sent).toEqual(['[Acme] Problem: the scheduled job "monthly report" failed. Mail server refused (password [hidden])']);
      expect(deps.logged).toContain('The scheduled job "monthly report" did not work: Mail server refused (password [hidden])');
      expect(deps.logged.join('\n')).not.toContain(deps.cfg.backup.password);
      expect(deps.logged.join('\n')).not.toContain('mail.js');
      // The next due time still runs. Without a time from the timer, the clock's minute is the due time.
      deps.now = () => new Date('2026-04-01T06:00:31Z');
      expect(await fire['monthly-report']!()).toBe('ran');
      expect(await lastJobRun(deps.db, 'monthly-report')).toMatchObject({ dueAt: new Date('2026-04-01T06:00:00Z'), ok: true, summary: 'sent' });
      expect(sent).toHaveLength(1);
    } finally {
      s.stop();
    }
  });
});

test('a failing catch-up run is alerted the same way and the other jobs still catch up', async () => {
  await withJobDeps(async (deps) => {
    const sent: string[] = [];
    const monitor = new Monitor({ checks: async () => [], channel: { send: async (t) => { sent.push(t); } }, client: 'Acme' });
    const bad: AppJob = { name: 'bad', label: 'bad job', cron: '0 7 1 * *', catchUp: 'once', run: async () => { throw new Error('Nothing to send'); } };
    const good: AppJob = { name: 'good', label: 'good job', cron: '0 7 1 * *', catchUp: 'once', run: async () => 'done' };
    await seedRun(deps.db, 'bad', new Date('2026-04-01T06:00:00Z'));
    await seedRun(deps.db, 'good', new Date('2026-04-01T06:00:00Z'));
    deps.now = () => new Date('2026-05-10T12:00:00Z');
    expect(await catchUpAppJobs(deps, [bad, good], onJobFailure(deps, monitor))).toEqual(['bad', 'good']);
    expect(deps.logged).toContain('bad job: missed 1 run while the box was off; ran it to catch up.');
    expect(sent).toEqual(['[Acme] Problem: the scheduled job "bad job" failed. Nothing to send']);
    expect(await lastJobRun(deps.db, 'good')).toMatchObject({ ok: true, summary: 'done' });
  });
});

test('with scheduled-jobs off, registered jobs are not started and one line says so', async () => {
  await withJobDeps(async (deps) => {
    let runs = 0;
    const mk = (name: string): AppJob => ({ name, label: name, cron: '0 7 1 * *', catchUp: 'once', run: async () => { runs++; } });
    await seedRun(deps.db, 'one', new Date('2026-01-01T07:00:00Z'));
    deps.now = () => new Date('2026-05-10T12:00:00Z');
    expect(await scheduleAppJobs(deps, [mk('one'), mk('two')], async () => undefined)).toEqual([]);
    expect(runs).toBe(0);
    expect(deps.logged).toEqual(['2 scheduled jobs are written but switched off. Add "scheduled-jobs" to app-profile.json to run them.']);
    deps.logged.length = 0;
    expect(await scheduleAppJobs(deps, [mk('one')], async () => undefined)).toEqual([]);
    expect(deps.logged).toEqual(['1 scheduled job is written but switched off. Add "scheduled-jobs" to app-profile.json to run them.']);
    deps.logged.length = 0;
    expect(await scheduleAppJobs(deps, [], async () => undefined)).toEqual([]);   // no jobs: nothing to say
    expect(deps.logged).toEqual([]);
  }, false);
});

test('with scheduled-jobs on, each job is scheduled on its own cron under its own name', async () => {
  await withJobDeps(async (deps) => {
    const job: AppJob = { name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => 'sent' };
    const jobs = await scheduleAppJobs(deps, [job], async () => undefined);
    expect(jobs.map((j) => [j.name, j.cron])).toEqual([['monthly-report', '0 7 1 * *']]);
  });
});

test('ops jobs lists each job with its schedule, last run in UK time and outcome', async () => {
  await withJobDeps(async (deps) => {
    const mk = (name: string, label: string): AppJob => ({ name, label, cron: '0 7 1 * *', catchUp: 'once', run: async () => undefined });
    await seedRun(deps.db, 'sent', new Date('2026-03-01T07:00:00Z'));
    await deps.db.insert(jobRuns).values({ job: 'broken', dueAt: new Date('2026-07-01T06:00:00Z'), startedAt: new Date('2026-07-01T06:00:00Z'), finishedAt: new Date('2026-07-01T06:00:01Z'), ok: false, summary: 'Mail server refused' });
    await deps.db.insert(jobRuns).values({ job: 'quiet', dueAt: new Date('2026-03-01T07:00:00Z'), startedAt: new Date('2026-03-01T07:00:00Z'), finishedAt: new Date('2026-03-01T07:00:01Z'), ok: true, summary: null });
    expect(await describeAppJobs(deps, [mk('sent', 'monthly report'), mk('broken', 'reminder'), mk('quiet', 'tidy-up'), mk('new', 'new job')])).toEqual([
      'monthly report — "0 7 1 * *" (UK time) — last run 1 March 2026 at 07:00: worked (sent).',
      'reminder — "0 7 1 * *" (UK time) — last run 1 July 2026 at 07:00: failed (Mail server refused).',
      'tidy-up — "0 7 1 * *" (UK time) — last run 1 March 2026 at 07:00: worked.',
      'new job — "0 7 1 * *" (UK time) — not run yet.',
    ]);
  });
});
