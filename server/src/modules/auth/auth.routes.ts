/**
 * Auth endpoints (Part 12: every declaration sits next to its route).
 *
 * Refresh tokens travel in an httpOnly cookie, not the response body. The
 * access token goes in the body for the client to hold in memory. That split is
 * deliberate: the refresh token is the long-lived credential, so keeping it out
 * of JavaScript's reach limits what an XSS bug can steal to a token that
 * expires in fifteen minutes.
 */

import { z } from 'zod';
import type { RequestHandler } from 'express';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validate, validated, text } from '../../core/http/validate';
import { ok } from '../../core/http/envelope';
import { getRequestId, getContext } from '../../core/http/request-context';
import { currentUser } from '../../core/http/authenticate';
import { config } from '../../core/config';
import { verifyAccessToken } from '../../core/auth/tokens';
import type { AuthService } from './auth.service';
import { toActor } from '../../core/authz/permission-service';

export const REFRESH_COOKIE = 'sms_refresh';

const loginSchema = {
  body: z
    .object({
      username: text(100),
      password: z.string().min(1, 'Required.').max(200),
    })
    .strict(),
};

const changePasswordSchema = {
  body: z
    .object({
      currentPassword: z.string().min(1, 'Required.').max(200),
      newPassword: z.string().min(1, 'Required.').max(200),
    })
    .strict(),
};

/** Cookie options. Secure only in production, where the connection is HTTPS. */
function refreshCookieOptions(): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    // 'lax' rather than 'strict': the refresh endpoint is called by the app's
    // own fetch, and 'strict' breaks the token surviving a normal navigation
    // back into the app.
    sameSite: 'lax',
    secure: config.isProduction,
    path: '/',
    maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  };
}

export function authRoutes(auth: AuthService): RouteDeclaration[] {
  const loginHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      const { body } = validated<typeof loginSchema>(req);
      const ctx = getContext();
      const pair = await auth.login(body.username, body.password, {
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      });

      res.cookie(REFRESH_COOKIE, pair.refreshToken, refreshCookieOptions());
      res.status(200).json(
        ok(
          {
            accessToken: pair.accessToken,
            expiresIn: pair.expiresIn,
            mustChangePassword: pair.mustChangePassword,
          },
          getRequestId(),
        ),
      );
    })().catch(next);
  };

  const refreshHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      // Body is accepted as a fallback for non-browser clients that cannot hold
      // a cookie; the cookie wins when both are present.
      const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
      const fromBody = (req.body as { refreshToken?: unknown } | undefined)?.refreshToken;
      const token = fromCookie ?? (typeof fromBody === 'string' ? fromBody : undefined);

      if (!token) {
        res.status(401).json({
          error: { code: 'INVALID_REFRESH', message: 'Your session has expired. Sign in again.' },
          meta: { requestId: getRequestId() },
        });
        return;
      }

      const ctx = getContext();
      const pair = await auth.refresh(token, {
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent ?? null,
      });

      res.cookie(REFRESH_COOKIE, pair.refreshToken, refreshCookieOptions());
      res.status(200).json(
        ok(
          {
            accessToken: pair.accessToken,
            expiresIn: pair.expiresIn,
            mustChangePassword: pair.mustChangePassword,
          },
          getRequestId(),
        ),
      );
    })().catch(next);
  };

  const logoutHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      const user = currentUser(req);
      const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE] ?? null;

      // The jti is needed to deny this specific access token; it is only in the
      // token itself, which has already been verified by the middleware.
      const header = req.header('authorization');
      let jti: string | null = null;
      if (header?.startsWith('Bearer ')) {
        try {
          jti = verifyAccessToken(header.slice(7).trim()).jti;
        } catch {
          jti = null;
        }
      }

      await auth.logout(token, jti, toActor(user));
      res.clearCookie(REFRESH_COOKIE, { path: '/' });
      res.status(204).send();
    })().catch(next);
  };

  const logoutAllHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      const user = currentUser(req);
      const result = await auth.logoutAll(toActor(user));
      res.clearCookie(REFRESH_COOKIE, { path: '/' });
      res.status(200).json(ok(result, getRequestId()));
    })().catch(next);
  };

  const changePasswordHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      const { body } = validated<typeof changePasswordSchema>(req);
      const user = currentUser(req);
      await auth.changePassword(toActor(user), body.currentPassword, body.newPassword);
      res.clearCookie(REFRESH_COOKIE, { path: '/' });
      res.status(200).json(
        ok({ changed: true, signedOutEverywhere: true }, getRequestId()),
      );
    })().catch(next);
  };

  const meHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      const user = currentUser(req);
      res.status(200).json(ok(await auth.me(toActor(user)), getRequestId()));
    })().catch(next);
  };

  const permissionsHandler: RequestHandler = (req, res, next) => {
    void (async () => {
      const user = currentUser(req);
      const me = await auth.me(toActor(user));
      res.status(200).json(ok({ permissions: me.permissions }, getRequestId()));
    })().catch(next);
  };

  return [
    {
      method: 'post',
      path: '/login',
      summary: 'Sign in with a username and password',
      public: true,
      reason: 'Part 13 public list: a caller cannot authenticate before signing in.',
      rateLimit: 'auth',
      schemas: loginSchema,
      handler: loginHandler,
      errors: ['LOGIN_FAILED', 'ACCOUNT_LOCKED', 'VALIDATION_FAILED', 'RATE_LIMITED'],
    },
    {
      method: 'post',
      path: '/refresh',
      summary: 'Exchange a refresh token for a new access token',
      public: true,
      reason: 'Part 13 public list: the access token is expired by definition here.',
      rateLimit: 'auth',
      handler: refreshHandler,
      errors: ['INVALID_REFRESH', 'REFRESH_REUSE', 'RATE_LIMITED'],
    },
    {
      method: 'post',
      path: '/logout',
      summary: 'Revoke the current session',
      authenticatedOnly: true,
      reason: 'Ends only the session of the caller. A Guardian or Student holds no administrative permission.',
      ownership: 'self-only',
      rateLimit: 'userStandard',
      handler: logoutHandler,
      errors: ['UNAUTHENTICATED'],
    },
    {
      method: 'post',
      path: '/logout-all',
      summary: 'Revoke every session for the current user',
      authenticatedOnly: true,
      reason: 'Scoped entirely to the account of the caller. Portal roles hold no administrative permission.',
      ownership: 'self-only',
      rateLimit: 'userStandard',
      handler: logoutAllHandler,
      errors: ['UNAUTHENTICATED'],
    },
    {
      method: 'post',
      path: '/change-password',
      summary: 'Change your own password',
      authenticatedOnly: true,
      reason: 'Scoped entirely to the account of the caller. Portal roles hold no administrative permission.',
      ownership: 'self-only',
      rateLimit: 'auth',
      schemas: changePasswordSchema,
      handler: changePasswordHandler,
      errors: ['VALIDATION_FAILED', 'UNAUTHENTICATED'],
    },
    {
      method: 'get',
      path: '/me',
      summary: 'The current user, their roles and effective permissions',
      authenticatedOnly: true,
      reason: 'Scoped entirely to the account of the caller. Portal roles hold no administrative permission.',
      ownership: 'self-only',
      rateLimit: 'userStandard',
      handler: meHandler,
      errors: ['UNAUTHENTICATED'],
    },
    {
      method: 'get',
      path: '/permissions',
      summary: 'The effective permission codes of the current user',
      authenticatedOnly: true,
      reason: 'Scoped entirely to the account of the caller. Portal roles hold no administrative permission.',
      ownership: 'self-only',
      rateLimit: 'userStandard',
      handler: permissionsHandler,
      errors: ['UNAUTHENTICATED'],
    },
  ];
}

