import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../smoke/run-smoke.sh', import.meta.url).pathname;
const text = readFileSync(script, 'utf8');
// PATH holds only bash's own folder, so if a check were reached after the settings, "docker" would be missing.
const run = (env: Record<string, string>) => spawnSync('bash', [script], { env: { PATH: '/usr/bin:/bin', ...env }, encoding: 'utf8' });

test('a bad HF_SMOKE_DIR is refused before anything else', () => {
  for (const bad of ['relative/dir', '/', '/tmp/../etc', '/tmp/with space']) {
    const r = run({ HF_SMOKE_DIR: bad });
    expect(r.status, bad).toBe(2);
    expect(r.stderr).toContain('HF_SMOKE_DIR must be an absolute folder path');
  }
});
test('a bad HF_SMOKE_PROJECT is refused, and "highland" never allowed', () => {
  for (const bad of ['highland', 'Has-Caps', '-dash', 'x'.repeat(64)]) {
    const r = run({ HF_SMOKE_PROJECT: bad });
    expect(r.status, bad).toBe(2);
    expect(r.stderr).toContain('HF_SMOKE_PROJECT must be a Compose project name');
  }
});
test('the defaults are unchanged and every derived name follows the settings', () => {
  expect(text).toContain('DIR="${HF_SMOKE_DIR:-/tmp/hf-smoke}"');
  expect(text).toContain('PROJECT="${HF_SMOKE_PROJECT:-hfsmoke}"');
  expect(text).not.toMatch(/\/tmp\/hf-smoke-(alerts|cookies|images)/);   // derived from $DIR now
  expect(text).not.toContain('hf-smoke-rest');                          // "$PROJECT-rest" now
});
test('the smoke has a hard-kill step that checks data, health and every ops check', () => {
  const step = text.split('STEP="step 7a (hard kill)"')[1]?.split('STEP="step 8')[0] ?? '';
  expect(step).toContain('kill -s SIGKILL db app ops');
  expect(step).toContain('wait_healthy');
  expect(step).toMatch(/notes_count/);
  expect(step).toMatch(/ops_cli check/);
});

test('a trailing slash or a "." part in HF_SMOKE_DIR is refused too, so the derived files never land inside the folder', () => {
  for (const bad of ['/tmp/hf-smoke/', '/tmp/./hf-smoke', '/tmp/hf-smoke/.', '/.']) {
    const r = run({ HF_SMOKE_DIR: bad });
    expect(r.status, bad).toBe(2);
    expect(r.stderr).toContain('HF_SMOKE_DIR must be an absolute folder path');
  }
});
test('good settings pass the check and reach the Docker check, which refuses on a machine without Docker', () => {
  // PATH holds only dirname (the script finds its own folder with it), so "docker" is missing on any machine.
  const bin = mkdtempSync(join(tmpdir(), 'hf-smoke-test-'));
  try {
    const which = (cmd: string) => spawnSync('bash', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(which('dirname'), join(bin, 'dirname'));
    const bash = which('bash');
    for (const env of [{}, { HF_SMOKE_DIR: '/tmp/hf-smoke-acme-r1', HF_SMOKE_PROJECT: 'hf-acme-r1' }, { HF_SMOKE_PROJECT: 'x'.repeat(63) }]) {
      const r = spawnSync(bash, [script], { env: { PATH: bin, ...env }, encoding: 'utf8' });
      expect(r.status, JSON.stringify(env)).toBe(2);
      expect(r.stderr.trim()).toBe('Docker is not installed. Run this on a throwaway VM with Docker.');
    }
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});
test('the left-behind guard and the tear-down use the chosen names, and the REST server is "$PROJECT-rest"', () => {
  expect(text).toContain('REST_NAME="$PROJECT-rest"');
  expect(text).toContain('--name "$REST_NAME"');
  expect(text).toContain('docker rm -f "$REST_NAME"');
  expect(text).toMatch(/if \[ -e "\$DIR" \] .*name=\^\$REST_NAME\\\$.*com\.docker\.compose\.project=\$PROJECT/);
  // The settings are checked before the first Docker command and before the trap that tears down.
  const settings = text.indexOf('HF_SMOKE_PROJECT must be');
  expect(settings).toBeGreaterThan(0);
  expect(settings).toBeLessThan(text.indexOf('command -v docker'));
  expect(settings).toBeLessThan(text.indexOf('trap teardown EXIT'));
});
test('the hard-kill step also proves ops started again and no scheduled job ran twice', () => {
  const step = text.split('STEP="step 7a (hard kill)"')[1]?.split('STEP="step 8')[0] ?? '';
  expect(step).toMatch(/ops_starts_since "\$KILLED_AT"/);
  expect(step).toMatch(/job_runs_count/);
  expect(step).toMatch(/job_runs_duplicates\)" = 0/);
  expect(step).toContain('ok "hard kill of db, app and ops: back healthy in $((SECONDS - T0)) s, $NOTES_BEFORE notes kept, every check ✓"');
  // Every wait is bounded.
  expect(step.match(/-ge 180/g)?.length).toBe(2);
});
