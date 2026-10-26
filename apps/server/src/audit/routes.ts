import type { FastifyInstance } from 'fastify';
import { and, desc, eq, lt } from 'drizzle-orm';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import { auditLog } from '../db/schema/index.js';
import { AUDIT_ACTIONS } from './audit.js';

export interface AuditView {
  id: number;
  at: string;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  ip: string | null;
}

const AuditQuery = z.strictObject({
  action: z.enum(AUDIT_ACTIONS).optional(),
  actorId: z.uuid().optional(),
  before: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function registerAuditRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/audit',
    access: { permission: 'audit:read' },
    schema: { query: AuditQuery },
    async handler(req, _reply, { db }) {
      const q = req.query;
      const where = and(
        q.action ? eq(auditLog.action, q.action) : undefined,
        q.actorId ? eq(auditLog.actorId, q.actorId) : undefined,
        q.before !== undefined ? lt(auditLog.id, q.before) : undefined,
      );
      const rows = await db.select().from(auditLog).where(where).orderBy(desc(auditLog.id)).limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const entries: AuditView[] = page.map((r) => ({
        id: r.id,
        at: r.at.toISOString(),
        actorLabel: r.actorLabel,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        details: r.details,
        ip: r.ip,
      }));
      return { entries, nextBefore: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
    },
  });
}
