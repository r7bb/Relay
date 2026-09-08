import { type AuthenticatedUser, resolveSession, SESSION_COOKIE } from '@relay/auth';
import { type Database, findMembership } from '@relay/database';
import { can, type Permission, type Role } from '@relay/shared';
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { ApiError } from '../errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    /** Set by `requireMembership`; the actor's role in the workspace on the path. */
    membership?: { workspaceId: string; role: Role };
  }
}

/** Narrowed request types so handlers don't re-check what a guard guaranteed. */
export type AuthedRequest = FastifyRequest & { user: AuthenticatedUser };
export type MemberRequest = AuthedRequest & { membership: { workspaceId: string; role: Role } };

export function currentUser(request: FastifyRequest): AuthenticatedUser {
  if (!request.user) throw ApiError.unauthorized();
  return request.user;
}

export function currentMembership(request: FastifyRequest) {
  if (!request.membership) throw new Error('requireMembership did not run for this route');
  return request.membership;
}

/**
 * Populates `request.user` when a valid session cookie is present. Does not
 * reject -- routes opt into enforcement with `requireAuth`.
 */
export function attachUser(db: Database): preHandlerHookHandler {
  return async (request: FastifyRequest) => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token) return;

    const user = await resolveSession(db, token);
    if (user) request.user = user;
  };
}

export const requireAuth: preHandlerHookHandler = async (request: FastifyRequest) => {
  if (!request.user) throw ApiError.unauthorized();
};

/**
 * Resolves the actor's membership of the workspace named in the path and
 * asserts it carries `permission`.
 *
 * Non-members get 404, not 403. A 403 would confirm that the workspace exists,
 * turning the endpoint into an oracle for enumerating workspace IDs; a
 * non-member should not be able to distinguish "not yours" from "not real".
 * Members who simply lack the permission do get 403, since they already know
 * the workspace exists.
 */
export function requireMembership(db: Database, permission: Permission): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const user = currentUser(request);
    const { workspaceId } = request.params as { workspaceId?: string };

    if (!workspaceId) throw new Error('requireMembership used on a route without :workspaceId');

    // Shared with the WebSocket gateway, so both entry points answer the same
    // question the same way. Returns null for a malformed uuid too, which would
    // otherwise surface as a Postgres cast error and a 500.
    const member = await findMembership(db, workspaceId, user.id);

    if (!member) throw ApiError.notFound('Workspace not found');
    if (!can(member.role, permission)) throw ApiError.forbidden();

    request.membership = { workspaceId, role: member.role };
  };
}
