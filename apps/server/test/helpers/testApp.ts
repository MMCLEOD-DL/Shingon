import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../../src/config.js';
import type { Db } from '../../src/db/client.js';
import { buildApp } from '../../src/app.js';
import { SESSION_COOKIE, createSession } from '../../src/auth/sessions.js';
import { memoryTransport } from '../../src/email/index.js';
import { createTestDb } from './testDb.js';

export type MemoryTransport = ReturnType<typeof memoryTransport>;

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  config: Config;
  mail: MemoryTransport;
  storageDir: string;
  close(): Promise<void>;
}

export async function createTestApp(
  overrides: Partial<Config> & { beforeReady?: (app: FastifyInstance) => void | Promise<void> } = {},
): Promise<TestApp> {
  const { beforeReady, ...configOverrides } = overrides;
  const testDb = await createTestDb();
  let storageDir: string | undefined;
  let app: FastifyInstance | undefined;
  try {
    storageDir = await mkdtemp(join(tmpdir(), 'hf-uploads-'));
    const config: Config = {
      instanceMode: 'test',
      appName: 'Test App',
      appOrigin: 'http://hf.test',
      port: 0,
      databaseUrl: testDb.url,
      cookieSecure: false,
      trustProxyHops: 1,
      uploadDir: storageDir,
      uploadMaxBytes: 15 * 1024 * 1024,
      email: { transport: 'memory', from: 'Test <t@hf.test>', pollMs: 5000 },
      appVersion: '0.0.0-test',
      commit: 'test',
      ...configOverrides,
    };
    const mail = memoryTransport();
    app = await buildApp({ config, db: testDb.db, emailTransport: mail });
    await beforeReady?.(app);
    await app.ready();
    const dir = storageDir;
    const builtApp = app;
    return {
      app: builtApp, db: testDb.db, config, mail, storageDir: dir,
      async close() {
        await builtApp.close();
        await testDb.close();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await app?.close().catch(() => undefined);
    await testDb.close().catch(() => undefined);
    if (storageDir) await rm(storageDir, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
}

/** Creates a session directly (no password round trip) and returns the cookie header value. */
export async function signInAs(t: { db: Db }, user: { id: string }): Promise<{ cookie: string }> {
  const { token } = await createSession(t.db, user.id, {});
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

export async function call(
  t: { app: FastifyInstance; config: Config },
  auth: { cookie: string } | null,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: any; text: string; headers: Record<string, unknown> }> {
  const headers: Record<string, string> = { origin: t.config.appOrigin };
  if (auth) headers['cookie'] = auth.cookie;
  const res = await t.app.inject({ method, url, headers, ...(body === undefined ? {} : { payload: body as object }) });
  const contentType = res.headers['content-type'];
  const isJson = typeof contentType === 'string' && contentType.includes('application/json');
  return { status: res.statusCode, json: isJson ? res.json() : undefined, text: res.body, headers: res.headers };
}
