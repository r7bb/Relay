/**
 * Authorization model.
 *
 * Every permission check in the API resolves to `can(role, permission)` against
 * the matrix below. Keeping it declarative means the rules are greppable, are
 * testable without spinning up routes, and can't drift between endpoints the
 * way scattered `if (role === 'ADMIN')` checks do.
 *
 * Rules that depend on more than the actor's role -- an admin may not demote an
 * owner, a workspace may not lose its last owner -- are *not* expressible here.
 * Those live in the member service alongside the data they need.
 */

export const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'GUEST'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'workspace:read',
  'workspace:update',
  'workspace:delete',

  'member:read',
  'member:invite',
  'member:remove',
  'member:set_role',

  'project:create',
  'project:read',
  'project:update',
  'project:delete',

  'issue:create',
  'issue:read',
  'issue:update',
  'issue:delete',

  'comment:create',
  'comment:read',
  /** Delete a comment you authored. */
  'comment:delete_own',
  /** Delete anyone's comment (moderation). */
  'comment:delete_any',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** Read-only access shared by every role, including guests. */
const READ_ONLY: readonly Permission[] = [
  'workspace:read',
  'member:read',
  'project:read',
  'issue:read',
  'comment:read',
];

const GUEST: readonly Permission[] = [
  ...READ_ONLY,
  'comment:create',
  'comment:delete_own',
];

const MEMBER: readonly Permission[] = [
  ...GUEST,
  'project:create',
  'project:update',
  'issue:create',
  'issue:update',
  'issue:delete',
];

const ADMIN: readonly Permission[] = [
  ...MEMBER,
  'workspace:update',
  'member:invite',
  'member:remove',
  'member:set_role',
  'project:delete',
  'comment:delete_any',
];

/** Owners differ from admins only by being able to destroy the workspace. */
const OWNER: readonly Permission[] = [...ADMIN, 'workspace:delete'];

const MATRIX: Record<Role, ReadonlySet<Permission>> = {
  OWNER: new Set(OWNER),
  ADMIN: new Set(ADMIN),
  MEMBER: new Set(MEMBER),
  GUEST: new Set(GUEST),
};

export function can(role: Role, permission: Permission): boolean {
  return MATRIX[role].has(permission);
}

export function permissionsFor(role: Role): Permission[] {
  return [...MATRIX[role]];
}

/**
 * Ranking used for "you may not act on someone at or above your level" checks.
 * Higher number == more authority.
 */
const RANK: Record<Role, number> = { GUEST: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export function outranks(actor: Role, target: Role): boolean {
  return RANK[actor] > RANK[target];
}

export function rankOf(role: Role): number {
  return RANK[role];
}
