import { test, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readAppProfile } from '@hf/shared/app-profile-file';
import { appJobs, clearAppJobs, registerAppJob, type AppJob } from '../src/jobs/registry.js';

// The app's job list, as ops loads it, taken before any test below clears the registry.
await import('../src/jobs/index.js');
const fromIndex = appJobs();
clearAppJobs();
const root = (p: string): string => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
// A client app's package.json carries its own name (the factory renames it), so this check is the foundation's alone.
const isFoundation = (JSON.parse(readFileSync(root('package.json'), 'utf8')) as { name: string }).name === 'highland-foundation';

const job = (over: Partial<AppJob> = {}): AppJob => ({
  name: 'monthly-report', label: 'monthly report', cron: '0 7 1 * *', catchUp: 'once', run: async () => 'sent', ...over,
});

afterEach(() => { clearAppJobs(); });

test('a name that is not lower-case words joined by dashes is refused', () => {
  expect(() => { registerAppJob(job({ name: 'Monthly Report' })); }).toThrow(
    'A scheduled job\'s name must be lower-case words joined by dashes, like monthly-report (got "Monthly Report").',
  );
});

test('a second job with the same name is refused', () => {
  registerAppJob(job());
  expect(() => { registerAppJob(job({ label: 'another report' })); }).toThrow(
    'There are two scheduled jobs called "monthly-report". Give each job its own name.',
  );
});

test('an empty label is refused', () => {
  expect(() => { registerAppJob(job({ label: '  ' })); }).toThrow(
    'The scheduled job "monthly-report" needs a label: the words the operator reads in alerts, like "monthly report".',
  );
});

test('a schedule croner cannot read is refused', () => {
  expect(() => { registerAppJob(job({ cron: '61 * * * *' })); }).toThrow(
    'The scheduled job "monthly-report" has a schedule that is not a five-part cron expression (minute hour day month weekday), like 0 7 1 * * (got "61 * * * *").',
  );
  // A seconds field would give more than one due time a minute, and a due time is a whole minute.
  expect(() => { registerAppJob(job({ cron: '0 0 7 1 * *' })); }).toThrow(/is not a five-part cron expression/);
});

test('the names of ops\' own jobs are refused', () => {
  for (const name of ['backup', 'restore-test', 'audit-purge', 'monitor']) {
    expect(() => { registerAppJob(job({ name })); }).toThrow(
      `The name "${name}" belongs to one of ops' own jobs. Give the scheduled job another name.`,
    );
  }
  expect(appJobs()).toEqual([]);
});

test('a catch-up rule other than once or skip is refused', () => {
  expect(() => { registerAppJob(job({ catchUp: 'always' as AppJob['catchUp'] })); }).toThrow(
    'The scheduled job "monthly-report" must say catchUp: \'once\' (run once after the box was off) or \'skip\' (wait for the next due time).',
  );
});

test('jobs come back in the order they were registered, and clearing empties the list', () => {
  registerAppJob(job({ name: 'zeta', label: 'zeta' }));
  registerAppJob(job({ name: 'alpha', label: 'alpha' }));
  expect(appJobs().map((j) => j.name)).toEqual(['zeta', 'alpha']);
  appJobs().pop();                                   // a copy: changing it changes nothing
  expect(appJobs()).toHaveLength(2);
  clearAppJobs();
  expect(appJobs()).toEqual([]);
});

test.runIf(isFoundation)('the foundation registers no jobs', () => {
  expect(fromIndex).toEqual([]);
});

test('registered jobs need the module switched on', () => {
  if (fromIndex.length === 0) return;
  const r = readAppProfile(root('app-profile.json'));
  if (!r.ok || !r.profile.modules.includes('scheduled-jobs')) {
    throw new Error('Jobs are registered but app-profile.json does not switch on scheduled-jobs.');
  }
});
