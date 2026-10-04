/**
 * Roles, their permissions, and the permission catalogue read model.
 */

import type { Uow } from '../../core/db/uow';
import { ConflictError, NotFoundError } from '../../core/errors';

export type RoleRow = {
  id: string;
  name: string;
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissionCount: number;
  createdAt: string;
  updatedAt: string;
};

const ROLE_SELECT = `
  r.id::text        AS id,
  r.name,
  r.description,
  r.is_system       AS "isSystem",
  r.created_at::text AS "createdAt",
  r.updated_at::text AS "updatedAt",
  (SELECT count(*)::int FROM user_roles ur WHERE ur.role_id = r.id)        AS "userCount",
  (SELECT count(*)::int FROM role_permissions rp WHERE rp.role_id = r.id)  AS "permissionCount"`;

export class RolesRepository {
  /**
   * All roles.
   *
   * Offset-free and unpaginated on purpose: Part 5.5 permits it for small
   * bounded tables, and a school has a handful of roles. Paginating this would
   * add a cursor to every client for no benefit.
   */
  async list(uow: Uow): Promise<RoleRow[]> {
    return uow.many<RoleRow>(
      `SELECT ${ROLE_SELECT} FROM roles r ORDER BY r.is_system DESC, r.name`,
    );
  }

  async findById(uow: Uow, id: string): Promise<RoleRow | null> {
    return uow.maybeOne<RoleRow>(`SELECT ${ROLE_SELECT} FROM roles r WHERE r.id = $1`, [id]);
  }

  async getById(uow: Uow, id: string): Promise<RoleRow> {
    const row = await this.findById(uow, id);
    if (!row) throw new NotFoundError('Role');
    return row;
  }

  async findByName(uow: Uow, name: string): Promise<RoleRow | null> {
    return uow.maybeOne<RoleRow>(
      `SELECT ${ROLE_SELECT} FROM roles r WHERE lower(r.name) = lower($1)`,
      [name],
    );
  }

  async permissionCodes(uow: Uow, roleId: string): Promise<string[]> {
    const rows = await uow.many<{ code: string }>(
      `SELECT p.code
         FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1
        ORDER BY p.code`,
      [roleId],
    );
    return rows.map((r) => r.code);
  }

  async create(
    uow: Uow,
    input: { name: string; description: string | null },
  ): Promise<RoleRow> {
    const row = await uow.one<{ id: string }>(
      `INSERT INTO roles (name, description, is_system) VALUES ($1, $2, false)
       RETURNING id::text AS id`,
      [input.name, input.description],
    );
    return this.getById(uow, row.id);
  }

  async update(
    uow: Uow,
    id: string,
    input: { name?: string | undefined; description?: string | null | undefined },
  ): Promise<RoleRow> {
    // COALESCE so an omitted field keeps its value rather than being nulled.
    await uow.count(
      `UPDATE roles
          SET name = COALESCE($2, name),
              description = CASE WHEN $3::boolean THEN $4 ELSE description END
        WHERE id = $1`,
      [id, input.name ?? null, input.description !== undefined, input.description ?? null],
    );
    return this.getById(uow, id);
  }

  /**
   * Delete a role.
   *
   * `role_permissions` has no cascade, so its rows must go first or the foreign
   * key refuses the delete — which surfaced as a 409 "still referenced" where
   * the caller expected a 204. The grants are not data worth keeping once the
   * role is gone; `user_roles` is different, and the service refuses to delete
   * a role anyone still holds rather than silently stripping it from them.
   */
  async delete(uow: Uow, id: string): Promise<void> {
    await uow.count(`DELETE FROM role_permissions WHERE role_id = $1`, [id]);
    const affected = await uow.count(`DELETE FROM roles WHERE id = $1`, [id]);
    if (affected === 0) throw new NotFoundError('Role');
  }

  /**
   * Replace a role's permissions with exactly `codes`.
   *
   * Set semantics, in two statements, rather than delete-all-then-insert: the
   * delete-then-insert form briefly leaves the role with no permissions, and a
   * concurrent request in that window would see an unprivileged role.
   */
  async setPermissions(uow: Uow, roleId: string, codes: readonly string[]): Promise<number> {
    const ids = await uow.many<{ id: string }>(
      `SELECT id::text AS id FROM permissions WHERE code = ANY($1)`,
      [codes],
    );

    if (ids.length !== new Set(codes).size) {
      const found = new Set<string>();
      const rows = await uow.many<{ code: string }>(
        `SELECT code FROM permissions WHERE code = ANY($1)`,
        [codes],
      );
      rows.forEach((r) => found.add(r.code));
      const missing = [...new Set(codes)].filter((c) => !found.has(c));
      throw new ConflictError(
        `Unknown permission codes: ${missing.join(', ')}.`,
        'UNKNOWN_PERMISSION',
      );
    }

    const idList = ids.map((r) => r.id);

    await uow.count(
      `DELETE FROM role_permissions
        WHERE role_id = $1 AND NOT (permission_id = ANY($2::bigint[]))`,
      [roleId, idList],
    );
    await uow.count(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, unnest($2::bigint[])
       ON CONFLICT DO NOTHING`,
      [roleId, idList],
    );

    return idList.length;
  }

  /** How many users hold this role, for the delete guard. */
  async assignedUserCount(uow: Uow, roleId: string): Promise<number> {
    const row = await uow.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_roles WHERE role_id = $1`,
      [roleId],
    );
    return row.n;
  }

  /** The whole catalogue, grouped by module, for the read-only listing. */
  async listPermissions(uow: Uow): Promise<{ module: string; code: string; description: string | null }[]> {
    return uow.many(
      `SELECT module, code, description FROM permissions ORDER BY module, code`,
    );
  }
}
