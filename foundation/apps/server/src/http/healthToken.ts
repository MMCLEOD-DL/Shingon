import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { Config } from '../config.js';

const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

/**
 * True only when HEALTH_TOKEN is set (and not empty) and the request's x-health-token header equals it.
 * Both sides are hashed first, so the comparison is over equal-length buffers and takes the same time whatever is sent.
 */
export function hasHealthToken(req: Pick<FastifyRequest, 'headers'>, cfg: Pick<Config, 'healthToken'>): boolean {
  const wanted = cfg.healthToken;
  if (wanted === undefined || wanted === '') return false;
  const sent = req.headers['x-health-token'];
  if (typeof sent !== 'string' || sent === '') return false;
  return timingSafeEqual(digest(sent), digest(wanted));
}
