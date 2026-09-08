import {
  auditEvents,
  type Database,
  type Executor,
  workspaceMembers,
  workspaces,
} from '@relay/database';
import { createWorkspaceSchema, slugify, updateWorkspaceSchema } from '@relay/shared';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.ts';
import {
  currentMembership,
  currentUser,
  requireAuth,
  requireMembership,
} from '../plugins/authz.ts';
import { parse } from '../validate.ts';

/**
 * Find a free slug by appending `-2`, `-3`, ... The unique index is still the
 * real guarantee; this only avoids surfacing a conflict for the common case of
 * two workspaces sharing a display name.
 */
async function availableSlug(db: Executor, base: string): Promise<string> {
  const root = base || 'workspace';

  for (let suffix = 1; suffix <= 50; suffix++) {
    const candidate = suffix === 1 ? root : `${root}-${suffix}`;
    const [taken] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.slug, candidate))
      .limit(1);

    if (!taken) return candidate;
  }

  throw ApiError.conflict('Could not derive a unique slug; please supply one', 'slug_exhausted');
}

export async function workspaceRoutes(app: FastifyInstance, opts: { db: Database }) {
  const { db } = opts;

  app.get('/workspaces', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);

    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
        role: workspaceMembers.role,
        createdAt: workspaces.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id))
      .orderBy(workspaces.createdAt);

    return { workspaces: rows };
  });

  app.post('/workspaces', { preHandler: requireAuth }, async (request, reply) => {
    const user = currentUser(request);
    const input = parse(createWorkspaceSchema, request.body);

    const workspace = await db.transaction(async (tx) => {
      const slug = input.slug ?? (await availableSlug(tx, slugify(input.name)));

      const [created] = await tx
        .insert(workspaces)
        .values({ name: input.name, slug, createdBy: user.id })
        .onConflictDoNothing({ target: workspaces.slug })
        .returning();

      if (!created) throw ApiError.conflict('That workspace slug is taken', 'slug_taken');

      // Creating a workspace you cannot administer would be useless, so the
      // owner membership is part of the same transaction, not a follow-up call.
      await tx.insert(workspaceMembers).values({
        workspaceId: created.id,
        userId: user.id,
        role: 'OWNER',
      });

      await tx.insert(auditEvents).values({
        workspaceId: created.id,
        actorId: user.id,
        entityType: 'workspace',
        entityId: created.id,
        eventType: 'workspace.created',
        payload: JSON.stringify({ name: created.name, slug: created.slug }),
      });

      return created;
    });

    return reply.status(201).send({ workspace: { ...workspace, role: 'OWNER' } });
  });

  app.get(
    '/workspaces/:workspaceId',
    { preHandler: [requireAuth, requireMembership(db, 'workspace:read')] },
    async (request) => {
      const { workspaceId, role } = currentMembership(request);

      const [workspace] = await db
        .select()
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .limit(1);

      if (!workspace) throw ApiError.notFound('Workspace not found');

      return { workspace: { ...workspace, role } };
    },
  );

  app.patch(
    '/workspaces/:workspaceId',
    { preHandler: [requireAuth, requireMembership(db, 'workspace:update')] },
    async (request) => {
      const user = currentUser(request);
      const { workspaceId } = currentMembership(request);
      const input = parse(updateWorkspaceSchema, request.body);

      const [updated] = await db
        .update(workspaces)
        .set({ name: input.name, updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId))
        .returning();

      if (!updated) throw ApiError.notFound('Workspace not found');

      await db.insert(auditEvents).values({
        workspaceId,
        actorId: user.id,
        entityType: 'workspace',
        entityId: workspaceId,
        eventType: 'workspace.updated',
        payload: JSON.stringify({ name: input.name }),
      });

      return { workspace: updated };
    },
  );

  app.delete(
    '/workspaces/:workspaceId',
    { preHandler: [requireAuth, requireMembership(db, 'workspace:delete')] },
    async (request, reply) => {
      const { workspaceId } = currentMembership(request);

      // Projects, issues, comments and memberships go with it via ON DELETE
      // CASCADE, so there is no application-level fan-out to keep in sync.
      await db.delete(workspaces).where(eq(workspaces.id, workspaceId));

      return reply.status(204).send();
    },
  );

  app.get(
    '/workspaces/:workspaceId/activity',
    { preHandler: [requireAuth, requireMembership(db, 'workspace:read')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);

      const events = await db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.workspaceId, workspaceId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(100);

      return { events: events.map((e) => ({ ...e, payload: JSON.parse(e.payload) })) };
    },
  );
}
