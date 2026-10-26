import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { SESSION_COOKIE, loadSession, type Actor } from './auth/sessions.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerAuditRoutes } from './audit/routes.js';
import { registerUserRoutes } from './users/routes.js';
import { registerCsrf } from './http/csrf.js';
import { HttpError } from './http/errors.js';
import type { RouteAccess } from './http/route.js';

import { createTransport, startOutboxWorker, type EmailTransport } from './email/index.js';

// Task 9 supplies the real file storage; until then the app only holds it.
export interface Storage { readonly kind: string }

export interface AppDeps {
  config: Config;
  db: Db;
  emailTransport?: EmailTransport;
  storage?: Storage;
  now?: () => Date;
}

export interface HfState {
  db: Db;
  /** Every route declared through defineRoute. */
  routes: { method: string; url: string; access: RouteAccess }[];
  /** Every route Fastify itself saw (onRoute). The crossing gate compares this with `routes`. */
  allRoutes: { method: string; url: string }[];
  /** Built web app files (Task 11): the only allow-list for routes outside defineRoute. */
  staticRoutes: { method: string; url: string }[];
}

declare module 'fastify' {
  interface FastifyInstance { hf: HfState }
  interface FastifyRequest { actor: Actor | null; sessionId: string | null }
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const INVALID = 'Some of the details are not valid.';

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config, db } = deps;
  const app = Fastify({
    // Only the proxies we run are trusted, so a client cannot choose its own address by sending X-Forwarded-For.
    trustProxy: config.trustProxyHops === 0 ? false : (_address: string, hop: number) => hop < config.trustProxyHops,
    logger: config.instanceMode === 'test'
      ? false
      : {
          level: 'info',
          redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-health-token"]', 'res.headers["set-cookie"]'],
        },
  });

  app.decorate('hf', { db, routes: [], allRoutes: [], staticRoutes: [] } satisfies HfState);
  app.decorateRequest('actor', null);
  app.decorateRequest('sessionId', null);
  app.addHook('onRoute', (r) => {
    for (const method of Array.isArray(r.method) ? r.method : [r.method]) app.hf.allRoutes.push({ method, url: r.url });
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        frameAncestors: ["'none'"],
      },
    },
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => new HttpError(429, 'Too many attempts. Please wait 15 minutes and try again.'),
  });

  registerCsrf(app, config);

  app.addHook('onRequest', async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (typeof token !== 'string' || !TOKEN_SHAPE.test(token)) return;
    const s = await loadSession(db, token, deps.now?.());
    if (s) {
      req.actor = s.actor;
      req.sessionId = s.sessionId;
    }
  });

  app.addHook('onSend', async (req, reply) => {
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "We couldn't find that." }));
  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof HttpError) {
      return reply.code(err.status).send(err.issues === undefined ? { error: err.userMessage } : { error: err.userMessage, issues: err.issues });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      const issues = err.validation.map((v) => ({ path: v.instancePath.replace(/^\//, '').replaceAll('/', '.'), message: v.message }));
      return reply.code(400).send({ error: INVALID, issues });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 413) return reply.code(413).send({ error: 'That file is too large.' });
    if (status !== undefined && status >= 400 && status < 500) {
      const msg = status === 401 ? 'Please sign in.' : status === 403 ? "You don't have permission to do that." : status === 404 ? "We couldn't find that." : INVALID;
      return reply.code(status).send({ error: msg });
    }
    // Database error messages carry SQL parameters (emails, hashes), so only a fixed text, the error name and its code are logged.
    req.log.error({ errName: err.name, errCode: err.code, url: req.url.split('?')[0], method: req.method }, 'Unhandled error');
    return reply.code(500).send({ error: 'Something went wrong on our side. It has been logged.' });
  });

  const transport = deps.emailTransport ?? createTransport(config.email);
  if (config.instanceMode !== 'test') {
    const stop = startOutboxWorker(db, transport, { appName: config.appName, appOrigin: config.appOrigin, from: config.email.from }, { log: app.log });
    app.addHook('onClose', async () => { await stop(); });
  }

  registerRoutes(app, config, deps.now);
  return app;
}

/** Later tasks append their route modules here. */
function registerRoutes(app: FastifyInstance, config: Config, now?: () => Date): void {
  registerAuthRoutes(app, config, now);
  registerUserRoutes(app, now);
  registerAuditRoutes(app);
}
