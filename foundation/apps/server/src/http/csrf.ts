import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import { HttpError } from './errors.js';

const CHANGING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** Any request that changes data must come from our own site. */
export function registerCsrf(app: FastifyInstance, config: Pick<Config, 'appOrigin'>): void {
  app.addHook('onRequest', (req, _reply, done) => {
    if (CHANGING.has(req.method) && req.headers.origin !== config.appOrigin) {
      done(new HttpError(403, 'This request came from another website and was blocked.'));
    } else {
      done();
    }
  });
}
