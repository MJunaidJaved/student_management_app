/**
 * Route declarations, and the startup audit over them (Part 12, Part 7.1).
 *
 * Every route is declared as data — method, path, permission, ownership
 * policy, rate-limit tier, validation schemas — and the middleware chain is
 * built *from* that declaration. Nothing else mounts handlers.
 *
 * The reason is the deny-by-default rule. If a route could be added with
 * `router.get(...)` directly, then forgetting the permission middleware would
 * produce a working, unprotected endpoint, and nothing would say so. Here,
 * omitting `permission` is a type error unless the route is explicitly marked
 * `public: true` — and every public route ends up in one list that the security
 * review in Part 13 can read at a glance.
 *
 * The registry also makes the startup check possible: `auditRoutes()` compares
 * what Express actually mounted against what was declared, so a route that
 * slipped in by another path fails the boot rather than serving traffic.
 */

import { Router, type RequestHandler } from 'express';
import { PERMISSION_CODES } from '../authz/permission-catalog';
import type { RateLimitTier } from '../rate-limit/rate-limiter';
import type { RequestSchemas } from './validate';

export type HttpMethod = 'get' | 'post' | 'patch' | 'put' | 'delete';

/**
 * How a route decides whether the caller may touch *this* record.
 *
 * `'none'` is for endpoints with no per-record scope (listing permission
 * codes). Everything that takes an id from the client needs a real policy —
 * with RLS disabled this is the only barrier, so Part 13 requires each one to
 * be named explicitly rather than defaulted.
 */
export type OwnershipPolicy =
  | 'none'
  | 'self-only'
  | 'guardian-children'
  | 'student-self'
  | 'teacher-sections'
  | 'staff-self-or-hr'
  | 'admin-only';

type BaseDeclaration = {
  method: HttpMethod;
  /** Path within the router this is mounted on. */
  path: string;
  /** One line for the OpenAPI summary and the route audit. */
  summary: string;
  rateLimit: RateLimitTier;
  schemas?: RequestSchemas;
  handler: RequestHandler;
  /** Error codes this route can return, for the generated docs. */
  errors?: readonly string[];
};

/** A protected route: authentication, a permission, and an ownership policy. */
export type ProtectedRoute = BaseDeclaration & {
  public?: false | undefined;
  permission: string;
  ownership: OwnershipPolicy;
};

/**
 * An unauthenticated route.
 *
 * `reason` is mandatory. Part 13 lists exactly which endpoints may be public,
 * and requiring a written justification here means the audit output explains
 * itself instead of just listing paths.
 */
export type PublicRoute = BaseDeclaration & {
  public: true;
  reason: string;
};

/**
 * Authenticated, but gated by no permission code.
 *
 * This exists because tying self-service to a permission was wrong, and the
 * API tests caught it. `/auth/me` was declared as requiring `settings.read` on
 * the reasoning that every account holds it — but the Guardian role holds only
 * `fees.read_own` and the leave codes, and Student holds even less. So portal
 * users could sign in and then could not read their own profile, change their
 * password, or log out.
 *
 * The honest model is that a few endpoints are scoped entirely to the caller
 * and need no permission at all: reading your own identity, changing your own
 * password, ending your own session. `ownership` is still mandatory and still
 * has to be `self-only`, and the route audit lists these separately so Part
 * 13's review can see every one of them at a glance.
 */
export type SelfServiceRoute = BaseDeclaration & {
  public?: false | undefined;
  authenticatedOnly: true;
  /** Why no permission applies. Forces the reasoning to be written down. */
  reason: string;
  ownership: 'self-only';
};

export type RouteDeclaration = ProtectedRoute | PublicRoute | SelfServiceRoute;

/*
 * Generic over the input so narrowing keeps whatever else the value carries.
 * A guard written as `(r: RouteDeclaration) => r is PublicRoute` discards the
 * `mountPath`/`fullPath` fields that `RegisteredRoute` adds, and the compiler
 * then reduces the other branch to `never`.
 */
const isPublic = <T extends RouteDeclaration>(r: T): r is T & PublicRoute => r.public === true;

const isSelfService = <T extends RouteDeclaration>(r: T): r is T & SelfServiceRoute =>
  r.public !== true && (r as SelfServiceRoute).authenticatedOnly === true;

/** A declaration plus where it ended up, for the audit. */
export type RegisteredRoute = RouteDeclaration & { mountPath: string; fullPath: string };

const registry: RegisteredRoute[] = [];

export const registeredRoutes = (): readonly RegisteredRoute[] => registry;

/** Test helper: the registry is module-global, so it needs clearing between suites. */
export const resetRegistry = (): void => {
  registry.length = 0;
};

/**
 * Dependencies the chain builder needs.
 *
 * Injected rather than imported so a test can mount a router with a null rate
 * limiter and a stub authorizer, per the dependency-injection rule in Part 4.4.
 */
export type RouteMiddleware = {
  authenticate: RequestHandler;
  requirePermission: (code: string) => RequestHandler;
  rateLimit: (tier: RateLimitTier) => RequestHandler;
  validate: (schemas: RequestSchemas) => RequestHandler;
};

/**
 * Build a router from declarations.
 *
 * Middleware order is deliberate and worth stating, because getting it wrong
 * is a security bug rather than a bug:
 *
 *   1. **Rate limit first.** It has to apply to unauthenticated floods too; put
 *      it after authentication and an attacker gets unlimited free attempts at
 *      the login endpoint.
 *   2. **Authenticate**, so the actor exists.
 *   3. **Permission**, which needs the actor.
 *   4. **Validate**, last before the handler. It is the most expensive step, so
 *      an unauthorised caller should never reach it — and a 401 is the more
 *      informative answer than a 422 about a body they were not allowed to send.
 *
 * Ownership is NOT middleware. It needs the record, which means a database
 * read, which belongs in the service inside the transaction. The declaration
 * records which policy the service must apply, and the audit checks that a
 * policy was named; enforcement lives in the policy layer.
 */
export function buildRouter(
  mountPath: string,
  declarations: readonly RouteDeclaration[],
  middleware: RouteMiddleware,
): Router {
  const router = Router();

  for (const route of declarations) {
    const id = `${route.method.toUpperCase()} ${mountPath}${route.path}`;

    if (!isPublic(route) && !isSelfService(route)) {
      if (!PERMISSION_CODES.has(route.permission)) {
        throw new Error(
          `Route ${id} requires unknown permission "${route.permission}". ` +
            'Add it to PERMISSION_CATALOG.',
        );
      }
      if (!route.ownership) {
        throw new Error(
          `Route ${id} declares no ownership policy. ` +
            "Use 'none' explicitly if the endpoint has no per-record scope.",
        );
      }
    }

    if (isSelfService(route) && !route.reason?.trim()) {
      throw new Error(`Route ${id} is authenticatedOnly but gives no reason.`);
    }

    const chain: RequestHandler[] = [middleware.rateLimit(route.rateLimit)];

    if (isSelfService(route)) {
      // Authentication, but no permission gate. The service still confines the
      // response to the caller's own record.
      chain.push(middleware.authenticate);
    } else if (!isPublic(route)) {
      chain.push(middleware.authenticate, middleware.requirePermission(route.permission));
    }
    if (route.schemas) {
      chain.push(middleware.validate(route.schemas));
    }
    chain.push(route.handler);

    router[route.method](route.path, ...chain);

    registry.push({
      ...route,
      mountPath,
      fullPath: `${mountPath}${route.path}`.replace(/\/+$/, '') || '/',
    });
  }

  return router;
}

export type RouteAuditProblem = { route: string; problem: string };

/**
 * The startup check Part 16 requires for Phase 2.
 *
 * Called before the server listens. Anything it returns is a boot failure, not
 * a warning — a route with no declared permission is reachable, and shipping it
 * while logging a warning nobody reads is how it stays reachable.
 */
export function auditRoutes(): {
  problems: RouteAuditProblem[];
  publicRoutes: RegisteredRoute[];
  selfServiceRoutes: RegisteredRoute[];
  protectedCount: number;
} {
  const problems: RouteAuditProblem[] = [];
  const publicRoutes: RegisteredRoute[] = [];
  const selfServiceRoutes: RegisteredRoute[] = [];
  let protectedCount = 0;

  const seen = new Map<string, RegisteredRoute>();

  for (const route of registry) {
    const id = `${route.method.toUpperCase()} ${route.fullPath}`;

    // Two handlers on one path means the second never runs, and which one wins
    // depends on mount order — invisible, and a plausible way for an
    // unprotected duplicate to shadow a protected route.
    if (seen.has(id)) {
      problems.push({ route: id, problem: 'declared more than once' });
    }
    seen.set(id, route);

    if (!route.rateLimit) {
      problems.push({ route: id, problem: 'declares no rate-limit tier' });
    }

    if (isPublic(route)) {
      publicRoutes.push(route);
      if (!route.reason?.trim()) {
        problems.push({ route: id, problem: 'is public but gives no reason' });
      }
      continue;
    }

    if (isSelfService(route)) {
      selfServiceRoutes.push(route);
      if (!route.reason?.trim()) {
        problems.push({ route: id, problem: 'is authenticatedOnly but gives no reason' });
      }
      // Anything wider than the caller's own record must go through a
      // permission; self-service is not a way to skip authorization.
      if (route.ownership !== 'self-only') {
        problems.push({
          route: id,
          problem: `is authenticatedOnly so ownership must be 'self-only', not '${route.ownership}'`,
        });
      }
      continue;
    }

    protectedCount += 1;

    if (!route.permission) {
      problems.push({ route: id, problem: 'declares no permission' });
    } else if (!PERMISSION_CODES.has(route.permission)) {
      problems.push({ route: id, problem: `requires unknown permission "${route.permission}"` });
    }
    if (!route.ownership) {
      problems.push({ route: id, problem: 'declares no ownership policy' });
    }
  }

  return { problems, publicRoutes, selfServiceRoutes, protectedCount };
}

/**
 * Permission codes that exist in the catalogue but no route requires.
 *
 * Not a failure — some are held for modules not yet built, and some are read by
 * the policy layer rather than by a route. It is reported so the gap between
 * "granted" and "enforced" stays visible instead of drifting quietly.
 */
export function unusedPermissions(): string[] {
  const required = new Set(
    registry
      .filter((r): r is RegisteredRoute & ProtectedRoute => !isPublic(r) && !isSelfService(r))
      .map((r) => r.permission),
  );
  return [...PERMISSION_CODES].filter((code) => !required.has(code)).sort();
}
