import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CreateTeamInput, UpdateMeInput, UpdateUserInput } from '@hf/shared';
import { defineRoute } from '../http/route.js';
import { badRequest, conflict, notFound, unauthorized } from '../http/errors.js';
import { revokeSessions } from '../auth/sessions.js';
import { teams, users } from '../db/schema/index.js';
import { getUser, listTeams, listUsers } from './repo.js';

const IdParams = z.strictObject({ id: z.uuid() });

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

export function registerUserRoutes(app: FastifyInstance): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/users',
    access: { permission: 'users:list' },
    async handler(_req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      return { users: await listUsers(db, actor) };
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/users/:id',
    access: { permission: 'users:list' },
    schema: { params: IdParams },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const user = await getUser(db, actor, req.params.id);
      if (!user) throw notFound();
      return { user };
    },
  });

  defineRoute(app, {
    method: 'PATCH',
    url: '/api/users/:id',
    access: { permission: 'users:manage' },
    schema: { params: IdParams, body: UpdateUserInput },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const body = req.body;
      const target = await getUser(db, actor, req.params.id);
      if (!target) throw notFound();

      if (target.id === actor.id && (body.role !== undefined || body.disabled !== undefined)) {
        throw conflict("You can't change your own role or disable your own account. Ask another admin.");
      }
      const role = body.role ?? target.role;
      const teamId = body.teamId === undefined ? target.teamId : body.teamId;
      if ((role === 'manager' || role === 'member') && teamId === null) {
        throw badRequest('Managers and members must belong to a team.');
      }
      if (body.teamId) {
        const [team] = await db.select({ id: teams.id }).from(teams).where(eq(teams.id, body.teamId));
        if (!team) throw badRequest("That team doesn't exist.");
      }

      await db.transaction(async (tx) => {
        const set: Partial<typeof users.$inferInsert> = {};
        if (body.name !== undefined) set.name = body.name;
        if (body.role !== undefined) set.role = body.role;
        if (body.teamId !== undefined) set.teamId = body.teamId;
        if (body.disabled === true && !target.disabled) set.disabledAt = new Date();
        if (body.disabled === false) set.disabledAt = null;
        if (Object.keys(set).length > 0) {
          set.updatedAt = new Date();
          await tx.update(users).set(set).where(eq(users.id, target.id));
        }
        if (body.disabled === true) await revokeSessions(tx, target.id);
      });
      const user = await getUser(db, actor, target.id);
      if (!user) throw notFound();
      return { user };
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/teams',
    access: { permission: 'teams:list' },
    async handler(_req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      return { teams: await listTeams(db, actor) };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/teams',
    access: { permission: 'teams:manage' },
    schema: { body: CreateTeamInput },
    async handler(req, reply, { db }) {
      try {
        const [team] = await db.insert(teams).values({ name: req.body.name }).returning({ id: teams.id, name: teams.name });
        return await reply.code(201).send({ team });
      } catch (e) {
        if (isUniqueViolation(e)) throw conflict(`There is already a team called "${req.body.name}".`);
        throw e;
      }
    },
  });

  defineRoute(app, {
    method: 'PATCH',
    url: '/api/me',
    access: { permission: 'self:manage' },
    schema: { body: UpdateMeInput },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      await db.update(users).set({ name: req.body.name, updatedAt: new Date() }).where(eq(users.id, actor.id));
      const user = await getUser(db, actor, actor.id);
      if (!user) throw notFound();
      return { user };
    },
  });
}
