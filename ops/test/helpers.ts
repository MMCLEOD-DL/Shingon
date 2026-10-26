import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import pg from 'pg';
import { createTestDb } from '../../apps/server/test/helpers/testDb.js';
import { loadConfig } from '../../apps/server/src/config.js';
import { seedDemo } from '../../apps/server/src/seed/demo.js';
import { loadOpsConfig } from '../src/config.js';
import { execRunner, type Runner, type RunResult } from '../src/runner.js';
import type { OpsDeps } from '../src/runs.js';

/** A throwaway backup password. Tests check it never shows up anywhere but the restic environment. */
export const TEST_BACKUP_PASSWORD = 'test-only-backup-password-7d1f3a9c';

export interface Call { cmd: string; args: string[]; env: Record<string, string>; timeoutMs: number | undefined }
export type Responder = (c: Call) => RunResult | Promise<RunResult>;
export interface FakeRunner extends Runner { calls: Call[]; logs: string[]; respond(r: Responder): void }

export function fakeRunner(responder: Responder = () => ({ code: 0, stdout: '', stderr: '' })): FakeRunner {
  let r = responder;
  const calls: Call[] = [];
  return {
    calls,
    logs: [],
    respond(next) { r = next; },
    async run(cmd, args, opts = {}) {
      const c: Call = { cmd, args: [...args], env: { ...(opts.env ?? {}) }, timeoutMs: opts.timeoutMs };
      calls.push(c);
      return r(c);
    },
  };
}

/** A repository that already exists and a backup that succeeds. */
export const okBackup: Responder = (c) =>
  c.cmd === 'restic' && c.args[0] === 'backup'
    ? { code: 0, stdout: '{"message_type":"status","percent_done":1}\n{"message_type":"summary","snapshot_id":"0123456789abcdef0123456789abcdef","total_bytes_processed":3000000}\n', stderr: '' }
    : { code: 0, stdout: '', stderr: '' };

/** A local port nothing listens on (fetch refuses some well-known ports such as 9 outright, which is not the same as "stopped"). */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((r) => srv.close(() => { r(); }));
  return port;
}

async function baseEnv(dbUrl: string, dir: string): Promise<Record<string, string>> {
  return {
    INSTANCE_MODE: 'test',
    DATABASE_URL: dbUrl,
    APP_INTERNAL_URL: `http://127.0.0.1:${String(await closedPort())}`,   // nothing listens: the app counts as stopped
    CLIENT_LABEL: 'Acme Test Ltd',
    COMPOSE_PROJECT_NAME: 'hftest',
    BACKUP_REPOSITORY: 'sftp:backup@nas.test.lan:/srv/restic',
    BACKUP_PASSWORD: TEST_BACKUP_PASSWORD,
    BACKUP_ALLOW_LOCAL: 'false',
    OPS_WORK_DIR: path.join(dir, 'state', 'work'),
    OPS_UPLOADS_DIR: path.join(dir, 'uploads'),
  };
}

/** The config of the most recent withDeps/withRealDeps call, so assertions can name its folders. */
export let deps0: OpsDeps;

export async function withDeps<T>(env: Record<string, string>, fn: (deps: OpsDeps, rec: FakeRunner) => Promise<T>): Promise<T> {
  const t = await createTestDb();
  const dir = await mkdtemp(path.join(tmpdir(), 'hf-ops-'));
  try {
    const cfg = loadOpsConfig({ ...(await baseEnv(t.url, dir)), ...env });
    await mkdir(cfg.uploadsDir, { recursive: true });
    const rec = fakeRunner();
    const deps: OpsDeps = { cfg, run: rec, db: t.db, now: () => new Date(), log: (l) => rec.logs.push(l) };
    deps0 = deps;
    return await fn(deps, rec);
  } finally {
    await t.close();
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RealInfo { url: string; dbName: string; dir: string; logs: string[] }

/** Real restic, pg_dump and pg_restore against a local repository in a temporary folder, with seeded demo data. */
export async function withRealDeps<T>(fn: (deps: OpsDeps, info: RealInfo) => Promise<T>): Promise<T> {
  const t = await createTestDb();
  const dir = await mkdtemp(path.join(tmpdir(), 'hf-ops-real-'));
  try {
    const cfg = loadOpsConfig({ ...(await baseEnv(t.url, dir)), BACKUP_REPOSITORY: path.join(dir, 'repo'), BACKUP_ALLOW_LOCAL: 'true' });
    await mkdir(cfg.uploadsDir, { recursive: true });
    const serverCfg = loadConfig({
      INSTANCE_MODE: 'test', APP_ORIGIN: 'http://localhost:3000', DATABASE_URL: t.url, UPLOAD_DIR: cfg.uploadsDir,
      EMAIL_TRANSPORT: 'memory', EMAIL_FROM: 'app@example.test',
    });
    await seedDemo(t.db, serverCfg);
    const logs: string[] = [];
    const deps: OpsDeps = { cfg, run: execRunner, db: t.db, now: () => new Date(), log: (l) => logs.push(l) };
    deps0 = deps;
    return await fn(deps, { url: t.url, dbName: new URL(t.url).pathname.slice(1), dir, logs });
  } finally {
    await t.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Runs SQL on a fresh connection and returns the rows. */
export async function q(url: string, text: string): Promise<Record<string, unknown>[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const r = await c.query(text);
    const last = Array.isArray(r) ? (r as pg.QueryResult[])[(r as pg.QueryResult[]).length - 1]! : r;
    return last.rows as Record<string, unknown>[];
  } finally {
    await c.end();
  }
}

/** One request a test server saw. `body` is parsed JSON when it can be, otherwise the raw text. */
export interface Seen { method: string; url: string; auth: string | undefined; body: any }

/**
 * A node:http server on 127.0.0.1 (a free port) that answers every request with `status` and records it. Stands in for
 * Matrix, a webhook or a heartbeat service, so no test ever reaches the real thing.
 */
export async function withServer<T>(status: number, fn: (base: string, seen: Seen[]) => Promise<T>): Promise<T> {
  const { createServer: createHttpServer } = await import('node:http');
  const seen: Seen[] = [];
  const srv = createHttpServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => { raw += d; });
    req.on('end', () => {
      let body: unknown = raw;
      try { body = raw === '' ? undefined : JSON.parse(raw); } catch { /* not JSON */ }
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body });
      res.writeHead(status, { 'content-type': 'application/json' }).end(status < 300 ? '{"event_id":"$x"}' : '{"errcode":"M_FORBIDDEN"}');
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${String((srv.address() as { port: number }).port)}`;
  try {
    return await fn(base, seen);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => { r(); }));
  }
}

/** A minimal OpsDeps with no database behind it, for code that only needs the settings, a clock and a log. */
export const stubDeps: OpsDeps = {
  cfg: loadOpsConfig({
    INSTANCE_MODE: 'test', DATABASE_URL: 'postgres://app:stub-db-password@127.0.0.1:1/app', APP_INTERNAL_URL: 'http://127.0.0.1:1',
    CLIENT_LABEL: 'Acme', BACKUP_REPOSITORY: 'sftp:backup@nas.test.lan:/srv/restic', BACKUP_PASSWORD: TEST_BACKUP_PASSWORD,
  }),
  run: fakeRunner(),
  db: {} as OpsDeps['db'],
  now: () => new Date(),
  log: () => undefined,
};
