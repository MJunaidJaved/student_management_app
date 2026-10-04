/**
 * Authentication and permission middleware.
 *
 * Authentication resolves the bearer token to a user and publishes the actor
 * into the request context, which is what the transaction helper later hands to
 * the database session variables. Authorization checks one permission code.
 *
 * The must-change-password gate lives here rather than in each route. Part 6.1
 * says an account with a temporary password may do nothing but change it and
 * log out, and enforcing that per-route would mean remembering it on every new
 * endpoint forever. Here it is one allow-list.
 */

import type { RequestHandler } from 'express';
import { ForbiddenError, UnauthorizedError } from '../errors';
import { securityLogger } from '../logging/logger';
import { setContextActor } from './request-context';
import { verifyAccessToken } from '../auth/tokens';
import { toActor, type PermissionService, type ResolvedUser } from '../authz/permission-service';

/** Looks a user up by id. Injected so this module needs no repository import. */
export type UserLookup = (userId: string) => Promise<ResolvedUser | null>;

/** Checks whether a specific access token has been revoked (logout). */
export type TokenDenylist = { isRevoked(jti: string): Promise<boolean> };

/**
 * The only routes reachable while a password change is outstanding.
 *
 * Matched on the declared path, not the raw URL, so a query string cannot
 * smuggle past it.
 */
const PASSWORD_CHANGE_ALLOWED = new Set([
  'POST /api/v1/auth/change-password',
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/logout-all',
  'GET /api/v1/auth/me',
]);

export function makeAuthenticate(deps: {
  lookupUser: UserLookup;
  denylist: TokenDenylist;
}): RequestHandler {
  return (req, _res, next) => {
    void (async () => {
      const header = req.header('authorization');
      if (!header?.startsWith('Bearer ')) {
        throw new UnauthorizedError('Sign in to continue.');
      }

      const claims = verifyAccessToken(header.slice(7).trim());

      // Logout has to take effect immediately, and an access token is
      // stateless, so revocation needs this lookup.
      if (await deps.denylist.isRevoked(claims.jti)) {
        throw new UnauthorizedError('Your session has ended. Sign in again.', 'TOKEN_REVOKED');
      }

      const user = await deps.lookupUser(claims.sub);

      /*
       * A token can outlive the state it was issued against. Each of these is
       * checked on every request rather than trusted from the token, because
       * the whole reason permissions are not in the token is that the token
       * cannot be corrected after issue.
       */
      if (!user) {
        // The user was deleted. Same answer as an invalid token: a distinct
        // message would confirm the id had once existed.
        throw new UnauthorizedError('Your session is not valid. Sign in again.', 'INVALID_TOKEN');
      }
      if (!user.isActive) {
        securityLogger.warn({ userId: user.id }, 'Rejected request from deactivated account');
        throw new UnauthorizedError('This account is not active.', 'ACCOUNT_INACTIVE');
      }
      if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
        throw new UnauthorizedError('This account is temporarily locked.', 'ACCOUNT_LOCKED');
      }

      if (user.mustChangePassword) {
        const declared = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`.replace(
          /\/$/,
          '',
        );
        if (!PASSWORD_CHANGE_ALLOWED.has(declared)) {
          throw new ForbiddenError(
            'You must change your password before using the system.',
            'PASSWORD_CHANGE_REQUIRED',
          );
        }
      }

      const actor = toActor(user);
      setContextActor(actor);
      // Attached for the controllers; the database session identity travels
      // through the request context, not through this.
      (req as unknown as { user: ResolvedUser }).user = user;
    })().then(() => next(), next);
  };
}

/** Read the authenticated user in a controller. Throws if the route is public. */
export function currentUser(req: unknown): ResolvedUser {
  const user = (req as { user?: ResolvedUser }).user;
  if (!user) {
    throw new Error(
      'currentUser() called on a request with no authentication. ' +
        'Either the route is public or the middleware order is wrong.',
    );
  }
  return user;
}

/**
 * Require one permission code.
 *
 * A denial is logged to the security channel with the code and the route, so
 * "who keeps trying to reverse payments" is answerable. The response names the
 * missing permission: the caller is authenticated, and telling them which
 * permission they lack reveals nothing they could not learn by asking their
 * administrator, while saving a support round trip.
 */
export function makeRequirePermission(permissions: PermissionService) {
  return (code: string): RequestHandler =>
    (req, _res, next) => {
      void (async () => {
        const user = currentUser(req);
        if (!(await permissions.has(user.id, code))) {
          securityLogger.warn(
            { userId: user.id, permission: code, route: req.originalUrl, method: req.method },
            'Permission denied',
          );
          throw new ForbiddenError(
            `You do not have permission to do that (${code} required).`,
            'PERMISSION_DENIED',
          );
        }
      })().then(() => next(), next);
    };
}
