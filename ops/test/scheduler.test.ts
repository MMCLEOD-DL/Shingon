import { test, expect } from 'vitest';
import { startScheduler } from '../src/scheduler.js';

test('a failing job is reported by name, and the same job never overlaps itself', async () => {
  const failures: string[] = [];
  let running = 0;
  let maxRunning = 0;
  let runs = 0;
  const s = startScheduler([
    { name: 'slow', cron: '* * * * * *', run: async () => { running++; maxRunning = Math.max(maxRunning, running); runs++; await new Promise((r) => setTimeout(r, 2500)); running--; } },
    { name: 'broken', cron: '* * * * * *', run: () => Promise.reject(new Error('boom')) },
  ], async (name, err) => { failures.push(`${name}: ${err.message}`); });
  await new Promise((r) => setTimeout(r, 3500));
  s.stop();
  expect(failures.length).toBeGreaterThan(0);
  expect(failures[0]).toBe('broken: boom');
  expect(runs).toBeGreaterThan(0);
  expect(maxRunning).toBe(1);
}, 10_000);

test('an invalid schedule is refused at start', () => {
  expect(() => startScheduler([{ name: 'x', cron: 'nonsense', run: () => Promise.resolve() }], () => Promise.resolve())).toThrow();
});
