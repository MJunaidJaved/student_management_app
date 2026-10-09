import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text, phone, email } from '../../core/http/validate';
import { handler, actorOf, created, okBody, noContent } from '../../core/base/base-controller';
import type { StaffService } from './staff.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

const staffBody = z
  .object({
    fullName: text(100),
    gender: z.enum(['male', 'female', 'other']),
    dob: isoDate,
    phone: phone,
    joinDate: isoDate,
    nationalId: text(20).nullable().optional(),
    email: email.nullable().optional(),
    address: text(200).nullable().optional(),
    departmentId: idParam.nullable().optional(),
    designationId: idParam.nullable().optional(),
  })
  .strict();

const departmentBody = z.object({ name: text(80) }).strict();
const designationBody = z
  .object({ name: text(80), departmentId: idParam.nullable().optional() })
  .strict();

export function staffRoutes(staff: StaffService): RouteDeclaration[] {
  return [
    /* ---------------- departments ---------------- */
    {
      method: 'get',
      path: '/departments',
      summary: 'List departments',
      permission: 'staff.manage_departments',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ departments: await staff.listDepartments(actorOf(req)) })),
    },
    {
      method: 'post',
      path: '/departments',
      summary: 'Create a department',
      permission: 'staff.manage_departments',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: departmentBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof departmentBody }>(req);
        return created(await staff.createDepartment(actorOf(req), body.name));
      }),
    },
    {
      method: 'patch',
      path: '/departments/:id',
      summary: 'Rename a department',
      permission: 'staff.manage_departments',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), body: departmentBody },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: typeof departmentBody }>(req);
        return okBody(await staff.updateDepartment(actorOf(req), (params as { id: string }).id, body.name));
      }),
    },
    {
      method: 'delete',
      path: '/departments/:id',
      summary: 'Delete a department with no staff or designations attached',
      permission: 'staff.manage_departments',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await staff.deleteDepartment(actorOf(req), params.id);
        return noContent();
      }),
      errors: ['DEPARTMENT_IN_USE'],
    },

    /* ---------------- designations ---------------- */
    {
      method: 'get',
      path: '/designations',
      summary: 'List designations',
      permission: 'staff.manage_departments',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ designations: await staff.listDesignations(actorOf(req)) })),
    },
    {
      method: 'post',
      path: '/designations',
      summary: 'Create a designation',
      permission: 'staff.manage_departments',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: designationBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof designationBody }>(req);
        return created(await staff.createDesignation(actorOf(req), body));
      }),
    },
    {
      method: 'patch',
      path: '/designations/:id',
      summary: 'Edit a designation',
      permission: 'staff.manage_departments',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: designationBody.partial().refine((b) => Object.keys(b).length > 0, 'Provide a field to change.'),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        return okBody(
          await staff.updateDesignation(actorOf(req), (params as { id: string }).id, body as { name?: string; departmentId?: string | null }),
        );
      }),
    },
    {
      method: 'delete',
      path: '/designations/:id',
      summary: 'Delete a designation with no staff attached',
      permission: 'staff.manage_departments',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await staff.deleteDesignation(actorOf(req), params.id);
        return noContent();
      }),
      errors: ['DESIGNATION_IN_USE'],
    },

    /* ---------------- staff ---------------- */
    {
      method: 'get',
      path: '/staff/:id',
      summary: 'Get a staff profile',
      permission: 'staff.read',
      ownership: 'staff-self-or-hr',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody(await staff.getById(actorOf(req), params.id));
      }),
    },
    {
      method: 'get',
      path: '/staff',
      summary: 'List staff with filters',
      permission: 'staff.read',
      ownership: 'none', // HR-wide listing; no per-record scope narrower than the permission.
      rateLimit: 'userStandard',
      schemas: {
        query: z.object({
          departmentId: idParam.optional(),
          designationId: idParam.optional(),
          status: text(20).optional(),
          gender: text(10).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().optional(),
        }).strict(),
      },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        const { limit, cursor, ...filters } = query as {
          limit: number;
          cursor?: string;
          departmentId?: string;
          designationId?: string;
          status?: string;
          gender?: string;
        };
        return okBody(await staff.list(actorOf(req), filters, { limit, cursor }));
      }),
    },
    {
      method: 'get',
      path: '/staff-search',
      summary: 'Search staff by employee number, phone, national ID or name',
      permission: 'staff.search',
      ownership: 'none',
      rateLimit: 'search',
      schemas: {
        query: z.object({
          q: z.string().min(1).max(100),
          limit: z.coerce.number().int().min(1).max(50).default(10),
          typeahead: z
            .union([z.boolean(), z.enum(['true', 'false'])])
            .transform((v) => v === true || v === 'true')
            .optional(),
        }).strict(),
      },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        const q = (query as { q: string }).q;
        const limit = (query as { limit: number }).limit;
        const typeahead = (query as { typeahead?: boolean }).typeahead;
        return okBody(await staff.search(actorOf(req), q, { limit, ...(typeahead !== undefined && { typeahead }) }));
      }),
    },
    {
      method: 'post',
      path: '/staff',
      summary: 'Create a staff record',
      permission: 'staff.create',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: staffBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof staffBody }>(req);
        return created(await staff.create(actorOf(req), body));
      }),
      errors: ['STAFF_EXISTS'],
    },
    {
      method: 'patch',
      path: '/staff/:id',
      summary: 'Edit a staff record',
      permission: 'staff.update',
      ownership: 'staff-self-or-hr',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: staffBody.partial().refine((b) => Object.keys(b).length > 0, 'Provide a field to change.'),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        return okBody(await staff.update(actorOf(req), (params as { id: string }).id, body as Record<string, unknown>));
      }),
    },
    {
      method: 'post',
      path: '/staff/:id/deactivate',
      summary: 'Record a resignation or termination',
      permission: 'staff.deactivate',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: z
          .object({
            status: z.enum(['resigned', 'terminated']),
            separationDate: isoDate,
            reason: text(200).optional(),
          })
          .strict(),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        const input = body as { status: 'resigned' | 'terminated'; separationDate: string; reason?: string };
        return okBody(await staff.deactivate(actorOf(req), (params as { id: string }).id, input));
      }),
      errors: ['STAFF_NOT_ACTIVE'],
    },
    {
      method: 'delete',
      path: '/staff/:id',
      summary: 'Soft-delete a staff record with no history',
      permission: 'staff.delete',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await staff.softDelete(actorOf(req), params.id);
        return noContent();
      }),
      errors: ['STAFF_HAS_HISTORY'],
    },
  ];
}
