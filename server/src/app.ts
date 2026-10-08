/**
 * The Express application.
 *
 * Middleware order here is load-bearing; see the comments on each block. The
 * route audit runs at the end of construction, before anything can listen, so
 * an undeclared permission stops the boot rather than serving traffic (Part
 * 7.1, Part 16 Phase 2).
 */

import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './core/config';
import { logger } from './core/logging/logger';
import { requestContext, getRequestId } from './core/http/request-context';
import { errorHandler, notFoundHandler } from './core/http/error-handler';
import { validate } from './core/http/validate';
import { rateLimit } from './core/rate-limit/rate-limiter';
import {
  auditRoutes,
  buildRouter,
  resetRegistry,
  unusedPermissions,
  type RouteMiddleware,
} from './core/http/route-registry';
import { makeAuthenticate, makeRequirePermission } from './core/http/authenticate';
import { ok } from './core/http/envelope';
import { authRoutes } from './modules/auth/auth.routes';
import { permissionRoutes, roleRoutes } from './modules/roles/roles.routes';
import { settingsRoutes } from './modules/settings/settings.routes';
import { auditRoutes as auditLogRoutes } from './modules/audit/audit.routes';
import { academicRoutes } from './modules/academic/academic.routes';
import { studentRoutes } from './modules/students/students.routes';
import { transaction, SYSTEM_ACTOR } from './core/db/uow';
import type { Container } from './container';

export function createApp(container: Container): Express {
  // The registry is module-global; building a second app in the same process
  // (as the tests do) would otherwise accumulate duplicate declarations and
  // fail the audit for the wrong reason.
  resetRegistry();

  const app = express();

  /*
   * Behind a reverse proxy, req.ip is the proxy unless this is set — which
   * would make every per-IP rate limit count the whole internet as one client.
   * Off by default because trusting the header when NOT behind a proxy lets a
   * caller spoof their own IP and bypass the same limits.
   */
  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());

  app.use(
    cors({
      // An explicit allow-list; config refuses to boot with a wildcard in
      // production. Credentials are on because the refresh token is a cookie.
      origin: config.CORS_ORIGINS.length ? config.CORS_ORIGINS : false,
      credentials: true,
      maxAge: 600,
    }),
  );

  // A body limit, so a large payload cannot be used to exhaust memory before
  // any validation runs.
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // Opens the async-local context, so every log line and response below this
  // point carries the same request id.
  app.use(requestContext);

  const middleware: RouteMiddleware = {
    authenticate: makeAuthenticate({
      lookupUser: (userId) =>
        transaction(SYSTEM_ACTOR, (uow) => container.repositories.auth.findById(uow, userId)),
      denylist: container.denylist,
    }),
    requirePermission: makeRequirePermission(container.permissions),
    rateLimit: (tier) => rateLimit(tier, container.rateLimiter),
    validate,
  };

  /*
   * Health and readiness (Part 12). Deliberately outside the route registry:
   * they are infrastructure, not API, and must answer before the database is
   * reachable so a failing deploy is diagnosable.
   *
   * Neither reveals anything: no version, no dependency detail, no error text.
   */
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/ready', (_req, res) => {
    void transaction(SYSTEM_ACTOR, (uow) => uow.one('SELECT 1 AS ok'))
      .then(() => res.status(200).json({ status: 'ready' }))
      .catch(() => {
        // The reason goes to the log, not to the caller.
        logger.warn('Readiness check failed: database unreachable');
        res.status(503).json({ status: 'not-ready' });
      });
  });

  const prefix = config.API_PREFIX;

  const mount = (segment: string, declarations: Parameters<typeof buildRouter>[1]): void => {
    app.use(`${prefix}${segment}`, buildRouter(`${prefix}${segment}`, declarations, middleware));
  };

  mount('/auth', authRoutes(container.services.auth));
  mount('/roles', roleRoutes(container.services.roles));
  mount('/permissions', permissionRoutes(container.services.roles));
  mount('/settings', settingsRoutes(container.services.settings));
  mount('/audit-logs', auditLogRoutes(container.services.audit));
  mount('/academic', academicRoutes(container.services.academic));
  mount('', studentRoutes(container.services.students));

  // A tiny authenticated endpoint that proves the whole chain works end to end.
  app.get(`${prefix}/ping`, middleware.rateLimit('global'), (_req, res) => {
    res.status(200).json(ok({ pong: true }, getRequestId()));
  });

  app.use(notFoundHandler);
  app.use(errorHandler);

  assertRoutesDeclared();

  return app;
}

/**
 * The startup check.
 *
 * A problem here is fatal. A route that is reachable without a declared
 * permission is a security hole, and starting anyway while logging a warning
 * is how it stays one.
 */
function assertRoutesDeclared(): void {
  const { problems, publicRoutes, selfServiceRoutes, protectedCount } = auditRoutes();

  if (problems.length) {
    const lines = problems.map((p) => `  - ${p.route}: ${p.problem}`).join('\n');
    throw new Error(`Route declaration check failed:\n${lines}`);
  }

  const describe = (r: { method: string; fullPath: string }): string =>
    `${r.method.toUpperCase()} ${r.fullPath}`;

  logger.info(
    {
      protectedRoutes: protectedCount,
      // Both lists are logged in full at boot so Part 13's review has the
      // complete set of unauthenticated and unauthorized endpoints to hand.
      publicRoutes: publicRoutes.map(describe),
      selfServiceRoutes: selfServiceRoutes.map(describe),
      permissionsNotYetEnforced: unusedPermissions().length,
    },
    'Route declaration check passed',
  );
}
