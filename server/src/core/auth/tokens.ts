/**
 * Access and refresh tokens (Part 6.2).
 *
 * Access tokens are stateless JWTs, short-lived, and deliberately carry NO
 * permission list. Permissions are loaded server-side from cache on every
 * request instead. Putting them in the token would make the token
 * self-sufficient and therefore impossible to correct: revoke a role and the
 * holder keeps it until expiry. The cost is a cache lookup per request; the
 * benefit is that privilege changes take effect in seconds.
 *
 * Refresh tokens are the opposite: opaque random bytes, stored server-side as a
 * hash, and revocable. They are not JWTs because the entire point is that the
 * server decides whether they are still valid.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { config } from '../config';
import { UnauthorizedError } from '../errors';
import type { UserType } from '../db/uow';

/** What an access token asserts. Small on purpose. */
export type AccessTokenClaims = {
  /** users.id, as a string because JWT numeric precision is not worth risking. */
  sub: string;
  userType: UserType;
  /** The linked person record, so the policy layer need not re-query for scope. */
  staffId?: string | undefined;
  guardianId?: string | undefined;
  studentId?: string | undefined;
  /**
   * Token id. Present so a single access token can be added to the denylist on
   * logout, rather than having to wait out its TTL.
   */
  jti: string;
  /**
   * Forces re-login when a password changes or an account is deactivated: the
   * value is compared against the user's current one and a mismatch rejects the
   * token, without needing to enumerate and revoke issued tokens.
   */
  sessionEpoch: number;
};

const ISSUER = 'school-api';

export function signAccessToken(claims: Omit<AccessTokenClaims, 'jti'>): {
  token: string;
  jti: string;
  expiresIn: string;
} {
  const jti = randomUUID();
  const token = jwt.sign({ ...claims, jti }, config.JWT_ACCESS_SECRET, {
    issuer: ISSUER,
    expiresIn: config.ACCESS_TOKEN_TTL,
    // HS256 explicitly. Leaving the algorithm to the library's default is how
    // an "alg: none" or algorithm-confusion bug gets in.
    algorithm: 'HS256',
  } as jwt.SignOptions);
  return { token, jti, expiresIn: config.ACCESS_TOKEN_TTL };
}

/**
 * Verify an access token.
 *
 * `algorithms` is pinned so a token cannot dictate how it is checked. Every
 * failure — expired, malformed, wrong signature, wrong issuer — becomes the
 * same 401 with the same message; distinguishing them tells a caller which
 * part of their forgery to fix.
 */
export function verifyAccessToken(token: string): AccessTokenClaims {
  let payload: JwtPayload | string;
  try {
    payload = jwt.verify(token, config.JWT_ACCESS_SECRET, {
      issuer: ISSUER,
      algorithms: ['HS256'],
    });
  } catch {
    throw new UnauthorizedError('Your session is not valid. Sign in again.', 'INVALID_TOKEN');
  }

  if (typeof payload === 'string' || !payload.sub || typeof payload.jti !== 'string') {
    throw new UnauthorizedError('Your session is not valid. Sign in again.', 'INVALID_TOKEN');
  }

  return {
    sub: String(payload.sub),
    userType: payload.userType as UserType,
    staffId: payload.staffId as string | undefined,
    guardianId: payload.guardianId as string | undefined,
    studentId: payload.studentId as string | undefined,
    jti: payload.jti,
    sessionEpoch: Number(payload.sessionEpoch ?? 0),
  };
}

/* ------------------------------------------------------------------ *
 * Refresh tokens
 * ------------------------------------------------------------------ */

/**
 * A new refresh token: 32 random bytes, and the hash to store.
 *
 * The plaintext is returned to the caller once and never persisted. The hash is
 * what goes in `refresh_tokens.token_hash`, so a leaked database dump does not
 * yield usable tokens.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/**
 * SHA-256, not argon2, and deliberately so.
 *
 * A slow hash protects low-entropy secrets that can be guessed. This token is
 * 256 bits of CSPRNG output, so there is no guess space to protect — and
 * refresh runs on a hot path where a deliberately slow hash buys nothing and
 * costs latency on every rotation.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A new token family, created once per login; rotation stays within it. */
export const newTokenFamily = (): string => randomUUID();

/** Expiry for a freshly issued refresh token. */
export function refreshTokenExpiry(now = new Date()): Date {
  const expires = new Date(now);
  expires.setDate(expires.getDate() + config.REFRESH_TOKEN_TTL_DAYS);
  return expires;
}
