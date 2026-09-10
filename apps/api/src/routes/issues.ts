import {
  auditEvents,
  type Database,
  decodeCursor,
  type Executor,
  encodeCursor,
  issues,
  projects,
  publishEvent,
  users,
  workspaceMembers,
} from '@relay/database';
import { createIssueSchema, listIssuesQuerySchema, updateIssueSchema } from '@relay/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.ts';
import {
  currentMembership,
  currentUser,
  requireAuth,
  requireMembership,
} from '../plugins/authz.ts';
import { withIdempotency } from '../plugins/idempotency.ts';
import { parse } from '../validate.ts';
import { loadProject } from './projects.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tenant-scoped issue lookup. See the note on `loadProject`. */
async function loadIssue(db: Executor, workspaceId: string, issueId: string) {
  if (!UUID_RE.test(issueId)) throw ApiError.notFound('Issue not found');

  const [issue] = await db
    .select()
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
    .limit(1);

  if (!issue) throw ApiError.notFound('Issue not found');
  return issue;
}

/**
 * An assignee must already belong to the workspace. Skipping this would let a
 * caller probe for valid user ids and attach outsiders to internal work.
 */
async function assertAssignable(db: Executor, workspaceId: string, assigneeId: string) {
  const [member] = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, assigneeId)),
    )
    .limit(1);

  if (!member)
    throw ApiError.badRequest('Assignee is not a member of this workspace', 'bad_assignee');
}

export async function issueRoutes(app: FastifyInstance, opts: { db: Database }) {
  const { db } = opts;

  app.get(
    '/workspaces/:workspaceId/projects/:projectId/issues',
    { preHandler: [requireAuth, requireMembership(db, 'issue:read')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);
      const { projectId } = request.params as { projectId: string };
      const query = parse(listIssuesQuerySchema, request.query);

      const project = await loadProject(db, workspaceId, projectId);

      const filters = [eq(issues.projectId, projectId), eq(issues.workspaceId, workspaceId)];
      if (query.status) filters.push(eq(issues.status, query.status));
      if (query.assigneeId) filters.push(eq(issues.assigneeId, query.assigneeId));

      /*
       * Keyset paging: take rows strictly "after" the cursor in the sort
       * order, rather than skipping a count. `(created_at, id) < (...)` is a
       * row comparison, which Postgres can satisfy straight from the
       * composite index -- and `id` is the tiebreaker, because two issues
       * created in the same millisecond would otherwise page unstably.
       */
      const cursorId = decodeCursor(query.cursor);
      if (cursorId) {
        // The sort key is read back from the row rather than carried in the
        // cursor, so no timestamp precision is lost in transit.
        filters.push(
          sql`(${issues.createdAt}, ${issues.id}) < (
            select created_at, id from issues where id = ${cursorId}::uuid
          )`,
        );
      }

      const rows = await db
        .select({
          id: issues.id,
          // The offline store keys rows by project, so the client needs this
          // even though it is implied by the request path.
          projectId: issues.projectId,
          number: issues.number,
          title: issues.title,
          status: issues.status,
          priority: issues.priority,
          assigneeId: issues.assigneeId,
          assigneeName: users.name,
          createdAt: issues.createdAt,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .leftJoin(users, eq(users.id, issues.assigneeId))
        .where(and(...filters))
        .orderBy(desc(issues.createdAt), desc(issues.id))
        .limit(query.limit);

      const last = rows.at(-1);

      return {
        issues: rows.map((r) => ({ ...r, key: `${project.key}-${r.number}` })),
        // A full page implies there may be more; a short page is the end.
        nextCursor: rows.length === query.limit && last ? encodeCursor(last.id) : null,
      };
    },
  );

  app.post(
    '/workspaces/:workspaceId/projects/:projectId/issues',
    { preHandler: [requireAuth, requireMembership(db, 'issue:create')] },
    async (request, reply) => {
      const user = currentUser(request);
      const { workspaceId } = currentMembership(request);
      const { projectId } = request.params as { projectId: string };
      const input = parse(createIssueSchema, request.body);

      await loadProject(db, workspaceId, projectId);
      if (input.assigneeId) await assertAssignable(db, workspaceId, input.assigneeId);

      return withIdempotency(db, request, reply, 201, async () => {
        const issue = await db.transaction(async (tx) => {
          /*
           * Reserve the next issue number by incrementing the counter in place.
           * `UPDATE ... RETURNING` takes a row-level lock, so concurrent creates
           * in the same project queue behind each other and each gets a distinct
           * number. Reading the max issue number and adding one would race.
           */
          const [bumped] = await tx
            .update(projects)
            .set({ issueCounter: sql`${projects.issueCounter} + 1` })
            .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
            .returning({ number: projects.issueCounter, key: projects.key });

          if (!bumped) throw ApiError.notFound('Project not found');

          const [created] = await tx
            .insert(issues)
            .values({
              // Falls back to the database default when the client did not
              // choose one.
              ...(input.id ? { id: input.id } : {}),
              workspaceId,
              projectId,
              number: bumped.number,
              title: input.title,
              description: input.description ?? null,
              status: input.status,
              priority: input.priority,
              assigneeId: input.assigneeId ?? null,
              createdBy: user.id,
            })
            .returning();

          await tx.insert(auditEvents).values({
            workspaceId,
            actorId: user.id,
            entityType: 'issue',
            entityId: created!.id,
            eventType: 'issue.created',
            payload: JSON.stringify({
              key: `${bumped.key}-${bumped.number}`,
              title: created!.title,
            }),
          });

          return { ...created!, key: `${bumped.key}-${bumped.number}` };
        });

        await publishEvent(db, {
          type: 'issue.created',
          workspaceId,
          projectId,
          issueId: issue.id,
          actorId: user.id,
        });

        return { issue };
      });
    },
  );

  app.get(
    '/workspaces/:workspaceId/issues/:issueId',
    { preHandler: [requireAuth, requireMembership(db, 'issue:read')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);
      const { issueId } = request.params as { issueId: string };

      const issue = await loadIssue(db, workspaceId, issueId);
      const project = await loadProject(db, workspaceId, issue.projectId);

      return { issue: { ...issue, key: `${project.key}-${issue.number}` } };
    },
  );

  app.patch(
    '/workspaces/:workspaceId/issues/:issueId',
    { preHandler: [requireAuth, requireMembership(db, 'issue:update')] },
    async (request) => {
      const user = currentUser(request);
      const { workspaceId } = currentMembership(request);
      const { issueId } = request.params as { issueId: string };
      const input = parse(updateIssueSchema, request.body);

      const before = await loadIssue(db, workspaceId, issueId);

      if (input.assigneeId) await assertAssignable(db, workspaceId, input.assigneeId);

      const [updated] = await db
        .update(issues)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
        .returning();

      // Status is the field the activity feed cares about; recording every
      // text edit would drown it.
      if (input.status && input.status !== before.status) {
        await db.insert(auditEvents).values({
          workspaceId,
          actorId: user.id,
          entityType: 'issue',
          entityId: issueId,
          eventType: 'issue.status_changed',
          payload: JSON.stringify({ from: before.status, to: input.status }),
        });
      }

      await publishEvent(db, {
        type: 'issue.updated',
        workspaceId,
        projectId: before.projectId,
        issueId: issueId,
        actorId: user.id,
      });

      return { issue: updated };
    },
  );

  app.delete(
    '/workspaces/:workspaceId/issues/:issueId',
    { preHandler: [requireAuth, requireMembership(db, 'issue:delete')] },
    async (request, reply) => {
      const { workspaceId } = currentMembership(request);
      const { issueId } = request.params as { issueId: string };

      const issue = await loadIssue(db, workspaceId, issueId);

      await db
        .delete(issues)
        .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)));

      await publishEvent(db, {
        type: 'issue.deleted',
        workspaceId,
        projectId: issue.projectId,
        issueId,
        actorId: currentUser(request).id,
      });

      return reply.status(204).send();
    },
  );
}
