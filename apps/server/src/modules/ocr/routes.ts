import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ConfirmReadingInput } from '@hf/shared';
import { defineRoute } from '../../http/route.js';
import { notFound, unauthorized } from '../../http/errors.js';
import { confirmReading, getReading, requestReading, type ReadingDeps } from './repo.js';
import type { ReadingQueue } from './queue.js';

const IdParams = z.strictObject({ id: z.uuid() });
const NoQuery = z.strictObject({});
const NoBody = z.strictObject({});

export function registerReadingRoutes(app: FastifyInstance, queue: ReadingQueue, now?: () => Date): void {
  const deps = (req: { ip: string }): ReadingDeps => ({ ip: req.ip, ...(now ? { now: now() } : {}) });

  defineRoute(app, {
    method: 'POST',
    url: '/api/files/:id/reading',
    access: { permission: 'readings:read' },
    schema: { params: IdParams, query: NoQuery, body: NoBody },
    config: {
      // As uploads: 60 per 15 minutes per signed-in user, since each one costs a reading.
      rateLimit: { max: 60, timeWindow: '15 minutes', hook: 'preHandler', keyGenerator: (req: { ip: string; actor?: { id: string } | null }) => req.actor?.id ?? req.ip },
    },
    async handler(req, reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const reading = await requestReading(db, actor, req.params.id, deps(req));
      queue.enqueue(reading.id);
      return reply.code(202).send({ reading });
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/readings/:id',
    access: { permission: 'readings:read' },
    schema: { params: IdParams, query: NoQuery },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const reading = await getReading(db, actor, req.params.id);
      if (!reading) throw notFound();
      return { reading };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/readings/:id/confirm',
    access: { permission: 'readings:confirm' },
    schema: { params: IdParams, query: NoQuery, body: ConfirmReadingInput },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      return { reading: await confirmReading(db, actor, req.params.id, req.body, deps(req)) };
    },
  });
}
