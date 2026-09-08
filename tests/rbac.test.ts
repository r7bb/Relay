import { ROLES, type Role, can, outranks, permissionsFor } from '@relay/shared';
import { describe, expect, test } from 'bun:test';

/**
 * Pure tests over the permission matrix. These need no database and run in
 * milliseconds, which makes them the right place to pin down the rules; the
 * integration tests then only have to prove the routes consult them.
 */
describe('permission matrix', () => {
  test('guests can read and comment but not change work', () => {
    expect(can('GUEST', 'issue:read')).toBe(true);
    expect(can('GUEST', 'comment:create')).toBe(true);
    expect(can('GUEST', 'comment:delete_own')).toBe(true);

    expect(can('GUEST', 'issue:create')).toBe(false);
    expect(can('GUEST', 'issue:update')).toBe(false);
    expect(can('GUEST', 'project:delete')).toBe(false);
    expect(can('GUEST', 'member:invite')).toBe(false);
  });

  test('members can manage work but not people', () => {
    expect(can('MEMBER', 'issue:create')).toBe(true);
    expect(can('MEMBER', 'issue:update')).toBe(true);
    expect(can('MEMBER', 'project:create')).toBe(true);

    expect(can('MEMBER', 'member:invite')).toBe(false);
    expect(can('MEMBER', 'member:remove')).toBe(false);
    expect(can('MEMBER', 'member:set_role')).toBe(false);
    expect(can('MEMBER', 'project:delete')).toBe(false);
    expect(can('MEMBER', 'comment:delete_any')).toBe(false);
  });

  test('admins can manage people but not destroy the workspace', () => {
    expect(can('ADMIN', 'member:invite')).toBe(true);
    expect(can('ADMIN', 'member:remove')).toBe(true);
    expect(can('ADMIN', 'workspace:update')).toBe(true);
    expect(can('ADMIN', 'comment:delete_any')).toBe(true);

    expect(can('ADMIN', 'workspace:delete')).toBe(false);
  });

  test('deleting the workspace is what separates owner from admin', () => {
    const owner = new Set(permissionsFor('OWNER'));
    const admin = new Set(permissionsFor('ADMIN'));
    const extra = [...owner].filter((p) => !admin.has(p));

    expect(extra).toEqual(['workspace:delete']);
  });

  /**
   * Each role is a strict superset of the one below it. If this ever fails,
   * some role can do something a more senior role cannot, which would make the
   * `outranks` checks in the member routes unsound.
   */
  test('roles are cumulative', () => {
    const ascending: Role[] = ['GUEST', 'MEMBER', 'ADMIN', 'OWNER'];

    for (let i = 1; i < ascending.length; i++) {
      const lower = permissionsFor(ascending[i - 1]!);
      const higher = new Set(permissionsFor(ascending[i]!));
      const missing = lower.filter((p) => !higher.has(p));

      expect(missing).toEqual([]);
    }
  });

  test('outranks is a strict ordering', () => {
    expect(outranks('OWNER', 'ADMIN')).toBe(true);
    expect(outranks('ADMIN', 'MEMBER')).toBe(true);
    expect(outranks('MEMBER', 'GUEST')).toBe(true);

    expect(outranks('ADMIN', 'OWNER')).toBe(false);
    for (const role of ROLES) {
      expect(outranks(role, role)).toBe(false);
    }
  });
});
