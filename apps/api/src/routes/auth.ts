import { randomBytes } from 'node:crypto';
import {
  createSession,
  hashPassword,
  revokeSession,
  SESSION_COOKIE,
  verifyPassword,
} from '@relay/auth';
import { type Database, users } from '@relay/database';
import { loginSchema, registerSchema } from '@relay/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Env } from '../env.ts';
import { ApiError } from '../errors.ts';
import { currentUser, requireAuth } from '../plugins/authz.ts';
import { parse } from '../validate.ts';

export async function authRoutes(app: FastifyInstance, opts: { db: Database; env: Env }) {
  const { db, env } = opts;

  /**
   * Verified when no user matches, so a login attempt costs the same whether or
   * not the address is registered -- otherwise response timing reveals which
   * emails have accounts. Derived from `hashPassword` rather than hardcoded, so
   * it cannot drift out of sync with the real cost parameters.
   */
  const dummyDigest = await hashPassword(randomBytes(32).toString('hex'));

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: env.COOKIE_SECURE,
    path: '/',
  };

  app.post('/auth/register', async (request, reply) => {
    const input = parse(registerSchema, request.body);
    const passwordHash = await hashPassword(input.password);

    const [user] = await db
      .insert(users)
      .values({ email: input.email, name: input.name, passwordHash })
      // Losing the race on the unique index returns no row, which we translate
      // into the same 409 as the checked case. Doing this instead of a
      // SELECT-then-INSERT removes the race entirely.
      .onConflictDoNothing({ target: users.email })
      .returning({ id: users.id, email: users.email, name: users.name });

    if (!user) throw ApiError.conflict('An account with that email already exists', 'email_taken');

    const { token, expiresAt } = await createSession(db, user.id, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });

    return reply.status(201).send({ user });
  });

  app.post('/auth/login', async (request, reply) => {
    const input = parse(loginSchema, request.body);

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1);

    const ok = await verifyPassword(user?.passwordHash ?? dummyDigest, input.password);

    // One message for both failure modes: a distinct "no such account" reply
    // would let anyone test whether an address is registered.
    if (!ok || !user) throw ApiError.unauthorized('Invalid email or password');

    const { token, expiresAt } = await createSession(db, user.id, request.headers['user-agent']);
    reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, expires: expiresAt });

    return { user: { id: user.id, email: user.email, name: user.name } };
  });

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE];
    if (token) await revokeSession(db, token);

    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    return { ok: true };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (request) => ({
    user: currentUser(request),
  }));
}
