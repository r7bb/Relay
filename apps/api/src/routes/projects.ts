import {
  auditEvents,
  type Database,
  type Executor,
  issues,
  projects,
  publishEvent,
} from '@relay/database';
import { createProjectSchema, deriveProjectKey, updateProjectSchema } from '@relay/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.ts';
import {
  currentMembership,
  currentUser,
  requireAuth,
  requireMembership,
} from '../plugins/authz.ts';
import { parse } from '../validate.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Load a project, scoped to the workspace from the path.
 *
 * The `workspaceId` predicate is the tenant boundary: without it, a member of
 * workspace A could read a project in workspace B by pasting its id into a URL
 * whose `:workspaceId` they legitimately belong to.
 */
export async function loadProject(db: Executor, workspaceId: string, projectId: string) {
  if (!UUID_RE.test(projectId)) throw ApiError.notFound('Project not found');

  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1);

  if (!project) throw ApiError.notFound('Project not found');
  return project;
}

async function availableKey(db: Executor, workspaceId: string, base: string): Promise<string> {
  for (let suffix = 1; suffix <= 50; suffix++) {
    const candidate = suffix === 1 ? base : `${base}${suffix}`;
    const [taken] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, workspaceId), eq(projects.key, candidate)))
      .limit(1);

    if (!taken) return candidate;
  }

  throw ApiError.conflict(
    'Could not derive a unique project key; please supply one',
    'key_exhausted',
  );
}

export async function projectRoutes(app: FastifyInstance, opts: { db: Database }) {
  const { db } = opts;

  app.get(
    '/workspaces/:workspaceId/projects',
    { preHandler: [requireAuth, requireMembership(db, 'project:read')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);

      // Open-issue counts come from one grouped subquery rather than a query
      // per project, so the list stays a single round trip as projects grow.
      const openCounts = db
        .select({ projectId: issues.projectId, open: count().as('open') })
        .from(issues)
        .where(
          and(
            eq(issues.workspaceId, workspaceId),
            sql`${issues.status} not in ('DONE', 'CANCELED')`,
          ),
        )
        .groupBy(issues.projectId)
        .as('open_counts');

      const rows = await db
        .select({
          id: projects.id,
          key: projects.key,
          name: projects.name,
          description: projects.description,
          archived: projects.archived,
          createdAt: projects.createdAt,
          openIssues: sql<number>`coalesce(${openCounts.open}, 0)::int`,
        })
        .from(projects)
        .leftJoin(openCounts, eq(openCounts.projectId, projects.id))
        .where(eq(projects.workspaceId, workspaceId))
        .orderBy(projects.createdAt);

      return { projects: rows };
    },
  );

  app.post(
    '/workspaces/:workspaceId/projects',
    { preHandler: [requireAuth, requireMembership(db, 'project:create')] },
    async (request, reply) => {
      const user = currentUser(request);
      const { workspaceId } = currentMembership(request);
      const input = parse(createProjectSchema, request.body);

      const project = await db.transaction(async (tx) => {
        const key =
          input.key ?? (await availableKey(tx, workspaceId, deriveProjectKey(input.name)));

        const [created] = await tx
          .insert(projects)
          .values({
            workspaceId,
            key,
            name: input.name,
            description: input.description ?? null,
            createdBy: user.id,
          })
          .onConflictDoNothing({ target: [projects.workspaceId, projects.key] })
          .returning();

        if (!created) {
          throw ApiError.conflict(`Project key "${key}" is already used here`, 'key_taken');
        }

        await tx.insert(auditEvents).values({
          workspaceId,
          actorId: user.id,
          entityType: 'project',
          entityId: created.id,
          eventType: 'project.created',
          payload: JSON.stringify({ key: created.key, name: created.name }),
        });

        return created;
      });

      await publishEvent(db, {
        type: 'project.created',
        workspaceId,
        projectId: project.id,
        actorId: user.id,
      });

      return reply.status(201).send({ project });
    },
  );

  app.get(
    '/workspaces/:workspaceId/projects/:projectId',
    { preHandler: [requireAuth, requireMembership(db, 'project:read')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);
      const { projectId } = request.params as { projectId: string };

      return { project: await loadProject(db, workspaceId, projectId) };
    },
  );

  app.patch(
    '/workspaces/:workspaceId/projects/:projectId',
    { preHandler: [requireAuth, requireMembership(db, 'project:update')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);
      const { projectId } = request.params as { projectId: string };
      const input = parse(updateProjectSchema, request.body);

      await loadProject(db, workspaceId, projectId);

      const [updated] = await db
        .update(projects)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
        .returning();

      return { project: updated };
    },
  );

  app.delete(
    '/workspaces/:workspaceId/projects/:projectId',
    { preHandler: [requireAuth, requireMembership(db, 'project:delete')] },
    async (request, reply) => {
      const user = currentUser(request);
      const { workspaceId } = currentMembership(request);
      const { projectId } = request.params as { projectId: string };

      const project = await loadProject(db, workspaceId, projectId);

      await db
        .delete(projects)
        .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)));

      await db.insert(auditEvents).values({
        workspaceId,
        actorId: user.id,
        entityType: 'project',
        entityId: projectId,
        eventType: 'project.deleted',
        payload: JSON.stringify({ key: project.key, name: project.name }),
      });

      await publishEvent(db, {
        type: 'project.deleted',
        workspaceId,
        projectId,
        actorId: user.id,
      });

      return reply.status(204).send();
    },
  );
}
