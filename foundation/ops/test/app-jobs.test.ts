import { test, expect, beforeAll, afterAll, describe } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { jobRuns } from '@hf/server/db/schema';
import type { AppJob } from '@hf/server/jobs';
import type { Db } from '@hf/server/db';
import { catchUpAppJobs, claimRun, describeAppJobs, dueAtFor, dueSince, jobsCommand, lastJobRun, runAppJob, scheduleAppJobs } from '../src/appJobs.js';
import { onJobFailure, startDaemon } from '../src/daemon.js';
import { Monitor } from '../src/monitor.js';
import { startScheduler } from '../src/scheduler.js';
import type { OpsDeps } from '../src/runs.js';
import { okBackup, withDeps, type FakeRunner } from './helpers.js';

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
async function withJobDeps(fn: (deps: TestDeps, rec: FakeRunner) => Promise<void>, on = true): Promise<void> {
  await withDeps({ APP_PROFILE: on ? profileOn : profileOff }, async (base, rec) => {
    const deps = Object.assign(base, { logged: rec.logs, now: () => new Date('2026-03-02T09:00:20Z') });
    await fn(deps, rec);
  });
}

/** A Monitor whose alerts land in `sent`, with checks that only count ticks. */
function testMonitor(): { monitor: Monitor; sent: string[]; ticks: () => number } {
  const sent: string[] = [];
  let n = 0;
  const monitor = new Monitor({ checks: async () => { n++; return []; }, channel: { send: async (t) => { sent.push(t); } }, client: 'Acme' });
  return { monitor, sent, ticks: () => n };
}

const never = (): Promise<string> => new Promise<string>(() => undefined);

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
      'monthly report — "0 7 1 * *" (UK time) — last run 1 May 2026 at 07:00: started but did not finish (ops stopped part-way through, or could not record how it went).',
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
    const s = startScheduler(scheduleAppJobs(deps, [job], failure).jobs, failure, (_cron, name, f) => { fire[name] = f; return { stop: () => undefined }; });
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
    expect(scheduleAppJobs(deps, [mk('one'), mk('two')], async () => undefined).jobs).toEqual([]);
    expect(runs).toBe(0);
    expect(deps.logged).toEqual(['2 scheduled jobs are written but switched off. Add "scheduled-jobs" to app-profile.json to run them.']);
    deps.logged.length = 0;
    expect(scheduleAppJobs(deps, [mk('one')], async () => undefined).jobs).toEqual([]);
    expect(deps.logged).toEqual(['1 scheduled job is written but switched off. Add "scheduled-jobs" to app-profile.json to run them.']);
    deps.logged.length = 0;
    expect(scheduleAppJobs(deps, [], async () => undefined).jobs).toEqual([]);   // no jobs: nothing to say
    expect(deps.logged).toEqual([]);
  }, false);
});

test('with scheduled-jobs on, each job is scheduled on its own cron under its own name', async () => {
  await withJobDeps(async (deps) => {
    const job: AppJob = { name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => 'sent' };
    const { jobs } = scheduleAppJobs(deps, [job], async () => undefined);
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

test('the due time is the schedule slot the fire was for, even when the fire is late', () => {
  expect(dueAtFor('0 7 1 * *', new Date('2026-03-01T07:00:00Z'))).toEqual(new Date('2026-03-01T07:00:00Z'));
  expect(dueAtFor('0 7 1 * *', new Date('2026-03-01T07:03:12Z'))).toEqual(new Date('2026-03-01T07:00:00Z'));   // held up 3 minutes
  expect(dueAtFor('*/15 * * * *', new Date('2026-03-02T09:29:59Z'))).toEqual(new Date('2026-03-02T09:15:00Z'));
});

test('a run still going after its time limit is recorded as failed and alerted by label; the job cannot hold anything up', async () => {
  await withJobDeps(async (deps) => {
    const { monitor, sent } = testMonitor();
    const job: AppJob = { name: 'stuck', label: 'stuck job', cron: '0 7 1 * *', catchUp: 'skip', run: never };
    const due = new Date('2026-03-01T07:00:00Z');
    const err = await runAppJob(deps, job, due, { timeLimitMs: 1000 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'AppJobError', label: 'stuck job', message: 'It did not finish within 1 second.' });
    expect(await lastJobRun(deps.db, 'stuck')).toMatchObject({ ok: false, summary: 'It did not finish within 1 second.' });
    await onJobFailure(deps, monitor)('stuck', err as Error);
    expect(sent).toEqual(['[Acme] Problem: the scheduled job "stuck job" failed. It did not finish within 1 second.']);
    // A job that throws after its limit is not an unhandled rejection, and its late outcome is not written.
    const late: AppJob = { ...job, name: 'late', run: () => new Promise<string>((_r, reject) => { setTimeout(() => { reject(new Error('too late')); }, 1300); }) };
    await expect(runAppJob(deps, late, due, { timeLimitMs: 1000 })).rejects.toThrow('It did not finish within 1 second.');
    await new Promise((r) => setTimeout(r, 500));
    expect(await lastJobRun(deps.db, 'late')).toMatchObject({ ok: false, summary: 'It did not finish within 1 second.' });
  });
});

test('a job is told through ctx.signal when ops stops waiting for it at the time limit', async () => {
  await withJobDeps(async (deps) => {
    let signal: AbortSignal | undefined;
    const job: AppJob = { name: 'stuck', label: 'stuck job', cron: '0 7 1 * *', catchUp: 'skip', run: (ctx) => { signal = ctx.signal; return never(); } };
    await expect(runAppJob(deps, job, new Date('2026-03-01T07:00:00Z'), { timeLimitMs: 1000 })).rejects.toThrow('It did not finish within 1 second.');
    expect(signal?.aborted).toBe(true);
  });
});

test('once ops is stopping, a job is told through ctx.signal and its failure is only logged, never alerted', async () => {
  await withJobDeps(async (deps) => {
    const { monitor, sent } = testMonitor();
    let started!: () => void;
    const begun = new Promise<void>((r) => { started = r; });
    const job: AppJob = {
      name: 'report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'skip',
      run: (ctx) => new Promise<string>((_r, reject) => {
        started();
        ctx.signal.addEventListener('abort', () => { reject(new Error('Cannot use a pool after calling end on the pool')); });
      }),
    };
    const failure = onJobFailure(deps, monitor);
    const app = scheduleAppJobs(deps, [job], failure);
    const fire: Record<string, (at?: Date) => Promise<unknown>> = {};
    const s = startScheduler(app.jobs, failure, (_c, name, f) => { fire[name] = f; return { stop: () => undefined }; });
    const run = fire['report']!(new Date('2026-03-01T07:00:00Z'));
    await begun;
    app.stop();
    s.stop();
    expect(await run).toBe('ran');
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);
    expect(deps.logged.some((l) => l.includes('monthly report') && l.includes('ops was stopping'))).toBe(true);
  });
});

test('a fire skipped because the last run is still going is logged each time and alerted once', async () => {
  await withJobDeps(async (deps) => {
    const { monitor, sent } = testMonitor();
    let release!: () => void;
    let calls = 0;
    const job: AppJob = {
      name: 'slow', label: 'slow job', cron: '*/5 * * * *', catchUp: 'skip',
      run: () => (++calls === 1 ? new Promise<string>((r) => { release = () => { r('done'); }; }) : Promise.resolve('quick')),
    };
    const failure = onJobFailure(deps, monitor);
    const fire: Record<string, (at?: Date) => Promise<unknown>> = {};
    const s = startScheduler(scheduleAppJobs(deps, [job], failure).jobs, failure, (_c, name, f) => { fire[name] = f; return { stop: () => undefined }; });
    try {
      const first = fire['slow']!(new Date('2026-03-02T09:00:00Z'));
      await new Promise((r) => setTimeout(r, 50));
      deps.now = () => new Date('2026-03-02T09:05:00Z');
      expect(await fire['slow']!(new Date('2026-03-02T09:05:00Z'))).toBe('skipped');
      deps.now = () => new Date('2026-03-02T09:10:00Z');
      expect(await fire['slow']!(new Date('2026-03-02T09:10:00Z'))).toBe('skipped');
      await new Promise((r) => setTimeout(r, 20));
      expect(sent).toEqual(['[Acme] Problem: the scheduled job "slow job" failed. The run due on 2 March 2026 at 09:05 was skipped because the run due on 2 March 2026 at 09:00 is still going.']);
      expect(deps.logged).toContain('slow job: The run due on 2 March 2026 at 09:10 was skipped because the run due on 2 March 2026 at 09:00 is still going.');
      release();
      expect(await first).toBe('ran');
      deps.now = () => new Date('2026-03-02T09:15:00Z');
      expect(await fire['slow']!(new Date('2026-03-02T09:15:00Z'))).toBe('ran');   // free again; the next stuck run would alert again
    } finally {
      s.stop();
    }
  });
});

test('at start, a run cut short by an ops stop is reported once by label and never run again', async () => {
  await withJobDeps(async (deps) => {
    const { monitor, sent } = testMonitor();
    let runs = 0;
    const job: AppJob = { name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => { runs++; return 'sent'; } };
    const due = new Date('2026-05-01T06:00:00Z');
    await claimRun(deps.db, 'monthly-report', due, due);
    deps.now = () => new Date('2026-05-10T12:00:00Z');
    await scheduleAppJobs(deps, [job], onJobFailure(deps, monitor)).startUp();
    const message = 'It started on 1 May 2026 at 07:00 but ops stopped before it finished (or could not record how it went), so it has not been run again. Check whether it did its work.';
    expect(sent).toEqual([`[Acme] Problem: the scheduled job "monthly report" failed. ${message}`]);
    expect(deps.logged).toContain(`The scheduled job "monthly report" did not work: ${message}`);
    expect(runs).toBe(0);
    await scheduleAppJobs(deps, [job], onJobFailure(deps, monitor)).startUp();   // the next start does not say it again
    expect(sent).toHaveLength(1);
    expect(runs).toBe(0);
  });
});

test('ops keeps working while an app job hangs: the scheduler starts first, the monitor ticks and a backup runs', async () => {
  await withJobDeps(async (deps, rec) => {
    rec.respond(okBackup);
    const { monitor, sent, ticks } = testMonitor();
    const hung: AppJob = { name: 'hung', label: 'hung job', cron: '0 7 1 * *', catchUp: 'once', run: never };
    await deps.db.insert(jobRuns).values({ job: 'hung', dueAt: new Date('2026-01-01T07:00:00Z'), startedAt: new Date('2026-01-01T07:00:00Z'), finishedAt: new Date('2026-01-01T07:00:01Z'), ok: true });
    const fire: Record<string, (at?: Date) => Promise<unknown>> = {};
    const daemon = await startDaemon(deps, {
      appJobs: [hung], alerting: { channel: { send: async (t) => { sent.push(t); } }, monitor }, appJobTimeLimitMs: 60_000,
      schedule: (_c, name, f) => { fire[name] = f; return { stop: () => undefined }; },
    });
    try {
      // startDaemon came back although the catch-up run never settles, and every job is on its timer.
      expect(Object.keys(fire).sort()).toEqual(['audit-purge', 'backup', 'hung', 'monitor', 'restore-test']);
      for (let i = 0; i < 3; i++) expect(await fire['monitor']!()).toBe('ran');
      expect(ticks()).toBe(3);
      expect(await fire['backup']!()).toBe('ran');
      expect(rec.calls.some((c) => c.cmd === 'restic' && c.args[0] === 'backup')).toBe(true);
      // The catch-up run is still going, so the next live fire of the same job is skipped and alerted, never run twice.
      expect(await fire['hung']!(new Date('2026-03-02T09:00:00Z'))).toBe('ran');   // the guard ran it; the job's own runner skipped it
      await new Promise((r) => setTimeout(r, 20));
      expect(sent.filter((t) => t.includes('"hung job"'))).toHaveLength(1);
      expect(sent[0]).toMatch(/was skipped because the run due on 1 March 2026 at 07:00 is still going\.$/);
    } finally {
      daemon.stop();
    }
  });
});

test('with scheduled-jobs off, startDaemon schedules only ops\' own jobs', async () => {
  await withJobDeps(async (deps) => {
    const { monitor } = testMonitor();
    const fire: Record<string, unknown> = {};
    const daemon = await startDaemon(deps, {
      appJobs: [{ name: 'report', label: 'report', cron: '0 7 1 * *', catchUp: 'once', run: async () => 'x' }],
      alerting: { channel: { send: async () => undefined }, monitor },
      schedule: (_c, name, f) => { fire[name] = f; return { stop: () => undefined }; },
    });
    await daemon.startUp;
    daemon.stop();
    expect(Object.keys(fire).sort()).toEqual(['audit-purge', 'backup', 'monitor', 'restore-test']);
    expect(deps.logged).toContain('1 scheduled job is written but switched off. Add "scheduled-jobs" to app-profile.json to run them.');
  }, false);
});

describe('ops jobs', () => {
  const io = (): { out: string[]; err: string[]; say: (l: string) => void; complain: (l: string) => void } => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, say: (l) => { out.push(l); }, complain: (l) => { err.push(l); } };
  };
  const job: AppJob = { name: 'report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => 'x' };

  test('extra words are a usage error and nothing is opened', async () => {
    const o = io();
    let opened = false;
    expect(await jobsCommand(['--all'], [job], async () => { opened = true; return 0; }, o)).toBe(2);
    expect(o.err[0]).toMatch(/^jobs takes no options\.\n\nUsage: ops <command>/);
    expect(opened).toBe(false);
  });

  test('no jobs', async () => {
    const o = io();
    expect(await jobsCommand([], [], async () => 1, o)).toBe(0);
    expect(o.out).toEqual(['This app has no scheduled jobs.']);
  });

  test('switched off, then on', async () => {
    await withJobDeps(async (deps) => {
      const o = io();
      expect(await jobsCommand([], [job], (fn) => fn(deps), o)).toBe(0);
      expect(o.out).toEqual(['These jobs are switched off. Add "scheduled-jobs" to app-profile.json to run them.', 'monthly report — "0 7 1 * *" (UK time) — not run yet.']);
    }, false);
    await withJobDeps(async (deps) => {
      const o = io();
      expect(await jobsCommand([], [job], (fn) => fn(deps), o)).toBe(0);
      expect(o.out).toEqual(['monthly report — "0 7 1 * *" (UK time) — not run yet.']);
    });
  });
});
