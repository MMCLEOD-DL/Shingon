import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CreateTeamInput, InviteInput, UpdateMeInput, UpdateUserInput } from '@hf/shared';
import { defineRoute } from '../http/route.js';
import { conflict, notFound, unauthorized } from '../http/errors.js';
import { revokeSessions } from '../auth/sessions.js';
import { teams, users } from '../db/schema/index.js';
import { audit } from '../audit/audit.js';
import { createInvite, resendInvite } from '../auth/invites.js';
import type { Config } from '../config.js';
import { getUser, listTeams, listUsers } from './repo.js';
import { checkTeamRule } from './teamRule.js';

const IdParams = z.strictObject({ id: z.uuid() });
// The lists take no query parameters yet; anything sent is refused rather than ignored.
const NoQuery = z.strictObject({});

const isUniqueViolation = (e: unknown): boolean => {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  return err?.code === '23505' || err?.cause?.code === '23505';
};

export function registerUserRoutes(app: FastifyInstance, config: Pick<Config, 'appOrigin'>, now: () => Date = () => new Date()): void {
  defineRoute(app, {
    method: 'GET',
    url: '/api/users',
    access: { permission: 'users:list' },
    schema: { query: NoQuery },
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
    method: 'POST',
    url: '/api/users/invite',
    access: { permission: 'users:manage' },
    schema: { body: InviteInput },
    async handler(req, reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const { userId } = await db.transaction((tx) => createInvite(tx, actor, req.body, { appOrigin: config.appOrigin, now: now(), ip: req.ip }));
      const user = await getUser(db, actor, userId);
      if (!user) throw notFound();
      return reply.code(201).send({ user });
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/users/:id/resend-invite',
    access: { permission: 'users:manage' },
    schema: { params: IdParams },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const target = await getUser(db, actor, req.params.id);
      if (!target) throw notFound();
      if (target.activated) throw conflict('This person has already set their password.');
      if (target.disabled) throw conflict('This account is switched off. Switch it back on before sending a new invite.');
      await db.transaction((tx) => resendInvite(tx, actor, target, { appOrigin: config.appOrigin, now: now(), ip: req.ip }));
      return undefined;
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
      if (body.role !== undefined || body.teamId !== undefined) await checkTeamRule(db, role, teamId);

      await db.transaction(async (tx) => {
        const set: Partial<typeof users.$inferInsert> = {};
        if (body.name !== undefined) set.name = body.name;
        if (body.role !== undefined) set.role = body.role;
        if (body.teamId !== undefined) set.teamId = body.teamId;
        if (body.disabled === true && !target.disabled) set.disabledAt = now();
        if (body.disabled === false) set.disabledAt = null;
        if (Object.keys(set).length > 0) {
          set.updatedAt = now();
          await tx.update(users).set(set).where(eq(users.id, target.id));
        }
        if (body.disabled === true) await revokeSessions(tx, target.id);

        const changed: Record<string, [unknown, unknown]> = {};
        if (body.name !== undefined && body.name !== target.name) changed.name = [target.name, body.name];
        if (body.role !== undefined && body.role !== target.role) changed.role = [target.role, body.role];
        if (body.teamId !== undefined && body.teamId !== target.teamId) changed.teamId = [target.teamId, body.teamId];
        const ctx = { actor, ip: req.ip };
        const ref = { targetType: 'user', targetId: target.id };
        if (Object.keys(changed).length > 0) await audit(tx, ctx, { action: 'user.updated', ...ref, details: { changed } });
        if (body.disabled === true && !target.disabled) await audit(tx, ctx, { action: 'user.disabled', ...ref });
        if (body.disabled === false && target.disabled) await audit(tx, ctx, { action: 'user.enabled', ...ref });
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
    schema: { query: NoQuery },
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
    async handler(req, reply, { actor, db }) {
      try {
        const team = await db.transaction(async (tx) => {
          const [created] = await tx.insert(teams).values({ name: req.body.name }).returning({ id: teams.id, name: teams.name });
          if (!created) throw new Error('Team insert returned no row');
          await audit(tx, { actor, ip: req.ip }, { action: 'team.created', targetType: 'team', targetId: created.id, details: { name: created.name } });
          return created;
        });
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
      await db.transaction(async (tx) => {
        await tx.update(users).set({ name: req.body.name, updatedAt: now() }).where(eq(users.id, actor.id));
        if (req.body.name !== actor.name) {
          await audit(tx, { actor, ip: req.ip }, {
            action: 'user.updated', targetType: 'user', targetId: actor.id,
            details: { changed: { name: [actor.name, req.body.name] } },
          });
        }
      });
      const user = await getUser(db, actor, actor.id);
      if (!user) throw notFound();
      return { user };
    },
  });
}
