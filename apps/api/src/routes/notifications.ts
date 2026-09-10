import { type Database, notifications, users } from '@relay/database';
import { isUuid } from '@relay/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.ts';
import { currentUser, requireAuth } from '../plugins/authz.ts';

/**
 * The signed-in user's inbox.
 *
 * These routes are scoped by recipient rather than by workspace, because an
 * inbox spans every workspace you belong to. That makes `userId` the tenant
 * boundary here: every query filters on it, and there is no path that takes a
 * notification id without also constraining the owner.
 */
export async function notificationRoutes(app: FastifyInstance, opts: { db: Database }) {
  const { db } = opts;

  app.get('/notifications', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const { unread } = request.query as { unread?: string };

    const filters = [eq(notifications.userId, user.id)];
    if (unread === '1' || unread === 'true') filters.push(isNull(notifications.readAt));

    const rows = await db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        workspaceId: notifications.workspaceId,
        entityType: notifications.entityType,
        entityId: notifications.entityId,
        payload: notifications.payload,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
        actorId: notifications.actorId,
        actorName: users.name,
      })
      .from(notifications)
      .leftJoin(users, eq(users.id, notifications.actorId))
      .where(and(...filters))
      .orderBy(desc(notifications.createdAt))
      .limit(100);

    const items = rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));

    return {
      notifications: items,
      unreadCount: items.filter((item) => item.readAt === null).length,
    };
  });

  app.post('/notifications/:notificationId/read', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);
    const { notificationId } = request.params as { notificationId: string };

    if (!isUuid(notificationId)) throw ApiError.notFound('Notification not found');

    const [updated] = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(
        // Owner is part of the predicate, not a separate check: there is no
        // way to reach someone else's notification even with its id.
        and(eq(notifications.id, notificationId), eq(notifications.userId, user.id)),
      )
      .returning({ id: notifications.id, readAt: notifications.readAt });

    if (!updated) throw ApiError.notFound('Notification not found');

    return { notification: updated };
  });

  app.delete(
    '/notifications/:notificationId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const user = currentUser(request);
      const { notificationId } = request.params as { notificationId: string };

      if (!isUuid(notificationId)) throw ApiError.notFound('Notification not found');

      /*
       * Dismissing is a real delete rather than a `dismissedAt` flag.
       *
       * The dedupe key is what stops the worker re-sending the same nudge, and
       * it is enforced by a unique index on `(user_id, dedupe_key)`. Keeping
       * dismissed rows would mean that index also permanently suppresses the
       * notification -- dismiss a weekly nudge once and it never returns.
       * Deleting the row frees the key, so next week's scan can raise it again.
       */
      const [deleted] = await db
        .delete(notifications)
        .where(and(eq(notifications.id, notificationId), eq(notifications.userId, user.id)))
        .returning({ id: notifications.id });

      if (!deleted) throw ApiError.notFound('Notification not found');

      return reply.status(204).send();
    },
  );

  app.post('/notifications/read-all', { preHandler: requireAuth }, async (request) => {
    const user = currentUser(request);

    const updated = await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(eq(notifications.userId, user.id), isNull(notifications.readAt)))
      .returning({ id: notifications.id });

    return { marked: updated.length };
  });
}
