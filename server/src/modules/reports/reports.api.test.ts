/**
 * API tests for school-wide reports (Section 5).
 *
 * Runs against the real database: the permission check below is the real
 * deny-by-default middleware, not a mock's idea of it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const ADMIN = { username: '__apitest_reports_admin__', password: 'ReportsPassw0rd!2026' };
const NOBODY = { username: '__apitest_reports_nobody__', password: 'ReportsPassw0rd!2026' };

let server: Server;
let baseUrl: string;
let adminToken: string;
let nobodyToken: string;
let adminUserId: string;
let nobodyUserId: string;

async function call(path: string, token: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(creds: { username: string; password: string }): Promise<string> {
  const res = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(creds),
  });
  const body: any = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body.data.accessToken;
}

beforeAll(async () => {
  const app = createApp(buildContainer({ forTests: true }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  const makeUser = async (creds: { username: string; password: string }, roleName: string | null): Promise<string> => {
    return transaction(SYSTEM_ACTOR, async (uow) => {
      const hash = await hashPassword(creds.password);
      const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [creds.username]);
      const id = existing
        ? (await uow.one<{ id: string }>(
            `UPDATE users SET password_hash = $2, is_active = true, must_change_password = false, failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING id::text AS id`,
            [existing.id, hash],
          )).id
        : (await uow.one<{ id: string }>(
            `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active) VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`,
            [creds.username, hash],
          )).id;
      await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
      if (roleName) {
        const role = await uow.one<{ id: string }>(`SELECT id::text AS id FROM roles WHERE name = $1`, [roleName]);
        await uow.count(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [id, role.id]);
      }
      return id;
    });
  };

  adminUserId = await makeUser(ADMIN, SUPER_ADMIN_ROLE);
  nobodyUserId = await makeUser(NOBODY, null);

  adminToken = await login(ADMIN);
  nobodyToken = await login(NOBODY);
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    for (const id of [adminUserId, nobodyUserId]) {
      await uow.count(`UPDATE users SET is_active = false WHERE id = $1`, [id]);
      await uow.count(`DELETE FROM user_roles WHERE user_id = $1`, [id]);
      await uow.count(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [id]);
    }
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('student summary report', () => {
  it('returns status/gender counts for an authorized caller', async () => {
    const res = await call('/api/v1/reports/students', adminToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.data.summary)).toBe(true);
    for (const row of res.body.data.summary) {
      expect(typeof row.status).toBe('string');
      expect(typeof row.gender).toBe('string');
      expect(typeof row.count).toBe('number');
    }
  });

  it('denies a caller without students.read', async () => {
    const res = await call('/api/v1/reports/students', nobodyToken);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await fetch(`${baseUrl}/api/v1/reports/students`);
    expect(res.status).toBe(401);
  });
});

describe('staff summary report', () => {
  it('returns status/gender counts for an authorized caller', async () => {
    const res = await call('/api/v1/reports/staff', adminToken);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body.data.summary)).toBe(true);
    for (const row of res.body.data.summary) {
      expect(typeof row.status).toBe('string');
      expect(typeof row.gender).toBe('string');
      expect(typeof row.count).toBe('number');
    }
  });

  it('denies a caller without staff.read', async () => {
    const res = await call('/api/v1/reports/staff', nobodyToken);
    expect(res.status, JSON.stringify(res.body)).toBe(403);
  });
});
