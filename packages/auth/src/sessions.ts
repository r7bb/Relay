import { type Executor, sessions, users } from '@relay/database';
import { and, eq, gt, lt } from 'drizzle-orm';
import { generateSessionToken, hashSessionToken, sessionExpiry } from './tokens.ts';

export type AuthenticatedUser = {
  id: string;
  email: string;
  name: string;
};

/** Only refresh `last_used_at` once an hour, to keep reads from becoming writes. */
const LAST_USED_REFRESH_MS = 60 * 60 * 1000;

export async function createSession(
  db: Executor,
  userId: string,
  userAgent: string | undefined,
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = sessionExpiry();

  await db.insert(sessions).values({
    userId,
    tokenHash: hashSessionToken(token),
    expiresAt,
    userAgent: userAgent?.slice(0, 500) ?? null,
  });

  return { token, expiresAt };
}

export async function resolveSession(
  db: Executor,
  token: string,
): Promise<AuthenticatedUser | null> {
  const tokenHash = hashSessionToken(token);

  const [row] = await db
    .select({
      sessionId: sessions.id,
      lastUsedAt: sessions.lastUsedAt,
      id: users.id,
      email: users.email,
      name: users.name,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    // Expiry is enforced in the query rather than in JS so an expired session
    // can never be treated as valid by a caller that forgets to check.
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1);

  if (!row) return null;

  if (Date.now() - row.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
    await db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }

  return { id: row.id, email: row.email, name: row.name };
}

export async function revokeSession(db: Executor, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
}

/** Invalidate every session for a user, e.g. after a password change. */
export async function revokeAllSessions(db: Executor, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export async function deleteExpiredSessions(db: Executor): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
