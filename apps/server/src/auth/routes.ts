import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import { HttpError } from '../http/errors.js';
import { users, sessions } from '../db/schema/index.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE, createSession } from './sessions.js';
import type { Config } from '../config.js';
import { audit } from '../audit/audit.js';

const TOO_MANY = 'Too many attempts. Please wait 15 minutes and try again.';
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A password pasted into the email box must not reach the audit log, so only email-shaped input is kept. */
const auditableEmail = (v: string): string => (v.length <= 254 && EMAIL_SHAPE.test(v) ? v : '[not an email address]');
const BAD_SIGN_IN = "That email and password don't match an account.";


const signInBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().max(200),
});

export function registerAuthRoutes(app: FastifyInstance, config: Pick<Config, 'cookieSecure'>, now?: () => Date): void {
  // Checked when no usable account exists, so the time taken does not reveal whether an email is registered.
  // Computed now, at registration, so the first unknown-email request is not faster than later ones.
  const dummyHash = hashPassword('not-a-real-password-for-timing-only');
  // Backstop: many attempts from one address across different emails.
  const perAddress = app.createRateLimit({ max: 50, timeWindow: '15 minutes', keyGenerator: (req) => req.ip });

  const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, path: '/' } as const;

  defineRoute(app, {
    method: 'POST',
    url: '/api/auth/sign-in',
    access: { public: 'signing in' },
    schema: { body: signInBody },
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
      if (!gate.isAllowed && gate.isExceeded) throw new HttpError(429, TOO_MANY);
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
      return { user: who };
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
    handler(_req, _reply, { actor }) {
      return Promise.resolve({ user: actor });
    },
  });
}
