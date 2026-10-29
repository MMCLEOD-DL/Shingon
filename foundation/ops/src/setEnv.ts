import { lstat, readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { durableWrite, plainFsError, realFs, type DurableFs } from './durable.js';
import { dotenvValue } from './init.js';
import { USAGE } from './init-cli.js';
import { fileLock, pidAlive, type LockHolder } from './lock.js';

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
  'OCR_AZURE_ENDPOINT',
  'OCR_AZURE_KEY',
  'OCR_AZURE_REGION',
  'OCR_CONCURRENCY',
  'OCR_ENGINE',
  'OCR_TIMEOUT_MS',
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

/** Settings that may not be emptied: the updater picks its own image by APP_TAG. */
const NEVER_EMPTY = ['APP_TAG'];

export const BUSY = 'An update or another set-env is running, so nothing was changed. Try again when it has finished.';

/**
 * Reads `KEY=value` lines. Blank lines and `#` comments are skipped, as is a leading UTF-8 byte-order mark. The value is
 * everything after the first `=`, exactly as given (no quotes are removed); `KEY=` empties a setting (never APP_TAG).
 * Problems name the line and the key, never the value.
 */
export function parseSettings(input: string): { settings: { key: string; value: string }[]; problems: string[] } {
  const settings: { key: string; value: string }[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  input.replace(/^\uFEFF/, '').split('\n').forEach((line, i) => {
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
    if (value === '' && NEVER_EMPTY.includes(key)) { problems.push(`Line ${n}: ${key} cannot be empty; the updater needs it.`); return; }
    settings.push({ key, value });
  });
  return { settings, problems };
}

/**
 * The .env text with each setting written in: every `KEY=` line is replaced, or else the first `# KEY=` line (the commented
 * form `ops init` writes), or else the setting is appended at the end. Every other line stays byte for byte the same.
 * Values are written the way `ops init` writes them (dotenvValue). A file with Windows line endings keeps them, and a
 * leading byte-order mark stays where it is.
 */
export function applySettings(envText: string, settings: { key: string; value: string }[]): string {
  const bom = envText.startsWith('\uFEFF') ? '\uFEFF' : '';
  const eol = envText.includes('\r\n') ? '\r\n' : '\n';
  const lines = envText.slice(bom.length).split(eol);
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
  return `${bom}${lines.join(eol)}${eol}`;
}

export type SetEnvResult = { ok: true; keys: string[] } | { ok: false; problems: string[]; maybeChanged?: true; busy?: true };

/** The update lock (fileLock): held around the read-modify-write so set-env never races an update's APP_TAG or another set-env. */
export interface EnvLock { acquire(): Promise<boolean>; release(): Promise<void> }

/**
 * Writes the settings from `input` into `file` (the bundle's .env), keeping its mode and owner, through durableWrite (temp
 * file in the same folder, flushed, renamed). Any problem with the input means nothing is written. `keys` is sorted and
 * never comes with a value. `maybeChanged` is set when the write failed after the new file may already be in place. With
 * `lock`, the read, change and write happen while holding it; if it is held elsewhere nothing is read or written (`busy`).
 */
export async function setEnvFile(file: string, input: string, fs: DurableFs = realFs, opts: { lock?: EnvLock } = {}): Promise<SetEnvResult> {
  const { settings, problems } = parseSettings(input);
  if (problems.length > 0) return { ok: false, problems };
  if (settings.length === 0) return { ok: false, problems: ['No settings were given: standard input had no KEY=value lines.'] };
  const { lock } = opts;
  if (lock !== undefined) {
    let got: boolean;
    try {
      got = await lock.acquire();
    } catch (e) {
      return { ok: false, problems: [(e as Error).message] };
    }
    if (!got) return { ok: false, problems: [BUSY], busy: true };
  }
  try {
    return await writeSettings(file, settings, fs);
  } finally {
    await lock?.release().catch(() => undefined);
  }
}

async function writeSettings(file: string, settings: { key: string; value: string }[], fs: DurableFs): Promise<SetEnvResult> {
  let text: string;
  let st;
  try {
    st = await lstat(file);
    if (st.isSymbolicLink()) return { ok: false, problems: [`The .env in ${path.dirname(file)} is a link to another file, so set-env will not rewrite it (that would replace the link with a plain file).`] };
    if (!st.isFile()) return { ok: false, problems: [`The .env in ${path.dirname(file)} is not a plain file.`] };
    text = await readFile(file, 'utf8');
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
  /** Whether an update-lock holder on another host (container) is still running; without it such a holder counts as running. */
  isAlive?: (h: LockHolder) => Promise<boolean>;
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
  // The same lock as `ops update` (/state/update.lock), so an update's APP_TAG and another set-env are never overwritten.
  const stateDir = path.dirname(io.env['OPS_WORK_DIR']?.trim() || '/state/work');
  const isAlive = io.isAlive;
  const lock = fileLock(path.join(stateDir, 'update.lock'), () => new Date(), {
    isAlive: async (h) => (h.host === hostname() ? pidAlive(h.pid) : isAlive !== undefined ? isAlive(h) : true),
  });
  const r = await setEnvFile(path.join(bundleDir, '.env'), await io.readStdin(), io.fs, { lock });
  if (!r.ok) {
    io.err(r.problems.join('\n'));
    if (r.maybeChanged === true) return 1;
    if (r.busy === true) return 2;
    io.err('Nothing was changed.');
    return 2;
  }
  const n = r.keys.length;
  io.out(`Set ${String(n)} ${n === 1 ? 'setting' : 'settings'} in .env: ${r.keys.join(', ')}. Restart the services that use them: docker compose up -d`);
  return 0;
}
