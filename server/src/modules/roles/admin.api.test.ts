/**
 * API tests for the roles, permissions, settings and audit-log endpoints.
 *
 * Two accounts are used, because the interesting cases need both: one Super
 * Admin, and one authenticated user holding NO roles at all. The second is what
 * proves deny-by-default actually denies — a test that only ever calls
 * endpoints as an admin cannot distinguish "permission enforced" from
 * "permission never checked".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';
import { PERMISSION_CATALOG } from '../../core/authz/permission-catalog';

const ADMIN = { username: '__apitest_roles_admin__', password: 'RolesAdminPassw0rd!' };
const NOBODY = { username: '__apitest_nobody__', password: 'NobodyPassw0rd!2026' };

let server: Server;
let baseUrl: string;
let adminToken: string;
let nobodyToken: string;
const createdUserIds: string[] = [];
let createdRoleId: string | null = null;

async function call(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const body = await res.text();
  return { status: res.status, body: body ? JSON.parse(body) : null };
}

/** Create or reset a test account, optionally granting Super Admin. */
async function ensureUser(
  creds: { username: string; password: string },
  withSuperAdmin: boolean,
): Promise<string> {
  return transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(creds.password);
    const existing = await uow.maybeOne<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
      [creds.username],
    );

    const id = existing
      ? (await uow.one<{ id: string }>(
          `UPDATE users SET password_hash = $2, is_active = true, must_change_password = false,
                            failed_attempts = 0, locked_until = NULL, deleted_at = NULL
            WHERE id = $1 RETURNING id::text AS id`,
          [existing.id, hash],
        )).id
      : (await uow.one<{ id: string }>(
          `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active)
           VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`,
          [creds.username, hash],
        )).id;

    // Reset roles so a previous run cannot leave the "nobody" account with one.
    await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
    if (withSuperAdmin) {
      const role = await uow.one<{ id: string }>(
        `SELECT id::text AS id FROM roles WHERE name = $1`,
        [SUPER_ADMIN_ROLE],
      );
      await uow.count(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [id, role.id]);
    }
    return id;
  });
}

async function signIn(creds: { username: string; password: string }): Promise<string> {
  const res = await call('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify(creds),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data.accessToken;
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  createdUserIds.push(await ensureUser(ADMIN, true));
  createdUserIds.push(await ensureUser(NOBODY, false));

  adminToken = await signIn(ADMIN);
  nobodyToken = await signIn(NOBODY);
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    if (createdRoleId) {
      await uow.count(`DELETE FROM role_permissions WHERE role_id = $1`, [createdRoleId]);
      await uow.count(`DELETE FROM roles WHERE id = $1 AND is_system = false`, [createdRoleId]);
    }
    for (const id of createdUserIds) {
      // Deactivated rather than deleted: signing in wrote audit rows, and
      // audit_logs.user_id is ON DELETE RESTRICT.
      await uow.count(`UPDATE users SET is_active = false WHERE id = $1`, [id]);
      await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
      await uow.count(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [id]);
    }
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('deny by default', () => {
  it('refuses a role listing to a user with no roles', async () => {
    const res = await call('/api/v1/roles', { token: nobodyToken });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PERMISSION_DENIED');
    // The response names the missing permission, which saves a support round
    // trip and reveals nothing the caller could not learn by asking.
    expect(res.body.error.message).toContain('roles.read');
  });

  it('refuses a settings write to a user with no roles', async () => {
    const res = await call('/api/v1/settings', {
      method: 'PATCH',
      token: nobodyToken,
      body: JSON.stringify({ settings: { 'school.name': 'Hacked' } }),
    });
    expect(res.status).toBe(403);
  });

  it('refuses the audit log to a user with no roles', async () => {
    const res = await call('/api/v1/audit-logs', { token: nobodyToken });
    expect(res.status).toBe(403);
  });

  it('still lets that user read their own profile', async () => {
    // settings.read is held by every account by virtue of signing in.
    const res = await call('/api/v1/auth/me', { token: nobodyToken });
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual([]);
  });
});

describe('GET /roles', () => {
  it('lists the seven system roles with counts', async () => {
    const res = await call('/api/v1/roles', { token: adminToken });
    expect(res.status).toBe(200);

    const names = res.body.data.roles.map((r: { name: string }) => r.name);
    expect(names).toContain(SUPER_ADMIN_ROLE);
    expect(names).toContain('Teacher');

    const superAdmin = res.body.data.roles.find(
      (r: { name: string }) => r.name === SUPER_ADMIN_ROLE,
    );
    expect(superAdmin.isSystem).toBe(true);
    expect(superAdmin.permissionCount).toBe(PERMISSION_CATALOG.length);
  });

  it('returns a role with its full permission list', async () => {
    const list = await call('/api/v1/roles', { token: adminToken });
    const teacher = list.body.data.roles.find((r: { name: string }) => r.name === 'Teacher');

    const res = await call(`/api/v1/roles/${teacher.id}`, { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toContain('attendance.mark');
    // A teacher must never hold the override codes by default.
    expect(res.body.data.permissions).not.toContain('attendance.mark_override');
  });

  it('404s an unknown role', async () => {
    const res = await call('/api/v1/roles/99999999', { token: adminToken });
    expect(res.status).toBe(404);
  });

  it('rejects a non-numeric id at validation', async () => {
    const res = await call('/api/v1/roles/not-an-id', { token: adminToken });
    expect(res.status).toBe(422);
  });
});

describe('system role protection', () => {
  it('refuses to rename a system role', async () => {
    const list = await call('/api/v1/roles', { token: adminToken });
    const teacher = list.body.data.roles.find((r: { name: string }) => r.name === 'Teacher');

    const res = await call(`/api/v1/roles/${teacher.id}`, {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({ name: 'Instructor' }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
  });

  it('refuses to delete a system role', async () => {
    const list = await call('/api/v1/roles', { token: adminToken });
    const librarian = list.body.data.roles.find((r: { name: string }) => r.name === 'Librarian');

    const res = await call(`/api/v1/roles/${librarian.id}`, {
      method: 'DELETE',
      token: adminToken,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SYSTEM_ROLE_IMMUTABLE');
  });

  it('refuses to narrow Super Admin', async () => {
    const list = await call('/api/v1/roles', { token: adminToken });
    const superAdmin = list.body.data.roles.find(
      (r: { name: string }) => r.name === SUPER_ADMIN_ROLE,
    );

    // Narrowing it would leave nobody able to restore it — a locked-out system
    // with no path back short of direct SQL.
    const res = await call(`/api/v1/roles/${superAdmin.id}/permissions`, {
      method: 'PUT',
      token: adminToken,
      body: JSON.stringify({ permissions: ['roles.read'] }),
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SUPER_ADMIN_PROTECTED');
  });
});

describe('custom roles', () => {
  it('creates a role, sets its permissions, then deletes it', async () => {
    const created = await call('/api/v1/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: '__apitest_role__',
        description: 'Created by the API test',
        permissions: ['students.read', 'guardians.read'],
      }),
    });
    expect(created.status).toBe(201);
    createdRoleId = created.body.data.id;
    expect(created.body.data.permissions.sort()).toEqual(['guardians.read', 'students.read']);

    const replaced = await call(`/api/v1/roles/${createdRoleId}/permissions`, {
      method: 'PUT',
      token: adminToken,
      body: JSON.stringify({ permissions: ['students.read'] }),
    });
    expect(replaced.status).toBe(200);
    // Set semantics: guardians.read is gone, not merged.
    expect(replaced.body.data.permissions).toEqual(['students.read']);

    const deleted = await call(`/api/v1/roles/${createdRoleId}`, {
      method: 'DELETE',
      token: adminToken,
    });
    expect(deleted.status).toBe(204);
    createdRoleId = null;
  });

  it('rejects an unknown permission code rather than ignoring it', async () => {
    const res = await call('/api/v1/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({
        name: '__apitest_bad_role__',
        permissions: ['fees.collect', 'not.a.real.permission'],
      }),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('UNKNOWN_PERMISSION');
    expect(res.body.error.message).toContain('not.a.real.permission');
  });

  it('rejects a duplicate role name', async () => {
    const res = await call('/api/v1/roles', {
      method: 'POST',
      token: adminToken,
      body: JSON.stringify({ name: 'Teacher' }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('ROLE_NAME_TAKEN');
  });
});

describe('GET /permissions', () => {
  it('returns the catalogue grouped by module', async () => {
    const res = await call('/api/v1/permissions', { token: adminToken });
    expect(res.status).toBe(200);

    const modules = res.body.data.modules;
    expect(Object.keys(modules)).toContain('fees');
    const total = Object.values(modules).reduce<number>(
      (n, list) => n + (list as unknown[]).length,
      0,
    );
    expect(total).toBe(PERMISSION_CATALOG.length);
  });
});

describe('settings', () => {
  it('returns settings grouped, with defaults merged in', async () => {
    const res = await call('/api/v1/settings', { token: adminToken });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.data.groups)).toContain('school');

    const fees = res.body.data.groups.fees as { key: string; value: string }[];
    const cap = fees.find((s) => s.key === 'fees.fine_cap_percent_of_subtotal');
    // Decision 7's default, in force without any row having been written.
    expect(cap?.value).toBe('50');
  });

  it('writes a setting and reads it back', async () => {
    const write = await call('/api/v1/settings', {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({ settings: { 'school.name': 'API Test School' } }),
    });
    expect(write.status).toBe(200);
    expect(write.body.data.updated).toBe(1);

    const read = await call('/api/v1/settings', { token: adminToken });
    const school = read.body.data.groups.school as { key: string; value: string }[];
    expect(school.find((s) => s.key === 'school.name')?.value).toBe('API Test School');
  });

  it('rejects an unknown setting key', async () => {
    const res = await call('/api/v1/settings', {
      method: 'PATCH',
      token: adminToken,
      body: JSON.stringify({ settings: { 'not.a.setting': 'x' } }),
    });
    expect(res.status).toBe(422);
  });
});

describe('audit log', () => {
  it('returns a keyset page of recent entries', async () => {
    const res = await call('/api/v1/audit-logs?limit=5', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.data.entries.length).toBeLessThanOrEqual(5);
    expect(res.body.meta.page.limit).toBe(5);
    expect(res.body.meta.page).toHaveProperty('hasMore');
    // Not counted unless asked: on a growing table that is a full scan.
    expect(res.body.meta.page.total).toBeUndefined();
  });

  it('records the login events written during this suite', async () => {
    const res = await call('/api/v1/audit-logs?action=login&limit=20', { token: adminToken });
    expect(res.status).toBe(200);
    expect(res.body.data.entries.length).toBeGreaterThan(0);
    expect(res.body.data.entries.every((e: { action: string }) => e.action === 'login')).toBe(true);
  });

  it('supplies a total only when asked', async () => {
    const res = await call('/api/v1/audit-logs?limit=1&withTotal=true', { token: adminToken });
    expect(res.status).toBe(200);
    expect(typeof res.body.meta.page.total).toBe('number');
  });

  it('rejects an unknown filter rather than ignoring it', async () => {
    // A silently dropped filter returns more rows than the caller asked for.
    const res = await call('/api/v1/audit-logs?nonsense=1', { token: adminToken });
    expect(res.status).toBe(422);
  });

  it('rejects an inverted date range', async () => {
    const res = await call('/api/v1/audit-logs?from=2026-09-30&to=2026-09-01', {
      token: adminToken,
    });
    expect(res.status).toBe(422);
  });

  it('rejects a malformed cursor', async () => {
    const res = await call('/api/v1/audit-logs?cursor=not-base64', { token: adminToken });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });
});
