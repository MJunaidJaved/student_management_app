/**
 * Effective permissions per user, cached (Part 7.1).
 *
 * A user's permissions are the union of their roles' permissions. That union is
 * needed on every authenticated request, and computing it means a two-join
 * query, so it is cached — but with a short TTL, because the cache window is
 * exactly the period during which a revoked role still works.
 *
 * The set is returned as a `Set<string>` so the check is O(1). A user with six
 * roles can easily hold a hundred codes, and an array scan per request adds up.
 */

import { readTransaction, type Actor, type UserType } from '../db/uow';
import type { CacheStore } from '../cache/cache';
import { logger } from '../logging/logger';

export class PermissionService {
  constructor(private readonly cache: CacheStore) {}

  /**
   * Every permission code this user holds.
   *
   * Read with a system actor rather than the user's own: this runs *before*
   * authorization has been decided, so it cannot depend on a scope that
   * authorization has not yet established. It reads only the user's own role
   * grants, which is not sensitive to the caller.
   */
  async forUser(userId: string | number): Promise<ReadonlySet<string>> {
    const key = String(userId);

    const codes = await this.cache.getOrLoad('user-permissions', key, async () =>
      readTransaction({ userId: null, userType: null }, async (uow) => {
        const rows = await uow.many<{ code: string }>(
          `SELECT DISTINCT p.code
             FROM user_roles ur
             JOIN role_permissions rp ON rp.role_id = ur.role_id
             JOIN permissions p       ON p.id = rp.permission_id
            WHERE ur.user_id = $1`,
          [key],
        );
        return rows.map((r) => r.code);
      }),
    );

    return new Set(codes);
  }

  async has(userId: string | number, code: string): Promise<boolean> {
    return (await this.forUser(userId)).has(code);
  }

  /** True when the user holds every one of `codes`. */
  async hasAll(userId: string | number, codes: readonly string[]): Promise<boolean> {
    const held = await this.forUser(userId);
    return codes.every((c) => held.has(c));
  }

  /** True when the user holds at least one of `codes`. */
  async hasAny(userId: string | number, codes: readonly string[]): Promise<boolean> {
    const held = await this.forUser(userId);
    return codes.some((c) => held.has(c));
  }

  /** The user's roles, for `GET /me` and the users listing. */
  async rolesForUser(userId: string | number): Promise<{ id: string; name: string }[]> {
    return readTransaction({ userId: null, userType: null }, async (uow) =>
      uow.many<{ id: string; name: string }>(
        `SELECT r.id, r.name
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = $1
          ORDER BY r.name`,
        [String(userId)],
      ),
    );
  }

  /** Drop one user's cached set. Called when their roles change. */
  async invalidateUser(userId: string | number): Promise<void> {
    await this.cache.delete('user-permissions', String(userId));
  }

  /**
   * Drop every cached set.
   *
   * Used when a *role's* permissions change. Finding just the affected users
   * would be a query, and this happens rarely — an administrator editing a
   * role — so clearing the namespace is the cheaper and safer trade. Erring
   * toward over-invalidation is correct here: the failure mode of the
   * alternative is someone keeping a permission that was revoked.
   */
  async invalidateAll(reason: string): Promise<void> {
    await this.cache.clearNamespace('user-permissions');
    await this.cache.clearNamespace('role-permissions');
    logger.info({ reason }, 'Permission caches cleared');
  }
}

/**
 * The full actor for a request, resolved from the user record.
 *
 * The linked person id matters: the policy layer needs `guardianId` to find
 * that guardian's children and `staffId` to find a teacher's sections, and
 * looking it up per check would mean a query per authorization decision.
 */
export type ResolvedUser = {
  id: string;
  username: string;
  /**
   * Non-nullable: `users.user_type` is NOT NULL with a CHECK constraint
   * restricting it to these four values. `Actor.userType` is nullable only
   * because a system actor (a job, a migration) has no user at all.
   */
  userType: UserType;
  staffId: string | null;
  guardianId: string | null;
  studentId: string | null;
  isActive: boolean;
  mustChangePassword: boolean;
  lockedUntil: string | null;
};

export const toActor = (user: ResolvedUser): Actor => ({
  userId: Number(user.id),
  userType: user.userType,
  guardianId: user.guardianId === null ? null : Number(user.guardianId),
  staffId: user.staffId === null ? null : Number(user.staffId),
  studentId: user.studentId === null ? null : Number(user.studentId),
});
