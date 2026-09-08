import {
  type Database,
  documents,
  documentText,
  loadDocument,
  publishEvent,
} from '@relay/database';
import { createDocumentSchema, updateDocumentSchema } from '@relay/shared';
import { and, desc, eq } from 'drizzle-orm';
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
 * REST surface for documents: create, list, rename, delete, and a read-only
 * plain-text view.
 *
 * The *content* deliberately does not go through here. Editing happens over the
 * WebSocket gateway, because a CRDT needs incremental updates against a live
 * replica -- a request/response endpoint would either force a full-document
 * round trip per keystroke or reintroduce the last-write-wins overwrite that
 * the CRDT exists to avoid.
 */
export async function documentRoutes(app: FastifyInstance, opts: { db: Database }) {
  const { db } = opts;

  app.get(
    '/workspaces/:workspaceId/documents',
    { preHandler: [requireAuth, requireMembership(db, 'project:read')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);

      const rows = await db
        .select({
          id: documents.id,
          title: documents.title,
          projectId: documents.projectId,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(eq(documents.workspaceId, workspaceId))
        .orderBy(desc(documents.updatedAt));

      return { documents: rows };
    },
  );

  app.post(
    '/workspaces/:workspaceId/documents',
    { preHandler: [requireAuth, requireMembership(db, 'project:create')] },
    async (request, reply) => {
      const user = currentUser(request);
      const { workspaceId } = currentMembership(request);
      const input = parse(createDocumentSchema, request.body);

      const [document] = await db
        .insert(documents)
        .values({
          workspaceId,
          projectId: input.projectId ?? null,
          title: input.title,
          createdBy: user.id,
        })
        .returning();

      await publishEvent(db, {
        type: 'document.created',
        workspaceId,
        documentId: document!.id,
        actorId: user.id,
      });

      return reply.status(201).send({ document });
    },
  );

  app.get(
    '/workspaces/:workspaceId/documents/:documentId',
    { preHandler: [requireAuth, requireMembership(db, 'project:read')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);
      const { documentId } = request.params as { documentId: string };

      const document = await loadMeta(workspaceId, documentId);

      // Rendered text, for previews and anything that cannot speak CRDT. The
      // editor ignores this and syncs over the socket instead.
      const doc = await loadDocument(db, documentId);

      return { document: { ...document, text: documentText(doc) } };
    },
  );

  app.patch(
    '/workspaces/:workspaceId/documents/:documentId',
    { preHandler: [requireAuth, requireMembership(db, 'project:update')] },
    async (request) => {
      const { workspaceId } = currentMembership(request);
      const { documentId } = request.params as { documentId: string };
      const input = parse(updateDocumentSchema, request.body);

      await loadMeta(workspaceId, documentId);

      const [updated] = await db
        .update(documents)
        .set({ ...input, updatedAt: new Date() })
        .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)))
        .returning();

      return { document: updated };
    },
  );

  app.delete(
    '/workspaces/:workspaceId/documents/:documentId',
    { preHandler: [requireAuth, requireMembership(db, 'project:delete')] },
    async (request, reply) => {
      const { workspaceId } = currentMembership(request);
      const { documentId } = request.params as { documentId: string };

      await loadMeta(workspaceId, documentId);

      // The update log goes with it via ON DELETE CASCADE.
      await db
        .delete(documents)
        .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)));

      return reply.status(204).send();
    },
  );

  /** Tenant-scoped metadata lookup. See the note on `loadProject`. */
  async function loadMeta(workspaceId: string, documentId: string) {
    if (!UUID_RE.test(documentId)) throw ApiError.notFound('Document not found');

    const [document] = await db
      .select({
        id: documents.id,
        title: documents.title,
        projectId: documents.projectId,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.workspaceId, workspaceId)))
      .limit(1);

    if (!document) throw ApiError.notFound('Document not found');
    return document;
  }
}
