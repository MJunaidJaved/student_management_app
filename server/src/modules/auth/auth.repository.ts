/**
 * Data access for users and refresh tokens.
 *
 * Queries only; the login rules live in auth.service.
 */

import type { Uow } from '../../core/db/uow';
import type { ResolvedUser } from '../../core/authz/permission-service';
import type { UserType } from '../../core/db/uow';

/** The columns needed to resolve an actor. Never selects password_hash. */
const USER_COLUMNS = `
  id::text            AS id,
  username,
  user_type           AS "userType",
  staff_id::text      AS "staffId",
  guardian_id::text   AS "guardianId",
  student_id::text    AS "studentId",
  is_active           AS "isActive",
  must_change_password AS "mustChangePassword",
  locked_until::text  AS "lockedUntil"`;

export type UserWithSecret = ResolvedUser & {
  passwordHash: string;
  failedAttempts: number;
};

export class AuthRepository {
  /** By id, for the authenticate middleware. */
  async findById(uow: Uow, id: string): Promise<ResolvedUser | null> {
    return uow.maybeOne<ResolvedUser>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  }

  /**
   * By username, including the hash, for login only.
   *
   * `lower(username)` on both sides: usernames are unique case-insensitively in
   * practice (Module 1), and matching case-sensitively would let "Ali" and
   * "ali" both exist and confuse everyone.
   */
  async findByUsernameWithSecret(uow: Uow, username: string): Promise<UserWithSecret | null> {
    return uow.maybeOne<UserWithSecret>(
      `SELECT ${USER_COLUMNS},
              password_hash    AS "passwordHash",
              failed_attempts  AS "failedAttempts"
         FROM users
        WHERE lower(username) = lower($1) AND deleted_at IS NULL`,
      [username],
    );
  }

  async findByIdWithSecret(uow: Uow, id: string): Promise<UserWithSecret | null> {
    return uow.maybeOne<UserWithSecret>(
      `SELECT ${USER_COLUMNS},
              password_hash    AS "passwordHash",
              failed_attempts  AS "failedAttempts"
         FROM users
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
  }

  /** Count a failed attempt, locking the account when the threshold is reached. */
  async recordFailedAttempt(
    uow: Uow,
    userId: string,
    maxAttempts: number,
    lockMinutes: number,
  ): Promise<{ failedAttempts: number; lockedUntil: string | null }> {
    // Increment and decide the lock in one statement, so two simultaneous
    // wrong passwords cannot both read "4" and leave the account unlocked.
    return uow.one<{ failedAttempts: number; lockedUntil: string | null }>(
      `UPDATE users
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE
                WHEN failed_attempts + 1 >= $2
                THEN now() + make_interval(mins => $3)
                ELSE locked_until END
        WHERE id = $1
        RETURNING failed_attempts AS "failedAttempts", locked_until::text AS "lockedUntil"`,
      [userId, maxAttempts, lockMinutes],
    );
  }

  async recordSuccessfulLogin(uow: Uow, userId: string): Promise<void> {
    await uow.count(
      `UPDATE users
          SET failed_attempts = 0, locked_until = NULL, last_login_at = now()
        WHERE id = $1`,
      [userId],
    );
  }

  async setPassword(uow: Uow, userId: string, passwordHash: string): Promise<void> {
    await uow.count(
      `UPDATE users
          SET password_hash = $2, must_change_password = false,
              failed_attempts = 0, locked_until = NULL
        WHERE id = $1`,
      [userId, passwordHash],
    );
  }

  async setTemporaryPassword(uow: Uow, userId: string, passwordHash: string): Promise<void> {
    await uow.count(
      `UPDATE users
          SET password_hash = $2, must_change_password = true,
              failed_attempts = 0, locked_until = NULL
        WHERE id = $1`,
      [userId, passwordHash],
    );
  }

  /* ---------------- refresh tokens ---------------- */

  async insertRefreshToken(
    uow: Uow,
    input: {
      userId: string;
      familyId: string;
      tokenHash: string;
      expiresAt: Date;
      userAgent: string | null;
      ip: string | null;
    },
  ): Promise<string> {
    const row = await uow.one<{ id: string }>(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id::text AS id`,
      [
        input.userId,
        input.familyId,
        input.tokenHash,
        input.expiresAt.toISOString(),
        input.userAgent,
        input.ip,
      ],
    );
    return row.id;
  }

  /**
   * Find a refresh token by hash, locked.
   *
   * `FOR UPDATE` matters: two simultaneous refreshes with the same token must
   * not both succeed. The loser waits, then sees `used_at` set and is treated
   * as a replay.
   */
  async lockRefreshTokenByHash(
    uow: Uow,
    tokenHash: string,
  ): Promise<{
    id: string;
    userId: string;
    familyId: string;
    expiresAt: string;
    usedAt: string | null;
    revokedAt: string | null;
  } | null> {
    return uow.maybeOne(
      `SELECT id::text        AS id,
              user_id::text   AS "userId",
              family_id::text AS "familyId",
              expires_at::text AS "expiresAt",
              used_at::text   AS "usedAt",
              revoked_at::text AS "revokedAt"
         FROM refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [tokenHash],
    );
  }

  async markRefreshTokenUsed(uow: Uow, id: string): Promise<void> {
    await uow.count(`UPDATE refresh_tokens SET used_at = now() WHERE id = $1`, [id]);
  }

  /**
   * Revoke every live token in a family.
   *
   * Called when a used token is presented again — the signature of theft. The
   * thief and the legitimate holder both lose the chain, which is the intended
   * outcome: one re-login is a smaller cost than a persistent intruder.
   */
  async revokeFamily(uow: Uow, familyId: string, reason: string): Promise<number> {
    return uow.count(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = $2
        WHERE family_id = $1 AND revoked_at IS NULL`,
      [familyId, reason],
    );
  }

  async revokeAllForUser(uow: Uow, userId: string, reason: string): Promise<number> {
    return uow.count(
      `UPDATE refresh_tokens
          SET revoked_at = now(), revoked_reason = $2
        WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId, reason],
    );
  }

  /** Remove expired and long-revoked rows. Run from a scheduled job. */
  async pruneRefreshTokens(uow: Uow): Promise<number> {
    return uow.count(
      `DELETE FROM refresh_tokens
        WHERE expires_at < now() - interval '30 days'
           OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days')`,
    );
  }

  /* ---------------- audit ---------------- */

  /**
   * Write an authentication event (Part 6.5).
   *
   * Straight into `audit_logs` rather than through a trigger: these events are
   * not row changes, so no trigger fires for them. `user_id` is nullable, which
   * is what lets a failed login against an unknown username still be recorded.
   *
   * **Why the event name is not written to `action`.** The schema constrains
   * `audit_logs.action` to exactly six values:
   *
   *     insert, update, delete, login, logout, login_failed
   *
   * Part 6.5 asks for lockouts, password changes and password resets to be
   * recorded as well, and none of those is in that list. Widening the CHECK is
   * a schema change, which needs approval, so instead the event is mapped onto
   * the nearest permitted `action` and its real name is stored in
   * `new_values->>'event'`.
   *
   * Nothing is lost — every event is still recorded and queryable by
   * `new_values->>'event'` — but a filter on `action` is coarser than it would
   * otherwise be. See docs/schema-proposals.md for the constraint change that
   * would fix that properly.
   */
  async writeAuthAudit(uow: Uow, event: AuthAuditEvent): Promise<void> {
    await uow.count(
      `INSERT INTO audit_logs (user_id, action, table_name, record_id, new_values, ip_address)
       VALUES ($1::bigint, $2, 'users', $3::text, $4::jsonb, $5::inet)`,
      [
        event.userId,
        AUDIT_ACTION_FOR[event.event],
        event.userId,
        // The event name always; never a password, token or hash.
        JSON.stringify({ event: event.event, ...(event.detail ?? {}) }),
        event.ip,
      ],
    );
  }
}

/** The values `audit_logs_action_check` permits, after migration 005. */
type AuditAction =
  | 'insert'
  | 'update'
  | 'delete'
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'account_locked'
  | 'account_unlocked'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'refresh_token_reuse'
  | 'permission_denied';

/**
 * The authentication events recorded, and the `action` each is stored under.
 *
 * Keyed so adding an event without deciding its mapping is a type error.
 *
 * Migration 005 widened the CHECK, so most events now map to themselves and are
 * queryable by an indexed equality on `action`. A few still fold into a broader
 * value because they are variations on one outcome rather than distinct events
 * worth their own constraint entry — `login_blocked_locked` and
 * `login_blocked_inactive` are both "the sign-in was refused", and
 * `new_values->>'event'` still records which.
 */
const AUDIT_ACTION_FOR = {
  login: 'login',
  login_failed: 'login_failed',
  login_blocked_locked: 'login_failed',
  login_blocked_inactive: 'login_failed',

  logout: 'logout',
  logout_all: 'logout',

  // These now have their own action values.
  account_locked: 'account_locked',
  account_unlocked: 'account_unlocked',
  password_changed: 'password_changed',
  password_reset_requested: 'password_reset_requested',
  password_reset_completed: 'password_reset_completed',
  password_reset_by_admin: 'password_reset_completed',
  refresh_token_reuse: 'refresh_token_reuse',

  // A failed attempt to change a password is a refused authentication, not a
  // change; recording it as password_changed would overstate what happened.
  password_change_failed: 'login_failed',

  super_admin_seeded: 'insert',
} as const satisfies Record<string, AuditAction>;

export type AuthAuditAction = keyof typeof AUDIT_ACTION_FOR;

export type AuthAuditEvent = {
  userId: string | null;
  event: AuthAuditAction;
  ip: string | null;
  detail?: Record<string, unknown>;
};

export type CreateUserInput = {
  username: string;
  email: string | null;
  phone: string | null;
  passwordHash: string;
  userType: UserType;
  staffId: string | null;
  guardianId: string | null;
  studentId: string | null;
};
