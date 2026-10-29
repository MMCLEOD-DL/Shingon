import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const script = new URL('../smoke/run-smoke.sh', import.meta.url).pathname;
const text = readFileSync(script, 'utf8');
// The bad-setting cases must be refused by the settings check itself (exit 2 with its own message), before any Docker
// check runs; on a machine without Docker on this PATH, reaching that check would give a different message.
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
  expect(text).toContain('docker rm -f -v "$REST_NAME"');
  const guard = text.slice(text.indexOf('if [ -e "$DIR" ]'), text.indexOf('A previous smoke run was left behind'));
  for (const part of ['[ -L "$DIR" ]', '[ -e "$COOKIES" ]', '[ -L "$COOKIES" ]', '"$DIR-catcher.out"', 'compgen -G "$DIR-images-*.tar"',
    '"name=^$REST_NAME\\$"', 'docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"',
    'docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"', 'docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"']) {
    expect(guard, part).toContain(part);
  }
  expect(text).toContain('mkdir "$DIR"\n');
  expect(text).not.toContain('mkdir -p "$DIR"');
  // The settings are checked before the first Docker command and before the trap that tears down.
  const settings = text.indexOf('HF_SMOKE_PROJECT must be');
  expect(settings).toBeGreaterThan(0);
  expect(settings).toBeLessThan(text.indexOf('command -v docker'));
  expect(settings).toBeLessThan(text.indexOf('trap teardown EXIT'));
});
test('the hard-kill step also proves ops started again, the photo and job runs survived, and no alert was left open', () => {
  const step = text.split('STEP="step 7a (hard kill)"')[1]?.split('STEP="step 8')[0] ?? '';
  expect(step).toMatch(/ops_starts_since "\$KILLED_AT"/);
  expect(step).toMatch(/RUNS_AFTER" -ge "\$RUNS_BEFORE"/);
  expect(step).toContain('Vacuous in the foundation (no jobs); meaningful only for client');
  expect(text).not.toContain('job_runs_duplicates');   // job_runs' primary key makes a duplicate impossible, so no check claims it
  expect(step).toContain('"$BASE/api/files/$UPLOAD_ID/content"');
  expect(step).toMatch(/cmp -s "\$DIR\/after-kill\.png"/);
  expect(step).toContain('OPS_CLI_LIMIT=60 ops_cli check');
  // The alert mark is taken before the kill, and an "app is not answering" alert since then must be followed by Fixed.
  expect(step.indexOf('MARK="$(alert_lines)"')).toBeGreaterThan(-1);
  expect(step.indexOf('MARK="$(alert_lines)"')).toBeLessThan(step.indexOf('kill -s SIGKILL'));
  expect(step).toMatch(/down_since 'Fixed: The app is not answering\.'.*down_since 'problem: The app is not answering\.'/);
  expect(step).toContain('ok "hard kill of db, app and ops: back healthy in $BACK_IN s, $NOTES_BEFORE notes kept, every check ✓"');
  // Every wait is bounded, and the short docker calls are held to 60 s.
  expect(step.match(/-ge 180/g)?.length).toBe(2);
  expect(step).toMatch(/-ge 240/);
  expect(text).toMatch(/notes_count\(\) \{ dc60 exec/);
  expect(text).toMatch(/job_runs_count\(\) \{ dc60 exec/);
});
