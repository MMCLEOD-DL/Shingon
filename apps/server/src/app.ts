import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { hasZodFastifySchemaValidationErrors, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { SESSION_COOKIE, loadSession, type Actor } from './auth/sessions.js';
import { registerAuthRoutes } from './auth/routes.js';
import { registerCsrf } from './http/csrf.js';
import { HttpError } from './http/errors.js';
import type { RouteAccess } from './http/route.js';

// Task 6 and Task 9 supply the real mail transport and file storage; until then the app only holds them.
export interface EmailTransport { send(message: unknown): unknown }
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
    trustProxy: true,
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
    if (status === 429) return reply.code(429).send({ error: 'Too many attempts. Please wait 15 minutes and try again.' });
    if (status === 413) return reply.code(413).send({ error: 'That file is too large.' });
    if (status !== undefined && status >= 400 && status < 500) return reply.code(400).send({ error: INVALID });
    // Log the failure without the request body, headers or cookies.
    req.log.error({ err: { message: err.message, stack: err.stack }, url: req.url, method: req.method }, 'Unhandled error');
    return reply.code(500).send({ error: 'Something went wrong on our side. It has been logged.' });
  });

  registerRoutes(app, config);
  return app;
}

/** Later tasks append their route modules here. */
function registerRoutes(app: FastifyInstance, config: Config): void {
  registerAuthRoutes(app, config);
}
