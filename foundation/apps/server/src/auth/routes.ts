import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { ForgotInput, SignInInput } from '@hf/shared';
import { defineRoute } from '../http/route.js';
import { HttpError, unauthorized } from '../http/errors.js';
import { users, sessions, teams } from '../db/schema/index.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE, createSession, type Actor } from './sessions.js';
import { acceptInvite } from './invites.js';
import { changePassword, requestPasswordReset, resetPassword } from './reset.js';
import type { Config } from '../config.js';
import type { Db } from '../db/client.js';
import { audit, auditableEmail } from '../audit/audit.js';

/** What /api/me says about the signed-in person: the actor plus the name of their team, for the profile page. */
type MeView = Actor & { teamName: string | null };

async function withTeamName(db: Db, who: Actor): Promise<MeView> {
  if (!who.teamId) return { ...who, teamName: null };
  const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, who.teamId)).limit(1);
  return { ...who, teamName: team?.name ?? null };
}

const tooMany = (wait: string): string => `Too many attempts. Please wait ${wait} and try again.`;
const SIGN_IN_WINDOW = '15 minutes';
const FORGOT_WINDOW = '1 hour';
const BAD_SIGN_IN = "That email and password don't match an account.";


const tokenBody = z.string().max(200);
// The length rule is checked by the password rules (plain-English reply, and a weak password does not burn the link), so only a ceiling here.
const passwordBody = z.string().max(200);
const acceptInviteBody = z.strictObject({ token: tokenBody, password: passwordBody });
const resetBody = z.strictObject({ token: tokenBody, password: passwordBody });
const changePasswordBody = z.strictObject({ currentPassword: passwordBody, newPassword: passwordBody });
const FORGOT_REPLY = { message: "If that email has an account, we've sent a link to reset the password." };

export function registerAuthRoutes(app: FastifyInstance, config: Pick<Config, 'cookieSecure' | 'appOrigin'>, now?: () => Date): void {
  // Checked when no usable account exists, so the time taken does not reveal whether an email is registered.
  // Computed now, at registration, so the first unknown-email request is not faster than later ones.
  const dummyHash = hashPassword('not-a-real-password-for-timing-only');
  // Backstop: many attempts from one address across different emails.
  const perAddress = app.createRateLimit({ max: 50, timeWindow: SIGN_IN_WINDOW, keyGenerator: (req) => req.ip });

  // Backstop for reset requests: many addresses from one place.
  const forgotPerAddress = app.createRateLimit({ max: 30, timeWindow: FORGOT_WINDOW, keyGenerator: (req) => req.ip });
  // Links carry 256-bit tokens, so guessing is hopeless; this only caps noise from one address.
  const linkAttempts = { max: 30, timeWindow: '15 minutes', keyGenerator: (req: { ip: string }) => req.ip };

  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' } as const;

  defineRoute(app, {
    method: 'POST',
    url: '/api/auth/sign-in',
    access: { public: 'signing in' },
    schema: { body: SignInInput },
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '15 minutes',
        // The body is only parsed by preHandler, so the key really is address + email.
        hook: 'preHandler',
        keyGenerator: (req: { ip: string; body?: unknown }) => {
          const email = (req.body as { email?: unknown } | undefined)?.email;
          return req.ip + '|' + (typeof email === 'string' ? email.trim().toLowerCase() : '');
        },
      },
    },
    async handler(req, reply, { db }) {
      const { email, password } = req.body;
      const gate = await perAddress(req);
      if (!gate.isAllowed && gate.isExceeded) throw new HttpError(429, tooMany(SIGN_IN_WINDOW));
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      const matches = await verifyPassword(password, user?.passwordHash ?? (await dummyHash));
      if (!user || user.passwordHash === null || user.disabledAt !== null || !matches) {
        // Never the password, only the email that was tried.
        await audit(db, { actor: null, ip: req.ip }, { action: 'auth.sign_in_failed', details: { email: auditableEmail(email) } });
        throw new HttpError(401, BAD_SIGN_IN);
      }
      const meta: { ip?: string; userAgent?: string } = { ip: req.ip };
      const ua = req.headers['user-agent'];
      if (ua) meta.userAgent = ua;
      const who = { id: user.id, email: user.email, name: user.name, role: user.role, teamId: user.teamId };
      // A fresh token on every sign-in; a session presented with this request is ended.
      const { token } = await db.transaction(async (tx) => {
        if (req.sessionId) await tx.delete(sessions).where(eq(sessions.id, req.sessionId));
        const created = await createSession(tx, user.id, meta, now?.());
        await audit(tx, { actor: who, ip: req.ip }, { action: 'auth.sign_in', targetType: 'user', targetId: user.id });
        return created;
      });
      void reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, maxAge: SESSION_ABSOLUTE_MS / 1000 });
      return { user: await withTeamName(db, who) };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/auth/sign-out',
    access: { permission: 'self:manage' },
    async handler(req, reply, { actor, db }) {
      await db.transaction(async (tx) => {
        if (req.sessionId) await tx.delete(sessions).where(eq(sessions.id, req.sessionId));
        await audit(tx, { actor, ip: req.ip }, { action: 'auth.sign_out', ...(actor ? { targetType: 'user', targetId: actor.id } : {}) });
      });
      void reply.clearCookie(SESSION_COOKIE, cookieOpts);
      return undefined;
    },
  });

  defineRoute(app, {
    method: 'GET',
    url: '/api/me',
    access: { permission: 'self:manage' },
    async handler(_req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      let teamName: string | null = null;
      if (actor.teamId) {
        const [team] = await db.select({ name: teams.name }).from(teams).where(eq(teams.id, actor.teamId)).limit(1);
        teamName = team?.name ?? null;
      }
      const user: MeView = { ...actor, teamName };
      return { user };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/auth/accept-invite',
    access: { public: 'accepting an invite' },
    schema: { body: acceptInviteBody },
    config: { rateLimit: linkAttempts },
    async handler(req, reply, { db }) {
      const meta: { ip?: string; userAgent?: string; now?: Date } = { ip: req.ip };
      const ua = req.headers['user-agent'];
      if (ua) meta.userAgent = ua;
      const at = now?.();
      if (at) meta.now = at;
      const { token, user } = await acceptInvite(db, req.body.token, req.body.password, meta);
      // As with sign-in, a session sent with this request is ended.
      if (req.sessionId) await db.delete(sessions).where(eq(sessions.id, req.sessionId));
      void reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, maxAge: SESSION_ABSOLUTE_MS / 1000 });
      return { user: await withTeamName(db, user) };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/auth/forgot-password',
    access: { public: 'asking for a reset link' },
    schema: { body: ForgotInput },
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 hour',
        // The body is only parsed by preHandler, so the key really is address + email.
        hook: 'preHandler',
        keyGenerator: (req: { ip: string; body?: unknown }) => {
          const email = (req.body as { email?: unknown } | undefined)?.email;
          return req.ip + '|' + (typeof email === 'string' ? email.trim().toLowerCase() : '');
        },
      },
    },
    async handler(req, reply, { db }) {
      const gate = await forgotPerAddress(req);
      if (!gate.isAllowed && gate.isExceeded) throw new HttpError(429, tooMany(FORGOT_WINDOW));
      const at = now?.();
      await requestPasswordReset(db, req.body.email, { appOrigin: config.appOrigin, ip: req.ip, ...(at ? { now: at } : {}) });
      return reply.code(202).send(FORGOT_REPLY);
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/auth/reset-password',
    access: { public: 'using a reset link' },
    schema: { body: resetBody },
    config: { rateLimit: linkAttempts },
    async handler(req, _reply, { db }) {
      const at = now?.();
      await resetPassword(db, req.body.token, req.body.password, { ip: req.ip, ...(at ? { now: at } : {}) });
      return undefined;
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/me/password',
    access: { permission: 'self:manage' },
    schema: { body: changePasswordBody },
    config: {
      rateLimit: {
        // A stolen session must not be able to guess the current password at speed.
        max: 10,
        timeWindow: '15 minutes',
        hook: 'preHandler',
        keyGenerator: (req: { ip: string; actor?: { id: string } | null }) => req.actor?.id ?? req.ip,
      },
    },
    async handler(req, _reply, { actor, db }) {
      if (!actor) throw unauthorized();
      const at = now?.();
      await changePassword(db, actor, req.sessionId, req.body, { ip: req.ip, ...(at ? { now: at } : {}) });
      return undefined;
    },
  });
}
