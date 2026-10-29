import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { Storage } from '../files/storage.js';
import { defineRoute } from '../http/route.js';
import { hasHealthToken } from '../http/healthToken.js';
import { readinessCache, readinessStatus, runReadinessChecks } from './checks.js';

/** /readyz computes its checks at most this often, however many callers there are. */
export const READINESS_CACHE_MS = 5000;

/**
 * Liveness and readiness. Both are public (Docker, the ops monitor and outside watchers call them without signing in) and
 * neither is rate limited (the rate-limit plugin is registered with global: false, and these routes set no limit), because
 * behind Docker's proxy every caller can share one address. Instead, /readyz is cached (READINESS_CACHE_MS) and coalesced, so
 * a flood of requests cannot exhaust the database pool. The details of each check are shown only with the health token.
 */
export function registerHealthRoutes(app: FastifyInstance, config: Config, storage: Storage, now?: () => Date, cacheMs = READINESS_CACHE_MS): void {
  // The token decides only whether the details are shown, never whether the checks run again.
  const readiness = readinessCache(() => runReadinessChecks({ db: app.hf.db, storage, now: now ?? (() => new Date()) }), cacheMs);
  defineRoute(app, {
    method: 'GET',
    url: '/healthz',
    access: { public: 'liveness for Docker and the monitor' },
    handler: () => Promise.resolve({ status: 'ok' }),
  });

  defineRoute(app, {
    method: 'GET',
    url: '/readyz',
    access: { public: 'readiness; details only with the health token' },
    handler: async (req, reply) => {
      const checks = await readiness();
      const status = readinessStatus(checks);
      reply.code(status === 'down' ? 503 : 200).header('cache-control', 'no-store');
      return hasHealthToken(req, config) ? { status, checks } : { status };
    },
  });
}
