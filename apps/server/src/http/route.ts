import type { FastifyInstance, FastifyReply, FastifyRequest, RouteGenericInterface } from 'fastify';
import type { ZodType, z } from 'zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { can, type Permission } from '@hf/shared';
import type { Actor } from '../auth/sessions.js';
import type { Db } from '../db/client.js';
import { forbidden, unauthorized } from './errors.js';

export type RouteAccess = { public: string } | { permission: Permission };

export interface RouteSchemas { params?: ZodType; query?: ZodType; body?: ZodType }

type Out<T> = T extends ZodType ? z.output<T> : unknown;
interface Generic<S extends RouteSchemas> extends RouteGenericInterface {
  Params: Out<S['params']>;
  Querystring: Out<S['query']>;
  Body: Out<S['body']>;
}

export interface RouteSpec<S extends RouteSchemas> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  /** `public` carries the reason the route needs no sign-in; `permission` names what the actor must hold. */
  access: RouteAccess;
  schema?: S;
  /** Passed straight to Fastify, for example `{ rateLimit: { ..., hook: 'preHandler' } }`. */
  config?: Record<string, unknown>;
  handler(
    req: FastifyRequest<Generic<S>>,
    reply: FastifyReply,
    ctx: { actor: Actor | null; db: Db },
  ): Promise<unknown>;
}

/**
 * The only way to add an HTTP route. It records the route and its access rule, checks the actor
 * before anything else about the request is examined (so a stranger gets 401 whatever they send),
 * and sends 204 when the handler returns nothing.
 */
export function defineRoute<S extends RouteSchemas>(app: FastifyInstance, spec: RouteSpec<S>): void {
  app.hf.routes.push({ method: spec.method, url: spec.url, access: spec.access });
  const access = spec.access;
  app.withTypeProvider<ZodTypeProvider>().route({
    method: spec.method,
    url: spec.url,
    schema: spec.schema ?? {},
    ...(spec.config ? { config: spec.config } : {}),
    // preValidation runs before the body and query are checked, so the 401/403 order in the
    // status-code oracle holds even for malformed input.
    preValidation: (req, _reply, done) => {
      if ('permission' in access && !req.actor) done(unauthorized());
      else if ('permission' in access && req.actor && !can(req.actor.role, access.permission)) done(forbidden());
      else done();
    },
    handler: async (req, reply) => {
      const result = await spec.handler(req as unknown as FastifyRequest<Generic<S>>, reply, { actor: req.actor, db: app.hf.db });
      if (result === undefined) {
        if (!reply.sent) return reply.code(204).send();
        return reply;
      }
      return result;
    },
  });
}
