import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text } from '../../core/http/validate';
import { handler, actorOf, created, okBody, noContent } from '../../core/base/base-controller';
import type { LeaveService } from './leave.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

const leaveTypeBody = z
  .object({ name: text(60), appliesTo: z.enum(['student', 'staff', 'both']), daysPerYear: z.coerce.number().int().min(0).nullable().optional() })
  .strict();

const studentLeaveBody = z
  .object({ enrollmentId: idParam, leaveTypeId: idParam, fromDate: isoDate, toDate: isoDate, reason: text(300).optional() })
  .strict();

const staffLeaveBody = z
  .object({ leaveTypeId: idParam, fromDate: isoDate, toDate: isoDate, reason: text(300).optional() })
  .strict();

const balanceBody = z
  .object({ staffId: idParam, leaveTypeId: idParam, academicYearId: idParam, allotted: z.coerce.number().min(0).max(366) })
  .strict();

const listQuery = z
  .object({
    applicantType: z.enum(['student', 'staff']).optional(),
    status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
    staffId: idParam.optional(),
    enrollmentId: idParam.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export function leaveRoutes(leave: LeaveService): RouteDeclaration[] {
  return [
    /* ---------------- leave types ---------------- */
    {
      method: 'get',
      path: '/leave-types',
      summary: 'List leave types',
      permission: 'leave.manage_types',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ leaveTypes: await leave.listLeaveTypes(actorOf(req)) })),
    },
    {
      method: 'post',
      path: '/leave-types',
      summary: 'Create a leave type',
      permission: 'leave.manage_types',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: leaveTypeBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof leaveTypeBody }>(req);
        return created(await leave.createLeaveType(actorOf(req), body));
      }),
    },
    {
      method: 'patch',
      path: '/leave-types/:id',
      summary: 'Edit a leave type',
      permission: 'leave.manage_types',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), body: leaveTypeBody.partial().refine((b) => Object.keys(b).length > 0, 'Provide a field to change.') },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        return okBody(await leave.updateLeaveType(actorOf(req), (params as { id: string }).id, body as { name?: string; appliesTo?: string; daysPerYear?: number | null }));
      }),
    },
    {
      method: 'delete',
      path: '/leave-types/:id',
      summary: 'Delete a leave type with no requests or balances attached',
      permission: 'leave.manage_types',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await leave.deleteLeaveType(actorOf(req), params.id);
        return noContent();
      }),
      errors: ['LEAVE_TYPE_IN_USE'],
    },

    /* ---------------- staff leave balances ---------------- */
    {
      method: 'post',
      path: '/staff-leave-balances',
      summary: 'Set a staff member’s leave balance for a year',
      permission: 'leave.manage_balances',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: balanceBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof balanceBody }>(req);
        return created(await leave.setStaffLeaveBalance(actorOf(req), body));
      }),
    },
    {
      method: 'get',
      path: '/staff/:staffId/leave-balances',
      summary: 'A staff member’s leave balances',
      permission: 'leave.read_own',
      ownership: 'staff-self-or-hr',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ staffId: idParam }).strict(), query: z.object({ academicYearId: idParam.optional() }).strict() },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { staffId } = params as { staffId: string };
        const { academicYearId } = query as { academicYearId?: string };
        return okBody({ balances: await leave.getStaffLeaveBalances(actorOf(req), staffId, academicYearId) });
      }),
    },

    /* ---------------- requests ---------------- */
    {
      method: 'post',
      path: '/leave/student-requests',
      summary: 'Submit a student leave request',
      permission: 'leave.request',
      ownership: 'guardian-children',
      rateLimit: 'userStandard',
      schemas: { body: studentLeaveBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof studentLeaveBody }>(req);
        return created(await leave.submitStudentLeave(actorOf(req), body));
      }),
      errors: ['LEAVE_TYPE_MISMATCH', 'INVALID_RANGE', 'OVERLAPPING_LEAVE'],
    },
    {
      method: 'post',
      path: '/leave/staff-requests',
      summary: 'Submit your own staff leave request',
      permission: 'leave.request',
      ownership: 'self-only',
      authenticatedOnly: true,
      reason: 'A staff member always submits leave for themselves; the actor id, not a client-supplied id, decides whose record this is.',
      rateLimit: 'userStandard',
      schemas: { body: staffLeaveBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof staffLeaveBody }>(req);
        return created(await leave.submitStaffLeave(actorOf(req), body));
      }),
      errors: ['LEAVE_TYPE_MISMATCH', 'INVALID_RANGE', 'OVERLAPPING_LEAVE'],
    },
    {
      method: 'get',
      path: '/leave/requests',
      summary: 'List leave requests within your scope',
      permission: 'leave.read_own',
      ownership: 'none', // The service narrows scope itself; see listRequests.
      rateLimit: 'userStandard',
      schemas: { query: listQuery },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        const { limit, cursor, ...filters } = query as z.infer<typeof listQuery>;
        return okBody(await leave.listRequests(actorOf(req), filters, { limit, cursor }));
      }),
    },
    {
      method: 'get',
      path: '/leave/requests/:id',
      summary: 'Get a leave request',
      permission: 'leave.read_own',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody(await leave.getRequest(actorOf(req), params.id));
      }),
    },
    {
      method: 'post',
      path: '/leave/student-requests/:id/decide',
      summary: 'Approve or reject a student leave request',
      permission: 'leave.approve_student',
      ownership: 'teacher-sections',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), body: z.object({ decision: z.enum(['approved', 'rejected']) }).strict() },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        const { decision } = body as { decision: 'approved' | 'rejected' };
        return okBody(await leave.decideStudentLeave(actorOf(req), (params as { id: string }).id, decision));
      }),
      errors: ['WRONG_APPLICANT_TYPE', 'ILLEGAL_LEAVE_TRANSITION'],
    },
    {
      method: 'post',
      path: '/leave/staff-requests/:id/decide',
      summary: 'Approve or reject a staff leave request',
      permission: 'leave.approve_staff',
      ownership: 'admin-only',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), body: z.object({ decision: z.enum(['approved', 'rejected']) }).strict() },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        const { decision } = body as { decision: 'approved' | 'rejected' };
        return okBody(await leave.decideStaffLeave(actorOf(req), (params as { id: string }).id, decision));
      }),
      errors: ['WRONG_APPLICANT_TYPE', 'ILLEGAL_LEAVE_TRANSITION', 'INSUFFICIENT_BALANCE'],
    },
    {
      method: 'post',
      path: '/leave/requests/:id/cancel',
      summary: 'Cancel a pending request, or reverse an approved one',
      permission: 'leave.read_own',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody(await leave.cancelRequest(actorOf(req), params.id));
      }),
      errors: ['ILLEGAL_LEAVE_TRANSITION'],
    },
  ];
}
