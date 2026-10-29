import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { defineRoute } from './http/route.js';
import { hasHealthToken } from './http/healthToken.js';

let foundationVersion: string | undefined;

export interface VersionLog { warn(msg: string): void }
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * The foundation release this app was built on, from foundation.json (found by walking up from `startDir`, so src, dist and the image all work).
 * A missing or unreadable file is logged once per attempt and answered 'unknown'; the failure is never cached, so a restored file is picked up.
 */
function readFoundation(startDir: string | undefined, log: VersionLog | undefined): string {
  if (startDir === undefined && foundationVersion !== undefined) return foundationVersion;
  let dir = startDir ?? MODULE_DIR;
  for (;;) {
    const file = path.join(dir, 'foundation.json');
    if (existsSync(file)) {
      try {
        const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
        if (typeof v === 'string' && v !== '') {
          if (startDir === undefined) foundationVersion = v;
          return v;
        }
      } catch { /* reported below */ }
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  log?.warn('foundation.json is missing or unreadable, so the foundation version is reported as "unknown". Put the file back from the foundation release this app was built on.');
  return 'unknown';
}

export function getVersionInfo(cfg: Pick<Config, 'appVersion' | 'commit'>, opts: { log?: VersionLog; startDir?: string } = {}): { app: string; foundation: string; commit: string } {
  return { app: cfg.appVersion, foundation: readFoundation(opts.startDir, opts.log), commit: cfg.commit };
}

export function registerVersionRoute(app: FastifyInstance, config: Config): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/version',
    access: { public: 'version check; details only with the health token' },
    handler(req) {
      // A stranger learns only the app version: the foundation version and commit would show which security fixes a box is missing.
      return Promise.resolve(hasHealthToken(req, config) ? getVersionInfo(config, { log: req.log }) : { app: config.appVersion });
    },
  });
}
