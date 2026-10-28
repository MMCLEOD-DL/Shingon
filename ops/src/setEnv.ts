import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { durableWrite, plainFsError, realFs, type DurableFs } from './durable.js';
import { dotenvValue } from './init.js';
import { USAGE } from './init-cli.js';

/**
 * The settings `ops set-env` may write: every key `ops init` writes except the generated ones, plus COMPOSE_PROFILES and
 * every backup-destination sign-in (BACKEND_ENV_KEYS). Sorted. A test checks it against `ops init`'s output.
 */
export const SETTABLE_ENV_KEYS: readonly string[] = [
  'ALERT_WEBHOOK_URL',
  'APP_IMAGE',
  'APP_NAME',
  'APP_ORIGIN',
  'APP_TAG',
  'AUDIT_RETENTION_DAYS',
  'AWS_ACCESS_KEY_ID',
  'AWS_DEFAULT_REGION',
  'AWS_SECRET_ACCESS_KEY',
  'B2_ACCOUNT_ID',
  'B2_ACCOUNT_KEY',
  'BACKUP_ALLOW_LOCAL',
  'BACKUP_KEEP',
  'BACKUP_REPOSITORY',
  'BACKUP_SCHEDULE',
  'CLIENT_LABEL',
  'COMPOSE_PROFILES',
  'EDGE_SUBNET',
  'EMAIL_FROM',
  'HEARTBEAT_URL',
  'HTTPS_PORT',
  'HTTP_PORT',
  'IMAGE_PULL_POLICY',
  'INSTANCE_MODE',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_HOMESERVER',
  'MATRIX_ROOM_ID',
  'OPS_IMAGE',
  'RESTIC_REST_PASSWORD',
  'RESTIC_REST_USERNAME',
  'RESTORE_TEST_SCHEDULE',
  'SITE_ADDRESS',
  'SMTP_URL',
  'TUNNEL_ENABLED',
  'TUNNEL_IP',
  'TUNNEL_TOKEN',
  'UPDATER_TAG',
];

/** Made by `ops init` (secrets and the box's own layout): never changed by set-env. */
export const GENERATED_ENV_KEYS = ['DB_PASSWORD', 'HEALTH_TOKEN', 'BACKUP_PASSWORD', 'HF_BUNDLE_DIR', 'COMPOSE_PROJECT_NAME'] as const;

const EXAMPLE = 'docker compose run --rm -T updater set-env < settings.txt';
const KEY_VALUE = /^([A-Z][A-Z0-9_]*)=(.*)$/s;

/**
 * Reads `KEY=value` lines. Blank lines and `#` comments are skipped. The value is everything after the first `=`, exactly
 * as given (no quotes are removed). Problems name the line and the key, never the value.
 */
export function parseSettings(input: string): { settings: { key: string; value: string }[]; problems: string[] } {
  const settings: { key: string; value: string }[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  input.split('\n').forEach((line, i) => {
    const n = String(i + 1);
    if (line.trim() === '' || line.trimStart().startsWith('#')) return;
    const m = KEY_VALUE.exec(line);
    if (m === null) { problems.push(`Line ${n} is not KEY=value.`); return; }
    const key = m[1] ?? '';
    const value = m[2] ?? '';
    if ((GENERATED_ENV_KEYS as readonly string[]).includes(key)) { problems.push(`Line ${n}: ${key} is made by ops init and cannot be changed this way.`); return; }
    if (!SETTABLE_ENV_KEYS.includes(key)) { problems.push(`Line ${n}: ${key} is not a setting ops knows.`); return; }
    if (seen.has(key)) { problems.push(`Line ${n}: ${key} is given twice.`); return; }
    seen.add(key);
    if (/[\r\0]/.test(value)) {
      problems.push(`Line ${n}: ${key} has a carriage return or NUL character in its value. Values must be plain text on one line (save the file with Unix line endings).`);
      return;
    }
    settings.push({ key, value });
  });
  return { settings, problems };
}

/**
 * The .env text with each setting written in: every `KEY=` line is replaced, or else the first `# KEY=` line (the commented
 * form `ops init` writes), or else the setting is appended at the end. Every other line stays byte for byte the same.
 * Values are written the way `ops init` writes them (dotenvValue).
 */
export function applySettings(envText: string, settings: { key: string; value: string }[]): string {
  const lines = envText.split('\n');
  const endsWithNewline = lines.length > 0 && lines[lines.length - 1] === '';
  if (endsWithNewline) lines.pop();
  for (const { key, value } of settings) {
    const line = `${key}=${dotenvValue(key, value)}`;
    const live = lines.flatMap((l, i) => (l.startsWith(`${key}=`) ? [i] : []));
    if (live.length > 0) { for (const i of live) lines[i] = line; continue; }
    const commented = lines.findIndex((l) => new RegExp(`^#\\s*${key}=`).test(l));
    if (commented >= 0) lines[commented] = line;
    else lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

export type SetEnvResult = { ok: true; keys: string[] } | { ok: false; problems: string[]; maybeChanged?: true };

/**
 * Writes the settings from `input` into `file` (the bundle's .env), keeping its mode and owner, through durableWrite (temp
 * file in the same folder, flushed, renamed). Any problem with the input means nothing is written. `keys` is sorted and
 * never comes with a value. `maybeChanged` is set when the write failed after the new file may already be in place.
 */
export async function setEnvFile(file: string, input: string, fs: DurableFs = realFs): Promise<SetEnvResult> {
  const { settings, problems } = parseSettings(input);
  if (problems.length > 0) return { ok: false, problems };
  if (settings.length === 0) return { ok: false, problems: ['No settings were given: standard input had no KEY=value lines.'] };
  let text: string;
  let st;
  try {
    text = await readFile(file, 'utf8');
    st = await stat(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, problems: [`There is no .env in ${path.dirname(file)}. Run ops init first.`] };
    return { ok: false, problems: [`The deployment settings (.env) could not be read: ${plainFsError(e)}.`] };
  }
  const next = applySettings(text, settings);
  try {
    await durableWrite(file, next, { mode: st.mode & 0o777, owner: { uid: st.uid, gid: st.gid } }, fs);
  } catch (e) {
    const problem = `The settings could not be written into .env: ${plainFsError(e)}.`;
    // A failure before the rename leaves the old file; one while flushing the folder afterwards may leave the new one.
    const now = await readFile(file, 'utf8').catch(() => undefined);
    if (now === text) return { ok: false, problems: [problem] };
    return { ok: false, problems: [`${problem} The new settings may already be in .env; check it before restarting anything.`], maybeChanged: true };
  }
  return { ok: true, keys: settings.map((s) => s.key).sort() };
}

/** Where setEnvCli writes and reads (cli.ts gives the real ones; tests give fakes). */
export interface SetEnvCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** process.stdin.isTTY: undefined when standard input is a file or pipe. */
  stdinIsTTY: boolean | undefined;
  readStdin: () => Promise<string>;
  fs?: DurableFs;
}

/**
 * `ops set-env`: KEY=value lines on standard input into the bundle's .env. Runs in the updater service, the only one with
 * the bundle folder that runs as root (.env's owner): docker compose run --rm -T updater set-env < settings.txt
 * Exit 0 set; 2 refused (nothing written); 1 the write failed part-way (check .env). Never prints a value.
 */
export async function setEnvCli(rest: string[], io: SetEnvCliIo): Promise<number> {
  if (rest.length > 0) { io.err(`set-env takes no options.\n\n${USAGE}`); return 2; }
  if (io.stdinIsTTY === true) { io.err(`set-env reads KEY=value lines from standard input, for example: ${EXAMPLE}`); return 2; }
  const bundleDir = io.env['HF_BUNDLE_DIR']?.trim();
  if (bundleDir === undefined || bundleDir === '' || !bundleDir.startsWith('/')) {
    io.err(`set-env runs in the updater service, which knows where the bundle is (HF_BUNDLE_DIR): ${EXAMPLE}`);
    return 2;
  }
  const r = await setEnvFile(path.join(bundleDir, '.env'), await io.readStdin(), io.fs);
  if (!r.ok) {
    io.err(r.problems.join('\n'));
    if (r.maybeChanged === true) return 1;
    io.err('Nothing was changed.');
    return 2;
  }
  const n = r.keys.length;
  io.out(`Set ${String(n)} ${n === 1 ? 'setting' : 'settings'} in .env: ${r.keys.join(', ')}. Restart the services that use them: docker compose up -d`);
  return 0;
}
