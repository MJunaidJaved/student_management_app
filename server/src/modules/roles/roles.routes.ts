/**
 * Role and permission endpoints (Module 1).
 *
 * Permissions are read-only here by design: the catalogue is owned by
 * `PERMISSION_CATALOG` and the seed process, so there is no create or delete
 * endpoint. A permission that can be invented at runtime is a permission no
 * route requires and nothing enforces.
 */

import { z } from 'zod';
import type { RequestHandler } from 'express';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, text, optionalText } from '../../core/http/validate';
import { ok } from '../../core/http/envelope';
import { getRequestId } from '../../core/http/request-context';
import { currentUser } from '../../core/http/authenticate';
import { toActor } from '../../core/authz/permission-service';
import type { RolesService } from './roles.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

const createSchema = {
  body: z
    .object({
      name: text(60),
      description: optionalText(300),
      // A bounded array: Part 12 requires bulk input to be limited, and the
      // catalogue is 108 codes, so 300 is generous without being unbounded.
      permissions: z.array(z.string().max(80)).max(300).optional(),
    })
    .strict(),
};

const updateSchema = {
  params: z.object({ id: idParam }).strict(),
  body: z
    .object({
      name: text(60).optional(),
      description: optionalText(300).nullable(),
    })
    .strict()
    // Rejects an empty PATCH, which would otherwise be a silent no-op the
    // caller reads as success.
    .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to change.'),
};

const setPermissionsSchema = {
  params: z.object({ id: idParam }).strict(),
  body: z
    .object({ permissions: z.array(z.string().max(80)).max(300) })
    .strict(),
};

export function roleRoutes(roles: RolesService): RouteDeclaration[] {
  const handler =
    (fn: (req: Parameters<RequestHandler>[0]) => Promise<{ status: number; body: unknown }>): RequestHandler =>
    (req, res, next) => {
      void fn(req)
        .then(({ status, body }) => {
          if (status === 204) res.status(204).send();
          else res.status(status).json(ok(body, getRequestId()));
        })
        .catch(next);
    };

  return [
    {
      method: 'get',
      path: '/',
      summary: 'List all roles with their user and permission counts',
      permission: 'roles.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => ({
        status: 200,
        body: { roles: await roles.list(toActor(currentUser(req))) },
      })),
      errors: ['PERMISSION_DENIED'],
    },
    {
      method: 'get',
      path: '/:id',
      summary: 'One role with its full permission list',
      permission: 'roles.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return { status: 200, body: await roles.get(toActor(currentUser(req)), params.id) };
      }),
      errors: ['NOT_FOUND', 'PERMISSION_DENIED'],
    },
    {
      method: 'post',
      path: '/',
      summary: 'Create a role',
      permission: 'roles.create',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: createSchema,
      handler: handler(async (req) => {
        const { body } = validated<typeof createSchema>(req);
        return {
          status: 201,
          body: await roles.create(toActor(currentUser(req)), body),
        };
      }),
      errors: ['ROLE_NAME_TAKEN', 'UNKNOWN_PERMISSION', 'VALIDATION_FAILED'],
    },
    {
      method: 'patch',
      path: '/:id',
      summary: 'Rename a role or change its description',
      permission: 'roles.update',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: updateSchema,
      handler: handler(async (req) => {
        const { params, body } = validated<typeof updateSchema>(req);
        return {
          status: 200,
          body: await roles.update(toActor(currentUser(req)), params.id, body),
        };
      }),
      errors: ['SYSTEM_ROLE_IMMUTABLE', 'ROLE_NAME_TAKEN', 'NOT_FOUND'],
    },
    {
      method: 'put',
      path: '/:id/permissions',
      summary: 'Replace a role’s permission set',
      permission: 'roles.update',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: setPermissionsSchema,
      handler: handler(async (req) => {
        const { params, body } = validated<typeof setPermissionsSchema>(req);
        return {
          status: 200,
          body: await roles.setPermissions(toActor(currentUser(req)), params.id, body.permissions),
        };
      }),
      errors: ['SUPER_ADMIN_PROTECTED', 'UNKNOWN_PERMISSION', 'NOT_FOUND'],
    },
    {
      method: 'delete',
      path: '/:id',
      summary: 'Delete a non-system role that no user holds',
      permission: 'roles.delete',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await roles.delete(toActor(currentUser(req)), params.id);
        return { status: 204, body: null };
      }),
      errors: ['SYSTEM_ROLE_IMMUTABLE', 'ROLE_IN_USE', 'NOT_FOUND'],
    },
  ];
}

export function permissionRoutes(roles: RolesService): RouteDeclaration[] {
  return [
    {
      method: 'get',
      path: '/',
      summary: 'The permission catalogue, grouped by module',
      permission: 'permissions.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: (req, res, next) => {
        void roles
          .listPermissions(toActor(currentUser(req)))
          .then((modules) => res.status(200).json(ok({ modules }, getRequestId())))
          .catch(next);
      },
      errors: ['PERMISSION_DENIED'],
    },
  ];
}
