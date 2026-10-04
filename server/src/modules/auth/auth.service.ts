/**
 * Authentication (Part 6).
 *
 * **The structural rule in this file: a side effect that must survive a
 * rejection cannot share a transaction with the rejection.**
 *
 * This was a real bug caught by the API tests, and it is worth spelling out
 * because it is invisible on reading. The obvious shape is one transaction that
 * reads the user, increments the failed-attempt counter, writes the audit row
 * and then throws `UnauthorizedError`. It looks correct and it silently does
 * nothing: throwing rolls the transaction back, so the counter never rises and
 * the account never locks. The same shape broke refresh-token theft handling —
 * `revokeFamily` was undone by the very error it was responding to, leaving the
 * stolen token chain alive.
 *
 * So every failure path here commits its side effects first, in their own
 * transaction, and throws afterwards. Login costs a few short transactions
 * instead of one; it is not a hot path, and correctness is the whole point.
 *
 * The other two invariants:
 *
 *   * **No user enumeration.** Every failure returns one message, and a missing
 *     username still pays for an argon2 verification, because otherwise the
 *     response time alone says which usernames exist.
 *
 *   * **Refresh tokens rotate and are marked used, not deleted.** A used token
 *     presented again is therefore detectable, and the response is to revoke
 *     the whole family — the thief's branch and the victim's — because there is
 *     no way to tell which holder is which.
 */

import { config } from '../../core/config';
import { SYSTEM_ACTOR, readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { UnauthorizedError, ValidationError } from '../../core/errors';
import { securityLogger } from '../../core/logging/logger';
import {
  assertPasswordAcceptable,
  burnPasswordTime,
  hashPassword,
  verifyPassword,
} from '../../core/auth/password';
import {
  generateRefreshToken,
  hashRefreshToken,
  newTokenFamily,
  refreshTokenExpiry,
  signAccessToken,
} from '../../core/auth/tokens';
import type { PermissionService } from '../../core/authz/permission-service';
import type { AuthAuditAction, AuthRepository, UserWithSecret } from './auth.repository';
import type { TokenDenylistStore } from '../../core/auth/token-denylist';

/** One message for every login failure. Never says which part was wrong. */
const LOGIN_FAILED = 'The username or password is incorrect.';

export type LoginContext = { ip: string | null; userAgent: string | null };

export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
  mustChangePassword: boolean;
};

export class AuthService {
  constructor(
    private readonly users: AuthRepository,
    private readonly permissions: PermissionService,
    private readonly denylist: TokenDenylistStore,
  ) {}

  /** Commit one audit row on its own, so a later throw cannot undo it. */
  private async audit(
    userId: string | null,
    event: AuthAuditAction,
    ip: string | null,
    detail?: Record<string, unknown>,
  ): Promise<void> {
    await transaction(SYSTEM_ACTOR, (uow) =>
      this.users.writeAuthAudit(uow, { userId, event, ip, ...(detail ? { detail } : {}) }),
    );
  }

  async login(username: string, password: string, ctx: LoginContext): Promise<TokenPair> {
    const user = await readTransaction(SYSTEM_ACTOR, (uow) =>
      this.users.findByUsernameWithSecret(uow, username),
    );

    if (!user) {
      // Pay the same CPU cost as a real verification before answering.
      await burnPasswordTime(password);
      await this.audit(null, 'login_failed', ctx.ip, { username, reason: 'no_such_user' });
      securityLogger.warn({ username, ip: ctx.ip }, 'Login failed: unknown username');
      throw new UnauthorizedError(LOGIN_FAILED, 'LOGIN_FAILED');
    }

    // Checked before the password so a locked account cannot be used as a
    // password oracle by timing which guesses are slower.
    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      await this.audit(user.id, 'login_blocked_locked', ctx.ip);
      throw new UnauthorizedError(
        'This account is temporarily locked after too many failed attempts. Try again later.',
        'ACCOUNT_LOCKED',
      );
    }

    if (!user.isActive) {
      await this.audit(user.id, 'login_blocked_inactive', ctx.ip);
      // The generic message: whether an account is deactivated is information
      // about the school's staffing.
      throw new UnauthorizedError(LOGIN_FAILED, 'LOGIN_FAILED');
    }

    if (!(await verifyPassword(password, user.passwordHash))) {
      // Its own transaction, which commits. Inside the login transaction this
      // increment was rolled back by the throw below and the account never
      // locked.
      const result = await transaction(SYSTEM_ACTOR, (uow) =>
        this.users.recordFailedAttempt(
          uow,
          user.id,
          config.MAX_FAILED_LOGINS,
          config.ACCOUNT_LOCK_MINUTES,
        ),
      );

      await this.audit(
        user.id,
        result.lockedUntil ? 'account_locked' : 'login_failed',
        ctx.ip,
        { failedAttempts: result.failedAttempts },
      );
      securityLogger.warn(
        { userId: user.id, ip: ctx.ip, failedAttempts: result.failedAttempts },
        result.lockedUntil ? 'Account locked after repeated failures' : 'Login failed: bad password',
      );
      throw new UnauthorizedError(LOGIN_FAILED, 'LOGIN_FAILED');
    }

    const pair = await transaction(SYSTEM_ACTOR, async (uow) => {
      await this.users.recordSuccessfulLogin(uow, user.id);
      return this.issueTokens(uow, user, newTokenFamily(), ctx);
    });

    await this.audit(user.id, 'login', ctx.ip, { userAgent: ctx.userAgent });
    return pair;
  }

  /**
   * Exchange a refresh token for a new pair.
   *
   * A token already marked used means either a network retry or a second
   * holder. There is no way to distinguish them, so it is treated as theft.
   * The revocation commits before the error is thrown; when it shared the
   * transaction with the throw, the stolen chain stayed valid.
   */
  async refresh(refreshToken: string, ctx: LoginContext): Promise<TokenPair> {
    const tokenHash = hashRefreshToken(refreshToken);

    type Outcome =
      | { kind: 'ok'; pair: TokenPair; userId: string }
      | { kind: 'reuse'; userId: string; familyId: string; revoked: number }
      | { kind: 'invalid' };

    const outcome = await transaction<Outcome>(SYSTEM_ACTOR, async (uow) => {
      const stored = await this.users.lockRefreshTokenByHash(uow, tokenHash);
      if (!stored) return { kind: 'invalid' };

      if (stored.usedAt) {
        // Committed with this transaction, because it returns rather than throws.
        const revoked = await this.users.revokeFamily(uow, stored.familyId, 'reuse_detected');
        return { kind: 'reuse', userId: stored.userId, familyId: stored.familyId, revoked };
      }

      if (stored.revokedAt || new Date(stored.expiresAt) <= new Date()) {
        return { kind: 'invalid' };
      }

      const user = await this.users.findByIdWithSecret(uow, stored.userId);
      if (!user || !user.isActive) {
        await this.users.revokeFamily(uow, stored.familyId, 'user_inactive');
        return { kind: 'invalid' };
      }

      await this.users.markRefreshTokenUsed(uow, stored.id);
      return {
        kind: 'ok',
        pair: await this.issueTokens(uow, user, stored.familyId, ctx),
        userId: user.id,
      };
    });

    if (outcome.kind === 'reuse') {
      await this.audit(outcome.userId, 'refresh_token_reuse', ctx.ip, {
        familyId: outcome.familyId,
        tokensRevoked: outcome.revoked,
      });
      securityLogger.error(
        { userId: outcome.userId, familyId: outcome.familyId, ip: ctx.ip, revoked: outcome.revoked },
        'Refresh token reuse detected; family revoked',
      );
      // Every access token of that user is denied too: the thief may hold one,
      // and it would otherwise keep working until it expired.
      await this.denylist.revokeAllForUser(outcome.userId);
      throw new UnauthorizedError(
        'Your session was ended for security reasons. Sign in again.',
        'REFRESH_REUSE',
      );
    }

    if (outcome.kind === 'invalid') {
      securityLogger.warn({ ip: ctx.ip }, 'Refresh failed: token not usable');
      throw new UnauthorizedError('Your session has expired. Sign in again.', 'INVALID_REFRESH');
    }

    return outcome.pair;
  }

  /** Revoke the current session: this refresh token's family, and this access token. */
  async logout(refreshToken: string | null, accessJti: string | null, actor: Actor): Promise<void> {
    await transaction(actor, async (uow) => {
      if (refreshToken) {
        const stored = await this.users.lockRefreshTokenByHash(uow, hashRefreshToken(refreshToken));
        if (stored) await this.users.revokeFamily(uow, stored.familyId, 'logout');
      }
    });

    await this.audit(actor.userId === null ? null : String(actor.userId), 'logout', null);

    // The access token is stateless, so it has to be denied explicitly or it
    // keeps working until it expires.
    if (accessJti) await this.denylist.revoke(accessJti);
  }

  async logoutAll(actor: Actor): Promise<{ revoked: number }> {
    const userId = String(actor.userId);
    const revoked = await transaction(actor, (uow) =>
      this.users.revokeAllForUser(uow, userId, 'logout_all'),
    );
    await this.audit(userId, 'logout_all', null, { tokensRevoked: revoked });
    await this.denylist.revokeAllForUser(userId);
    return { revoked };
  }

  /**
   * Change your own password.
   *
   * The current password is required even though the caller is authenticated: a
   * stolen access token must not be enough to take the account over
   * permanently. Every other session is revoked afterwards, which is what makes
   * a password change a real response to a suspected compromise.
   */
  async changePassword(actor: Actor, currentPassword: string, newPassword: string): Promise<void> {
    const userId = String(actor.userId);

    const user = await readTransaction(actor, (uow) => this.users.findByIdWithSecret(uow, userId));
    if (!user) throw new UnauthorizedError('Sign in again.');

    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      await this.audit(userId, 'password_change_failed', null);
      throw new ValidationError('That is not your current password.', [
        { field: 'currentPassword', message: 'Incorrect.' },
      ]);
    }

    assertPasswordAcceptable(newPassword, { username: user.username });

    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new ValidationError('The new password must be different.', [
        { field: 'newPassword', message: 'Must not be your current password.' },
      ]);
    }

    const hash = await hashPassword(newPassword);
    await transaction(actor, async (uow) => {
      await this.users.setPassword(uow, userId, hash);
      await this.users.revokeAllForUser(uow, userId, 'password_changed');
    });

    await this.audit(userId, 'password_changed', null);
    await this.denylist.revokeAllForUser(userId);
    securityLogger.info({ userId }, 'Password changed; all sessions revoked');
  }

  /** The `/me` payload: identity, roles and effective permissions. */
  async me(actor: Actor): Promise<{
    user: { id: string; username: string; userType: string; mustChangePassword: boolean };
    roles: { id: string; name: string }[];
    permissions: string[];
  }> {
    const userId = String(actor.userId);
    const [user, roles, permissions] = await Promise.all([
      readTransaction(actor, (uow) => this.users.findById(uow, userId)),
      this.permissions.rolesForUser(userId),
      this.permissions.forUser(userId),
    ]);
    if (!user) throw new UnauthorizedError('Sign in again.');

    return {
      user: {
        id: user.id,
        username: user.username,
        userType: user.userType,
        mustChangePassword: user.mustChangePassword,
      },
      roles,
      // Sorted so two responses can be diffed meaningfully.
      permissions: [...permissions].sort(),
    };
  }

  /** Mint an access/refresh pair and store the refresh hash. */
  private async issueTokens(
    uow: Uow,
    user: UserWithSecret,
    familyId: string,
    ctx: LoginContext,
  ): Promise<TokenPair> {
    const { token: refreshToken, hash } = generateRefreshToken();

    await this.users.insertRefreshToken(uow, {
      userId: user.id,
      familyId,
      tokenHash: hash,
      expiresAt: refreshTokenExpiry(),
      userAgent: ctx.userAgent,
      ip: ctx.ip,
    });

    const { token: accessToken, expiresIn } = signAccessToken({
      sub: user.id,
      userType: user.userType,
      staffId: user.staffId ?? undefined,
      guardianId: user.guardianId ?? undefined,
      studentId: user.studentId ?? undefined,
      // Reserved for the 2FA/forced-reissue design in Part 6.4.
      sessionEpoch: 0,
    });

    return { accessToken, refreshToken, expiresIn, mustChangePassword: user.mustChangePassword };
  }
}
