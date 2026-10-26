import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defineRoute } from '../http/route.js';
import { HttpError } from '../http/errors.js';
import { users, sessions } from '../db/schema/index.js';
import { hashPassword, verifyPassword } from './password.js';
import { SESSION_ABSOLUTE_MS, SESSION_COOKIE, createSession } from './sessions.js';
import type { Config } from '../config.js';

const BAD_SIGN_IN = "That email and password don't match an account.";

// Checked when no usable account exists, so the time taken does not reveal whether an email is registered.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password-for-timing-only'));

const signInBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().max(200),
});

export function registerAuthRoutes(app: FastifyInstance, config: Pick<Config, 'cookieSecure'>): void {
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
      const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
      const matches = await verifyPassword(password, user?.passwordHash ?? (await getDummyHash()));
      if (!user || user.passwordHash === null || user.disabledAt !== null || !matches) {
        throw new HttpError(401, BAD_SIGN_IN);
      }
      // A fresh token on every sign-in; a session presented with this request is ended.
      if (req.sessionId) await db.delete(sessions).where(eq(sessions.id, req.sessionId));
      const meta: { ip?: string; userAgent?: string } = { ip: req.ip };
      const ua = req.headers['user-agent'];
      if (ua) meta.userAgent = ua;
      const { token } = await createSession(db, user.id, meta);
      void reply.setCookie(SESSION_COOKIE, token, { ...cookieOpts, maxAge: SESSION_ABSOLUTE_MS / 1000 });
      return { user: { id: user.id, email: user.email, name: user.name, role: user.role, teamId: user.teamId } };
    },
  });

  defineRoute(app, {
    method: 'POST',
    url: '/api/auth/sign-out',
    access: { permission: 'self:manage' },
    async handler(req, reply, { db }) {
      if (req.sessionId) await db.delete(sessions).where(eq(sessions.id, req.sessionId));
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
