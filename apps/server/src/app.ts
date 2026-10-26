import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
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

import { registerNoteRoutes } from './notes/routes.js';
import { registerFileRoutes } from './files/routes.js';
import { sweepOrphans } from './files/repo.js';
import { LocalDiskStorage, type Storage } from './files/storage.js';
import { createTransport, startOutboxWorker, type EmailTransport } from './email/index.js';


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
  // True only while @fastify/static registers the built web app's files: those routes (and only those) go on the allow-list.
  let staticLoading = false;
  app.addHook('onRoute', (r) => {
    for (const method of Array.isArray(r.method) ? r.method : [r.method]) {
      app.hf.allRoutes.push({ method, url: r.url });
      if (staticLoading) app.hf.staticRoutes.push({ method, url: r.url });
    }
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
    errorResponseBuilder: (_req, ctx) => new HttpError(429, `Too many attempts. Please wait ${ctx.after} and try again.`),
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
    // A route may set its own value (file downloads: private, no-store) as long as it forbids storing the reply.
    if (req.url.startsWith('/api/') && !String(reply.getHeader('cache-control') ?? '').includes('no-store')) reply.header('cache-control', 'no-store');
  });

  const notFound = { error: "We couldn't find that." };
  if (config.webDistDir === undefined) {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send(notFound));
  } else {
    // The built web app. Files under /assets/ have hashed names, so they can be kept for a year; the page itself is always rechecked.
    staticLoading = true;
    const webRoot = path.resolve(config.webDistDir);
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      index: false,
      setHeaders(reply, filePath) {
        // Decided from the path inside the built app, so a folder called "assets" further up the disk changes nothing.
        const cacheable = path.relative(webRoot, filePath).split(path.sep)[0] === 'assets';
        reply.header('cache-control', cacheable ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
    staticLoading = false; // awaiting register loads the plugin, so its routes arrived while the flag was set
    app.setNotFoundHandler(async (req, reply) => {
      const url = req.url.split('?')[0] ?? '/';
      // Unknown API paths, missing files and other methods get the plain 404; only page paths get the app.
      if ((req.method !== 'GET' && req.method !== 'HEAD') || url === '/api' || url.startsWith('/api/') || url.startsWith('/assets/')) return reply.code(404).send(notFound);
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }
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

  const storage = deps.storage ?? new LocalDiskStorage(config.uploadDir);
  if (config.instanceMode !== 'test') {
    // Files that were uploaded but never attached to anything are removed after a day: a minute after start, then every 6 hours.
    const runSweep = (): void => {
      const now = deps.now?.() ?? new Date();
      sweepOrphans(db, storage, new Date(now.getTime() - 24 * 3600e3), app.log).catch((err: unknown) => {
        app.log.error({ errName: (err as Error).name }, 'File sweep failed');
      });
    };
    const sweep = setInterval(runSweep, 6 * 3600e3);
    const first = setTimeout(runSweep, 60e3);
    first.unref();
    sweep.unref();
    app.addHook('onClose', () => { clearInterval(sweep); clearTimeout(first); });
  }

  registerRoutes(app, config, storage, deps.now);
  return app;
}

/** Later tasks append their route modules here. */
function registerRoutes(app: FastifyInstance, config: Config, storage: Storage, now?: () => Date): void {
  registerAuthRoutes(app, config, now);
  registerUserRoutes(app, config, now);
  registerAuditRoutes(app);
  registerFileRoutes(app, config, storage);
  registerNoteRoutes(app, storage, now);
}
