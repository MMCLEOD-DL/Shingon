import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { updateCli, type UpdateCliIo } from '../src/update-cli.js';
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
    withDeps: (fn, log) => withDeps({ INSTANCE_MODE: 'demo' }, async (deps) => {
      opened = true;
      await mkdir(path.dirname(deps.cfg.workDir), { recursive: true });
      return fn({ ...deps, run: runner, log });
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

  test('without --json a refusal prints only its sentence and the usage, on standard error', async () => {
    const t = io(nothingWorks());
    expect(await updateCli(['--status', '--mark-recovered'], t.o)).toBe(2);
    expect(t.out).toEqual([]);
    expect(t.err.join('\n')).toBe(`update needs exactly one of --to <version>, --status or --mark-recovered.\n\n${USAGE}`);
  });
});
