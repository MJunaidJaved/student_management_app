/**
 * Role management (Module 1).
 *
 * The protections here are the ones Part 7 calls out, and each exists because
 * the alternative is an unrecoverable system:
 *
 *   * **System roles cannot be renamed or deleted.** The seeder and the default
 *     role matrix both find roles by name, so renaming "Teacher" silently
 *     detaches it from everything that refers to it.
 *
 *   * **A role in use cannot be deleted.** `user_roles` has no cascade, so the
 *     database would refuse anyway — this turns that into a clear message
 *     naming the count.
 *
 *   * **Super Admin's permissions cannot be narrowed.** It is the only role that
 *     can grant permissions, so removing `roles.update` from it leaves nobody
 *     able to restore it. That is a locked-out system with no path back short
 *     of direct SQL.
 */

import { SYSTEM_ACTOR, transaction, readTransaction, type Actor } from '../../core/db/uow';
import { BusinessRuleError, ForbiddenError } from '../../core/errors';
import { PERMISSION_CATALOG } from '../../core/authz/permission-catalog';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';
import type { PermissionService } from '../../core/authz/permission-service';
import type { RolesRepository, RoleRow } from './roles.repository';

export type RoleDetail = RoleRow & { permissions: string[] };

export class RolesService {
  constructor(
    private readonly roles: RolesRepository,
    private readonly permissions: PermissionService,
  ) {}

  async list(actor: Actor): Promise<RoleRow[]> {
    return readTransaction(actor, (uow) => this.roles.list(uow));
  }

  async get(actor: Actor, id: string): Promise<RoleDetail> {
    return readTransaction(actor, async (uow) => {
      const role = await this.roles.getById(uow, id);
      return { ...role, permissions: await this.roles.permissionCodes(uow, id) };
    });
  }

  /** The catalogue, grouped by module (read-only; the seed owns the list). */
  async listPermissions(actor: Actor): Promise<Record<string, { code: string; description: string | null }[]>> {
    const rows = await readTransaction(actor, (uow) => this.roles.listPermissions(uow));

    const grouped: Record<string, { code: string; description: string | null }[]> = {};
    for (const row of rows) {
      (grouped[row.module] ??= []).push({ code: row.code, description: row.description });
    }
    return grouped;
  }

  async create(
    actor: Actor,
    input: { name: string; description?: string | undefined; permissions?: string[] | undefined },
  ): Promise<RoleDetail> {
    const created = await transaction(actor, async (uow) => {
      const clash = await this.roles.findByName(uow, input.name);
      // Checked first for a clear message; the unique constraint is the guard.
      if (clash) {
        throw new BusinessRuleError(
          `A role named "${clash.name}" already exists.`,
          'ROLE_NAME_TAKEN',
        );
      }

      const role = await this.roles.create(uow, {
        name: input.name,
        description: input.description ?? null,
      });
      if (input.permissions?.length) {
        await this.roles.setPermissions(uow, role.id, input.permissions);
      }
      return { ...role, permissions: await this.roles.permissionCodes(uow, role.id) };
    });

    return created;
  }

  async update(
    actor: Actor,
    id: string,
    input: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<RoleDetail> {
    return transaction(actor, async (uow) => {
      const role = await this.roles.getById(uow, id);

      if (role.isSystem && input.name !== undefined && input.name !== role.name) {
        throw new ForbiddenError(
          `"${role.name}" is a system role and cannot be renamed.`,
          'SYSTEM_ROLE_IMMUTABLE',
        );
      }
      if (input.name !== undefined && input.name !== role.name) {
        const clash = await this.roles.findByName(uow, input.name);
        if (clash && clash.id !== id) {
          throw new BusinessRuleError(
            `A role named "${clash.name}" already exists.`,
            'ROLE_NAME_TAKEN',
          );
        }
      }

      const updated = await this.roles.update(uow, id, input);
      return { ...updated, permissions: await this.roles.permissionCodes(uow, id) };
    });
  }

  async delete(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const role = await this.roles.getById(uow, id);

      if (role.isSystem) {
        throw new ForbiddenError(
          `"${role.name}" is a system role and cannot be deleted.`,
          'SYSTEM_ROLE_IMMUTABLE',
        );
      }

      const assigned = await this.roles.assignedUserCount(uow, id);
      if (assigned > 0) {
        throw new BusinessRuleError(
          `"${role.name}" is assigned to ${assigned} ${assigned === 1 ? 'user' : 'users'}. ` +
            'Remove it from them first.',
          'ROLE_IN_USE',
        );
      }

      await this.roles.delete(uow, id);
    });

    // A deleted role changes somebody's effective permissions.
    await this.permissions.invalidateAll(`role ${id} deleted`);
  }

  /**
   * Replace a role's permission set.
   *
   * Every cached permission set is cleared afterwards. Part 7 requires a role
   * change to take effect promptly, and working out exactly which users are
   * affected is a query for an operation that happens rarely — over-invalidating
   * is the cheaper and safer trade, because the failure mode of the alternative
   * is someone keeping a permission that was just revoked.
   */
  async setPermissions(actor: Actor, id: string, codes: readonly string[]): Promise<RoleDetail> {
    const detail = await transaction(actor, async (uow) => {
      const role = await this.roles.getById(uow, id);

      if (role.name === SUPER_ADMIN_ROLE) {
        const full = PERMISSION_CATALOG.length;
        if (new Set(codes).size < full) {
          throw new ForbiddenError(
            `${SUPER_ADMIN_ROLE} must keep every permission (${full}). ` +
              'Narrowing it would leave nobody able to restore it.',
            'SUPER_ADMIN_PROTECTED',
          );
        }
      }

      await this.roles.setPermissions(uow, id, codes);
      const fresh = await this.roles.getById(uow, id);
      return { ...fresh, permissions: await this.roles.permissionCodes(uow, id) };
    });

    await this.permissions.invalidateAll(`permissions changed for role ${id}`);
    return detail;
  }

  /**
   * The role-to-permission matrix, for review.
   *
   * Uses a system actor because it is a reporting view over configuration, not
   * over anyone's data.
   */
  async matrix(): Promise<{ role: string; isSystem: boolean; count: number; permissions: string[] }[]> {
    return readTransaction(SYSTEM_ACTOR, async (uow) => {
      const roles = await this.roles.list(uow);
      const out: { role: string; isSystem: boolean; count: number; permissions: string[] }[] = [];
      for (const role of roles) {
        const permissions = await this.roles.permissionCodes(uow, role.id);
        out.push({
          role: role.name,
          isSystem: role.isSystem,
          count: permissions.length,
          permissions,
        });
      }
      return out;
    });
  }
}
