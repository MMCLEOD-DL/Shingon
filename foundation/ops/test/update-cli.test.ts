import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { crashJsonLine, updateCli, type UpdateCliIo } from '../src/update-cli.js';
import { UNKNOWN_UPDATE_MESSAGE } from '../src/update.js';
import { UPDATE_RECORD } from '../src/journal.js';
import { USAGE } from '../src/init-cli.js';
import { fakeRunner, TEST_BACKUP_PASSWORD, withDeps, type FakeRunner } from './helpers.js';

let bundle = '';
beforeAll(async () => {
  bundle = await mkdtemp(path.join(tmpdir(), 'hf-update-cli-'));
  await writeFile(path.join(bundle, '.env'), 'APP_TAG=0.2.0\n');
  // An image file named after a secret: its name reaches the outcome message, which must hide it.
  await writeFile(path.join(bundle, `${TEST_BACKUP_PASSWORD}.tar`), 'not really images');
});
afterAll(async () => { await rm(bundle, { recursive: true, force: true }); });

/**
 * The CLI's surroundings: standard output and error kept line by line, the bundle folder, and ops deps on a fresh test
 * database in INSTANCE_MODE=demo with no alert channel, so alerts are written to the log (Ruling P6). The deps' log is the
 * one the CLI passes, as createOpsDeps does.
 */
function io(runner: FakeRunner, env: Record<string, string | undefined> = { HF_BUNDLE_DIR: bundle }) {
  const out: string[] = [];
  const err: string[] = [];
  let opened = false;
  const o: UpdateCliIo = {
    out: (l) => { out.push(...l.split('\n')); },
    err: (l) => { err.push(...l.split('\n')); },
    env,
    runner,
    // Like cli.ts's withDeps: an unexpected throw is said on standard error and gives exit 1.
    withDeps: (fn, log) => withDeps({ INSTANCE_MODE: 'demo' }, async (deps) => {
      opened = true;
      await mkdir(path.dirname(deps.cfg.workDir), { recursive: true });
      try {
        return await fn({ ...deps, run: runner, log });
      } catch (e) {
        err.push((e as Error).message);
        return 1;
      }
    }),
  };
  return { o, out, err, opened: () => opened };
}

/** Docker has nothing and can do nothing; chown fails too (so a root test run also warns about handing /state back). */
const nothingWorks = (): FakeRunner => fakeRunner(() => ({ code: 1, stdout: '', stderr: 'no' }));

describe('ops update --json', () => {
  test('a demo box with alerts in the log: exactly one line on standard output, the outcome as JSON; progress and the alert on standard error', async () => {
    const r = nothingWorks();
    const t = io(r);
    expect(await updateCli(['--to', '0.2.1', '--json'], t.o)).toBe(1);
    expect(t.out).toHaveLength(1);
    const j = JSON.parse(t.out[0]!);
    expect(j).toEqual({ schema: 1, outcome: 'cancelled', to: '0.2.1', message: expect.stringContaining('Update to 0.2.1 cancelled: the new version is not on this box yet.'), urgent: false, exitCode: 1 });
    expect(t.err).toContain('Updating Acme Test Ltd from 0.2.0 to 0.2.1.');
    expect(t.err.some((l) => l.startsWith('ALERT [Acme Test Ltd] Update to 0.2.1 cancelled'))).toBe(true);
    expect(t.err.some((l) => l.includes('Update to 0.2.1 cancelled'))).toBe(true);   // recordRun's print
    // Run as root (as the updater is), handing /state back fails here, and its warning goes to standard error too.
    if (process.getuid?.() === 0) expect(t.err.filter((l) => l.startsWith('Warning: the ops work folder'))).toHaveLength(2);
  });

  test('without --json nothing changes: progress, the alert and the outcome go to standard output and no JSON is printed', async () => {
    const t = io(nothingWorks());
    expect(await updateCli(['--to', '0.2.1'], t.o)).toBe(1);
    expect(t.out).toContain('Updating Acme Test Ltd from 0.2.0 to 0.2.1.');
    expect(t.out.some((l) => l.startsWith('ALERT '))).toBe(true);
    expect(t.out.some((l) => l.startsWith('{'))).toBe(false);
    expect(t.err).toEqual([]);
  });

  test('no secret reaches the JSON line, even when the outcome message would carry one', async () => {
    const t = io(nothingWorks());
    expect(await updateCli(['--to', '0.2.1', '--image-file', `${TEST_BACKUP_PASSWORD}.tar`, '--json'], t.o)).toBe(1);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out[0]!).message).toContain('The image file [hidden].tar could not be loaded');
    expect([...t.out, ...t.err].join('\n')).not.toContain(TEST_BACKUP_PASSWORD);
  });

  test('refusals before the update: the usual sentence on standard error, one refused line on standard output, exit 2', async () => {
    const cases: [string[], Record<string, string | undefined>, string, string | null][] = [
      [['--to', '0.2.1', '--status', '--json'], { HF_BUNDLE_DIR: bundle }, 'update needs exactly one of --to <version>, --status or --mark-recovered.', '0.2.1'],
      [['--status', '--json'], { HF_BUNDLE_DIR: bundle }, '--json can be used only with --to <version>.', null],
      [['--mark-recovered', '--json'], { HF_BUNDLE_DIR: bundle }, '--json can be used only with --to <version>.', null],
      [['--to', '0.2.1', '--json', '--colour'], { HF_BUNDLE_DIR: bundle }, 'update was given an option it does not know, or an option without its value.', null],
      [['--to', '0.2.1', '--json'], {}, 'update runs in the updater service, which knows where the bundle is (HF_BUNDLE_DIR): docker compose run --rm updater update --to <version>', '0.2.1'],
      [['--to', '0.2.1', '--image-file', 'missing.tar', '--json'], { HF_BUNDLE_DIR: bundle }, 'The image file missing.tar could not be found in the bundle folder', '0.2.1'],
    ];
    for (const [args, env, sentence, to] of cases) {
      const t = io(nothingWorks(), env);
      expect(await updateCli(args, t.o), args.join(' ')).toBe(2);
      expect(t.out, args.join(' ')).toHaveLength(1);
      const j = JSON.parse(t.out[0]!);
      expect(j).toMatchObject({ schema: 1, outcome: 'refused', to, urgent: false, exitCode: 2 });
      expect(j.message).toContain(sentence);
      expect(t.err.join('\n')).toContain(sentence);
      expect(t.opened()).toBe(false);
    }
  });

  test('an unexpected throw with no outcome: exactly one line, outcome "unknown" (never "cancelled"), exit 1', async () => {
    const noEnv = await mkdtemp(path.join(tmpdir(), 'hf-update-cli-noenv-'));   // no .env: reading APP_IMAGE throws
    try {
      const t = io(nothingWorks(), { HF_BUNDLE_DIR: noEnv });
      expect(await updateCli(['--to', '0.2.1', '--json'], t.o)).toBe(1);
      expect(t.out).toHaveLength(1);
      expect(JSON.parse(t.out[0]!)).toEqual({ schema: 1, outcome: 'unknown', to: '0.2.1', message: UNKNOWN_UPDATE_MESSAGE, urgent: false, exitCode: 1 });
      expect(t.err.join('\n')).toContain('ENOENT');
    } finally {
      await rm(noEnv, { recursive: true, force: true });
    }
  });

  test('a throw after the outcome (handing /state back): the line keeps the outcome and gives the real exit code', async () => {
    // An update record left behind: an urgent refusal (exit 3 on its own). Then the final hand-over of /state throws.
    let chowns = 0;
    const r = fakeRunner((c) => {
      if (c.cmd === 'chown' && ++chowns >= 2) throw new Error('chown could not start');
      return { code: c.cmd === 'chown' ? 0 : 1, stdout: '', stderr: '' };
    });
    const t = io(r);
    const inner = t.o.withDeps;
    t.o.withDeps = (fn, log) => inner(async (deps) => {
      await writeFile(path.join(path.dirname(deps.cfg.workDir), UPDATE_RECORD), JSON.stringify({ from: '0.2.0', to: '0.2.1', startedAt: '2026-10-28T09:00:00Z', step: 'migrating' }));
      return fn(deps);
    }, log);
    const realGetuid = process.getuid;
    process.getuid = () => 0;   // as root, so /state is handed back before and after the update
    try {
      expect(await updateCli(['--to', '0.2.1', '--json'], t.o)).toBe(1);
    } finally {
      process.getuid = realGetuid;
    }
    expect(chowns).toBe(2);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out[0]!)).toMatchObject({ outcome: 'cancelled', urgent: true, exitCode: 1 });
  });

  test('settings that cannot be read: one refused line, exit 2', async () => {
    const t = io(nothingWorks());
    t.o.withDeps = async () => 2;   // cli.ts's withDeps after loadOpsConfig refused (it says why on standard error)
    expect(await updateCli(['--to', '0.2.1', '--json'], t.o)).toBe(2);
    expect(t.out).toHaveLength(1);
    expect(JSON.parse(t.out[0]!)).toEqual({ schema: 1, outcome: 'refused', to: '0.2.1', message: 'The ops settings could not be read, so nothing was changed. The problem is on standard error.', urgent: false, exitCode: 2 });
  });

  test('a crash that escapes the command: the last-resort line is "unknown", and only for update --json', () => {
    expect(JSON.parse(crashJsonLine(['update', '--to', '0.2.1', '--json'])!)).toMatchObject({ outcome: 'unknown', to: '0.2.1', exitCode: 1 });
    expect(JSON.parse(crashJsonLine(['update', '--json', '--bogus'])!)).toMatchObject({ outcome: 'unknown', to: null });
    expect(crashJsonLine(['update', '--to', '0.2.1'])).toBeUndefined();
    expect(crashJsonLine(['backup', '--json'])).toBeUndefined();
  });

  test('without --json a refusal prints only its sentence and the usage, on standard error', async () => {
    const t = io(nothingWorks());
    expect(await updateCli(['--status', '--mark-recovered'], t.o)).toBe(2);
    expect(t.out).toEqual([]);
    expect(t.err.join('\n')).toBe(`update needs exactly one of --to <version>, --status or --mark-recovered.\n\n${USAGE}`);
  });
});
