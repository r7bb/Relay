import { type Database, searchWorkspace } from '@relay/database';
import type { FastifyInstance } from 'fastify';
import type { RateLimits } from '../app.ts';
import { currentMembership, requireAuth, requireMembership } from '../plugins/authz.ts';
import { rateLimit } from '../plugins/rate-limit.ts';

/**
 * Search within one workspace.
 *
 * Scoped by the membership guard like everything else, so a query can only
 * ever reach rows the caller is already entitled to read -- the search index
 * is not a side door around authorization.
 */
export async function searchRoutes(
  app: FastifyInstance,
  opts: { db: Database; limits: RateLimits },
) {
  const { db, limits } = opts;

  app.get(
    '/workspaces/:workspaceId/search',
    {
      preHandler: [
        requireAuth,
        requireMembership(db, 'issue:read'),
        // Full-text queries are the most expensive read here, so they get a
        // tighter budget than ordinary endpoints.
        rateLimit({ name: 'search', limit: limits.searchPerMinute, windowMs: 60_000 }),
      ],
    },
    async (request) => {
      const { workspaceId } = currentMembership(request);
      const { q } = request.query as { q?: string };

      const results = await searchWorkspace(db, workspaceId, (q ?? '').slice(0, 200));

      return { query: q ?? '', results };
    },
  );
}
