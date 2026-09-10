import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import type { Database } from '@relay/database';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Env } from './env.ts';
import { ApiError } from './errors.ts';
import { attachUser } from './plugins/authz.ts';
import { authRoutes } from './routes/auth.ts';
import { commentRoutes } from './routes/comments.ts';
import { documentRoutes } from './routes/documents.ts';
import { issueRoutes } from './routes/issues.ts';
import { memberRoutes } from './routes/members.ts';
import { notificationRoutes } from './routes/notifications.ts';
import { projectRoutes } from './routes/projects.ts';
import { workspaceRoutes } from './routes/workspaces.ts';

export type AppDeps = {
  db: Database;
  env: Env;
  /** Quiet by default in tests; `main.ts` turns logging on. */
  logger?: boolean;
};

export function buildApp({ db, env, logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger, trustProxy: true });

  app.register(cookie);
  app.register(cors, {
    // Cookies are only sent cross-origin when the origin is explicitly allowed
    // and credentials are enabled; a wildcard would silently disable both.
    origin: env.WEB_ORIGIN,
    credentials: true,
  });

  app.addHook('preHandler', attachUser(db));

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof ApiError) {
      return reply.status(error.statusCode).send({ error: error.code, message: error.message });
    }

    // Fastify's own errors (malformed JSON, payload too large) already carry a
    // client-safe 4xx status and message.
    if (typeof error.statusCode === 'number' && error.statusCode < 500) {
      return reply
        .status(error.statusCode)
        .send({ error: error.code ?? 'bad_request', message: error.message });
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Something went wrong' });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.status(404).send({ error: 'not_found', message: 'Not found' }),
  );

  app.get('/health', async () => ({ status: 'ok' }));

  app.register(authRoutes, { db, env });
  app.register(workspaceRoutes, { db });
  app.register(memberRoutes, { db });
  app.register(projectRoutes, { db });
  app.register(issueRoutes, { db });
  app.register(commentRoutes, { db });
  app.register(documentRoutes, { db });
  app.register(notificationRoutes, { db });

  return app;
}
