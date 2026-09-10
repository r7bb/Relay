import { comments, type Database, enqueue, issues, publishEvent, users } from '@relay/database';
import { can, createCommentSchema, isUuid } from '@relay/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.ts';
import {
  currentMembership,
  currentUser,
  requireAuth,
  requireMembership,
} from '../plugins/authz.ts';
import { parse } from '../validate.ts';

export async function commentRoutes(app: FastifyInstance, opts: { db: Database }) {
  const { db } = opts;

  app.get(
    '/workspaces/:workspaceId/issues/:issueId/comments',
    { preHandler: [requireAuth, requireMembership(db, 'comment:read')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);
      const { issueId } = request.params as { issueId: string };

      if (!isUuid(issueId)) throw ApiError.notFound('Issue not found');

      const rows = await db
        .select({
          id: comments.id,
          body: comments.body,
          createdAt: comments.createdAt,
          authorId: comments.authorId,
          authorName: users.name,
        })
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(and(eq(comments.issueId, issueId), eq(comments.workspaceId, workspaceId)))
        .orderBy(asc(comments.createdAt));

      return { comments: rows };
    },
  );

  app.post(
    '/workspaces/:workspaceId/issues/:issueId/comments',
    { preHandler: [requireAuth, requireMembership(db, 'comment:create')] },
    async (request, reply) => {
      const user = currentUser(request);
      const { workspaceId } = currentMembership(request);
      const { issueId } = request.params as { issueId: string };
      const input = parse(createCommentSchema, request.body);

      if (!isUuid(issueId)) throw ApiError.notFound('Issue not found');

      // Confirm the issue is in this workspace before writing; the foreign key
      // alone would happily accept an issue belonging to another tenant.
      const [issue] = await db
        .select({ id: issues.id })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.workspaceId, workspaceId)))
        .limit(1);

      if (!issue) throw ApiError.notFound('Issue not found');

      // The insert and the notification job commit together: no window where
      // the comment exists but nobody is told, and no job for a comment that
      // rolled back. This is the reason the queue lives in Postgres.
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(comments)
          .values({ workspaceId, issueId, authorId: user.id, body: input.body })
          .returning();

        await enqueue(tx, 'notify.mentions', { commentId: row!.id });
        return row;
      });

      await publishEvent(db, {
        type: 'comment.created',
        workspaceId,
        issueId,
        actorId: user.id,
      });

      return reply.status(201).send({
        comment: { ...created!, authorName: user.name },
      });
    },
  );

  /**
   * Deleting your own comment and deleting someone else's are separate
   * permissions, so the check depends on the row -- guests and members can
   * retract what they wrote, only admins can moderate others.
   */
  app.delete(
    '/workspaces/:workspaceId/comments/:commentId',
    { preHandler: [requireAuth, requireMembership(db, 'comment:read')] },
    async (request, reply) => {
      const user = currentUser(request);
      const { workspaceId, role } = currentMembership(request);
      const { commentId } = request.params as { commentId: string };

      if (!isUuid(commentId)) throw ApiError.notFound('Comment not found');

      const [comment] = await db
        .select({ id: comments.id, authorId: comments.authorId })
        .from(comments)
        .where(and(eq(comments.id, commentId), eq(comments.workspaceId, workspaceId)))
        .limit(1);

      if (!comment) throw ApiError.notFound('Comment not found');

      const isAuthor = comment.authorId === user.id;
      const allowed = isAuthor ? can(role, 'comment:delete_own') : can(role, 'comment:delete_any');

      if (!allowed) throw ApiError.forbidden();

      await db
        .delete(comments)
        .where(and(eq(comments.id, commentId), eq(comments.workspaceId, workspaceId)));

      return reply.status(204).send();
    },
  );
}
