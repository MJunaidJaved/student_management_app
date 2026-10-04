/**
 * API tests for the auth endpoints (Part 14: "API tests through HTTP").
 *
 * These go over real HTTP against the real database, because the things most
 * worth checking here only exist in the whole chain: middleware order, the
 * cookie, the account lockout counter, and the refresh-token rotation.
 *
 * The real Super Admin is deliberately left alone. Each run creates its own
 * account and deactivates it afterwards rather than deleting it —
 * `audit_logs.user_id` is a foreign key with ON DELETE RESTRICT, and logging in
 * writes audit rows, so by the end of the suite the user genuinely cannot be
 * deleted. That is the schema working as intended, not an obstacle to route
 * around.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';

const USERNAME = '__apitest_admin__';
const PASSWORD = 'ApiTestPassw0rd!2026';

let server: Server;
let baseUrl: string;
let userId: string;

/** A fetch wrapper that keeps the response status, body and set-cookie. */
async function call(
  path: string,
  init: RequestInit & { token?: string; cookie?: string } = {},
): Promise<{ status: number; body: any; cookie: string | null }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...((init.headers as Record<string, string> | undefined) ?? {}),
  };
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.cookie) headers.cookie = init.cookie;

  const res = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? JSON.parse(text) : null,
    cookie: res.headers.get('set-cookie'),
  };
}

beforeAll(async () => {
  // forTests disables the cache and rate limiter: a cached permission set
  // leaking between cases looks like an authorization bug, and a tripped
  // limiter looks like a logic bug. The lockout test re-enables nothing —
  // lockout is database state, not a rate limit.
  const app = createApp(buildContainer({ forTests: true }));

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  userId = await transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(PASSWORD);

    // Reset rather than assume a clean slate, so a previous aborted run does
    // not fail this one.
    const existing = await uow.maybeOne<{ id: string }>(
      `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
      [USERNAME],
    );

    if (existing) {
      await uow.count(
        `UPDATE users
            SET password_hash = $2, is_active = true, must_change_password = false,
                failed_attempts = 0, locked_until = NULL, deleted_at = NULL
          WHERE id = $1`,
        [existing.id, hash],
      );
      await uow.count(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [
        existing.id,
      ]);
      return existing.id;
    }

    const created = await uow.one<{ id: string }>(
      `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active)
       VALUES ($1, $2, 'admin', false, true)
       RETURNING id::text AS id`,
      [USERNAME, hash],
    );
    const role = await uow.one<{ id: string }>(`SELECT id::text AS id FROM roles WHERE name = $1`, [
      SUPER_ADMIN_ROLE,
    ]);
    await uow.count(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, [
      created.id,
      role.id,
    ]);
    return created.id;
  });
});

afterAll(async () => {
  if (userId) {
    await transaction(SYSTEM_ACTOR, async (uow) => {
      await uow.count(
        `UPDATE users SET is_active = false, failed_attempts = 0, locked_until = NULL WHERE id = $1`,
        [userId],
      );
      await uow.count(`UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1`, [userId]);
    });
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closePool();
});

describe('health and readiness', () => {
  it('answers health without authentication and reveals nothing', async () => {
    const res = await call('/health');
    expect(res.status).toBe(200);
    // No version, no dependency detail, no hostname.
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('answers readiness when the database is reachable', async () => {
    const res = await call('/ready');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ready' });
  });
});

describe('POST /auth/login', () => {
  it('rejects a wrong password with the generic message', async () => {
    const res = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: USERNAME, password: 'wrong-password-entirely' }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('LOGIN_FAILED');
    expect(res.body.error.message).toBe('The username or password is incorrect.');
  });

  it('gives an unknown username the identical response', async () => {
    // The whole point: the two cases must be indistinguishable.
    const res = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'no-such-user-at-all', password: 'wrong-password-entirely' }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('LOGIN_FAILED');
    expect(res.body.error.message).toBe('The username or password is incorrect.');
  });

  it('rejects unknown body fields rather than ignoring them', async () => {
    const res = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: USERNAME, password: PASSWORD, userType: 'admin' }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('reports field-level validation errors', async () => {
    const res = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: '' }),
    });
    expect(res.status).toBe(422);
    expect(res.body.error.issues.map((i: { field: string }) => i.field)).toContain('body.password');
  });

  it('signs in and sets the refresh token as an httpOnly cookie', async () => {
    const res = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTypeOf('string');
    expect(res.body.meta.requestId).toBeTypeOf('string');

    // The refresh token must never be in the body — that is the point of the
    // cookie. Only the short-lived access token is handed to JavaScript.
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.cookie).toContain('sms_refresh=');
    expect(res.cookie).toContain('HttpOnly');
  });
});

describe('authenticated requests', () => {
  async function signIn(): Promise<{ token: string; cookie: string }> {
    const res = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
    });
    expect(res.status).toBe(200);
    return { token: res.body.data.accessToken, cookie: res.cookie!.split(';')[0]! };
  }

  it('refuses /me without a token', async () => {
    const res = await call('/api/v1/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('refuses a malformed token without leaking why', async () => {
    const res = await call('/api/v1/auth/me', { token: 'not-a-jwt' });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('returns identity, roles and the full permission set', async () => {
    const { token } = await signIn();
    const res = await call('/api/v1/auth/me', { token });

    expect(res.status).toBe(200);
    expect(res.body.data.user.username).toBe(USERNAME);
    expect(res.body.data.roles.map((r: { name: string }) => r.name)).toContain(SUPER_ADMIN_ROLE);
    // Super Admin holds the whole catalogue.
    expect(res.body.data.permissions).toContain('fees.reverse_payment');
    expect(res.body.data.permissions.length).toBe(108);
  });

  it('rotates the refresh token and invalidates the old one', async () => {
    const { cookie } = await signIn();

    const first = await call('/api/v1/auth/refresh', { method: 'POST', cookie });
    expect(first.status).toBe(200);
    expect(first.cookie).toContain('sms_refresh=');

    // Reusing the spent token is the theft signal: the whole family goes.
    const replay = await call('/api/v1/auth/refresh', { method: 'POST', cookie });
    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe('REFRESH_REUSE');

    // And the token issued by the legitimate rotation is revoked too, because
    // there is no way to tell which holder was the thief.
    const rotated = first.cookie!.split(';')[0]!;
    const after = await call('/api/v1/auth/refresh', { method: 'POST', cookie: rotated });
    expect(after.status).toBe(401);
  });

  it('logout denies the access token immediately', async () => {
    const { token, cookie } = await signIn();

    expect((await call('/api/v1/auth/me', { token })).status).toBe(200);

    const out = await call('/api/v1/auth/logout', { method: 'POST', token, cookie });
    expect(out.status).toBe(204);

    // An access token is stateless, so this only works because of the denylist.
    const after = await call('/api/v1/auth/me', { token });
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('TOKEN_REVOKED');
  });
});

describe('account lockout', () => {
  it('locks the account after the configured number of failures', async () => {
    // A fresh user, so the shared one is not left locked for other cases.
    const username = '__apitest_lockout__';
    const password = 'LockoutTestPassw0rd!';

    const id = await transaction(SYSTEM_ACTOR, async (uow) => {
      const hash = await hashPassword(password);
      const existing = await uow.maybeOne<{ id: string }>(
        `SELECT id::text AS id FROM users WHERE lower(username) = $1`,
        [username],
      );
      if (existing) {
        await uow.count(
          `UPDATE users SET password_hash = $2, is_active = true, failed_attempts = 0,
                            locked_until = NULL, deleted_at = NULL
            WHERE id = $1`,
          [existing.id, hash],
        );
        return existing.id;
      }
      const created = await uow.one<{ id: string }>(
        `INSERT INTO users (username, password_hash, user_type, must_change_password, is_active)
         VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`,
        [username, hash],
      );
      return created.id;
    });

    // MAX_FAILED_LOGINS defaults to 5.
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await call('/api/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password: 'definitely-not-it' }),
      });
      expect(res.status).toBe(401);
    }

    // Now even the CORRECT password is refused, and the message changes —
    // which is safe, because the caller has already proved they can reach this
    // account's failure counter.
    const locked = await call('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    expect(locked.status).toBe(401);
    expect(locked.body.error.code).toBe('ACCOUNT_LOCKED');

    await transaction(SYSTEM_ACTOR, (uow) =>
      uow.count(`UPDATE users SET is_active = false, locked_until = NULL WHERE id = $1`, [id]),
    );
  });
});

describe('unknown routes', () => {
  it('returns the standard error envelope, not an HTML page', async () => {
    const res = await call('/api/v1/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.meta.requestId).toBeTypeOf('string');
  });
});
