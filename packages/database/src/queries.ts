import type { Role } from '@relay/shared';
import { and, eq } from 'drizzle-orm';
import type { Executor } from './index.ts';
import { workspaceMembers } from './schema.ts';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The membership lookup behind every authorization decision.
 *
 * It lives here rather than in the API because the WebSocket gateway needs the
 * identical check on connect, and two copies of an authorization query is how
 * they drift apart.
 *
 * Returns null for a syntactically invalid id: Postgres raises a cast error on
 * a malformed uuid, and a bad id cannot name a workspace you belong to anyway.
 */
export async function findMembership(
  db: Executor,
  workspaceId: string,
  userId: string,
): Promise<{ role: Role } | null> {
  if (!UUID_RE.test(workspaceId)) return null;

  const [member] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);

  return member ?? null;
}
