import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { defineRoute } from './http/route.js';
import { hasHealthToken } from './http/healthToken.js';

let foundationVersion: string | undefined;

/** The foundation release this app was built on, read once from foundation.json (found by walking up from this file, so src, dist and the image all work). */
function readFoundation(): string {
  if (foundationVersion !== undefined) return foundationVersion;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const file = path.join(dir, 'foundation.json');
    if (existsSync(file)) {
      const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
      if (typeof v !== 'string') throw new Error('foundation.json has no version. Restore it from the foundation release this app was built on.');
      return (foundationVersion = v);
    }
    const up = path.dirname(dir);
    if (up === dir) throw new Error('foundation.json was not found. It must ship with the app, because it records which foundation release the app was built on.');
    dir = up;
  }
}

export function getVersionInfo(cfg: Pick<Config, 'appVersion' | 'commit'>): { app: string; foundation: string; commit: string } {
  return { app: cfg.appVersion, foundation: readFoundation(), commit: cfg.commit };
}

export function registerVersionRoute(app: FastifyInstance, config: Config): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/version',
    access: { public: 'version check; details only with the health token' },
    handler(req) {
      // A stranger learns only the app version: the foundation version and commit would show which security fixes a box is missing.
      return Promise.resolve(hasHealthToken(req, config) ? getVersionInfo(config) : { app: config.appVersion });
    },
  });
}
