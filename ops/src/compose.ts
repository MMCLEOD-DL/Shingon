import { randomBytes } from 'node:crypto';
import { chmod, chown, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Runner } from './runner.js';

/** What the updater asks of Docker Compose. Only the on-demand updater, which alone has the Docker socket, uses it (Ruling 7). */
export interface Compose {
  imageAvailable(image: string): Promise<boolean>;   // `docker image inspect`, else `docker pull` (true if either succeeds)
  stop(service: string): Promise<void>;              // docker compose stop <service>
  up(service: string): Promise<void>;                // docker compose up -d --no-deps <service>
  runOnce(service: string): Promise<{ ok: boolean; output: string }>;   // docker compose run --rm --no-deps <service>
  readTag(): Promise<string>;                        // APP_TAG from <bundleDir>/.env
  writeTag(tag: string): Promise<void>;              // rewrite only the APP_TAG line, via temp file + rename
}

/** A Docker image tag: what may follow the ":" in highland/app:<tag>. Nothing else can reach .env this way. */
export const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

export const notATag = (tag: string): string =>
  `"${tag.replace(/\s+/g, ' ').slice(0, 60)}" is not a version name (letters, numbers, dots, dashes and underscores only).`;

const NO_TAG_LINE = 'The deployment settings (.env) have no APP_TAG line.';
const APP_TAG_LINE = /^APP_TAG=.*$/m;

/** How the services are named in messages. */
const LABEL: Record<string, string> = { app: 'the app', ops: 'the monitor (ops)', proxy: 'the front door', migrate: 'the database update', 'edge-check': 'the tunnel settings check' };
const label = (service: string): string => LABEL[service] ?? service;

export const COMPOSE_TIMEOUTS = { stop: 3 * 60e3, up: 5 * 60e3, run: 60 * 60e3, inspect: 60e3, pull: 60 * 60e3, load: 60 * 60e3 } as const;

/** Reads one setting from <bundleDir>/.env, without quotes; undefined when it is missing or empty. */
export async function readEnvValue(bundleDir: string, key: string): Promise<string | undefined> {
  const text = await readFile(path.join(bundleDir, '.env'), 'utf8');
  const m = new RegExp(`^${key}=(.*)$`, 'm').exec(text);
  const v = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2');
  return v === undefined || v === '' ? undefined : v;
}

/**
 * Loads images from a file made with `docker save` (for a box that cannot reach the registry). The file must be inside the
 * bundle folder, which the updater sees at the same path. Never throws.
 */
export async function loadImageFile(run: Runner, file: string, env: Record<string, string> = {}): Promise<{ ok: boolean; message: string }> {
  const r = await run.run('docker', ['load', '-i', file], { env, timeoutMs: COMPOSE_TIMEOUTS.load });
  const name = path.basename(file);
  return r.code === 0
    ? { ok: true, message: `Loaded the images from ${name}.` }
    : { ok: false, message: `The image file ${name} could not be loaded (docker load stopped with code ${String(r.code)}). Check the file is in the bundle folder and complete.` };
}

/**
 * Docker Compose for one deployment. Every command is `docker compose --project-directory <bundleDir> -p <project> …` and
 * never `-f`, so Compose still loads a compose.override.yaml from the bundle folder. Docker sees only `env` (normally just
 * the registry sign-in folder), never the ops secrets, and nothing secret goes on a command line. Docker's own output is
 * never put in a message.
 */
export function dockerCompose(o: { run: Runner; bundleDir: string; project: string; env?: Record<string, string> }): Compose {
  const env = o.env ?? {};
  const envFile = path.join(o.bundleDir, '.env');
  const compose = (args: string[], timeoutMs: number) =>
    o.run.run('docker', ['compose', '--project-directory', o.bundleDir, '-p', o.project, ...args], { env, timeoutMs });
  const code = (n: number): string => `(docker compose stopped with code ${String(n)})`;
  return {
    async imageAvailable(image) {
      const inspect = await o.run.run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { env, timeoutMs: COMPOSE_TIMEOUTS.inspect });
      if (inspect.code === 0) return true;
      const pull = await o.run.run('docker', ['pull', image], { env, timeoutMs: COMPOSE_TIMEOUTS.pull });
      return pull.code === 0;
    },
    async stop(service) {
      const r = await compose(['stop', service], COMPOSE_TIMEOUTS.stop);
      if (r.code !== 0) throw new Error(`Docker could not stop ${label(service)} ${code(r.code)}.`);
    },
    async up(service) {
      // --no-deps: nothing else is started, so a failing one-shot edge check can never fail starting the app (Task 18 carry-over).
      const r = await compose(['up', '-d', '--no-deps', service], COMPOSE_TIMEOUTS.up);
      if (r.code !== 0) throw new Error(`Docker could not start ${label(service)} ${code(r.code)}.`);
    },
    async runOnce(service) {
      const r = await compose(['run', '--rm', '--no-deps', service], COMPOSE_TIMEOUTS.run);
      return { ok: r.code === 0, output: `${r.stdout}${r.stderr}` };
    },
    async readTag() {
      const m = APP_TAG_LINE.exec(await readFile(envFile, 'utf8'));
      if (!m) throw new Error(NO_TAG_LINE);
      return m[0].slice('APP_TAG='.length).trim().replace(/^(['"])(.*)\1$/, '$2');
    },
    async writeTag(tag) {
      if (!TAG.test(tag)) throw new Error(notATag(tag));
      const text = await readFile(envFile, 'utf8');
      if (!APP_TAG_LINE.test(text)) throw new Error(NO_TAG_LINE);
      const st = await stat(envFile);
      const tmp = path.join(o.bundleDir, `.env.update-${randomBytes(4).toString('hex')}`);
      try {
        await writeFile(tmp, text.replace(APP_TAG_LINE, `APP_TAG=${tag}`), { mode: st.mode & 0o777, flag: 'wx' });
        await chmod(tmp, st.mode & 0o777);
        // Keep the owner the operator gave .env (the updater runs as root); a non-root caller simply keeps its own.
        await chown(tmp, st.uid, st.gid).catch(() => undefined);
        await rename(tmp, envFile);
      } catch (e) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw new Error(`The new version could not be written into the deployment settings (.env): ${(e as NodeJS.ErrnoException).code ?? 'unknown problem'}.`);
      }
    },
  };
}
