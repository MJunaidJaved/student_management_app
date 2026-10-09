import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text } from '../../core/http/validate';
import { handler, actorOf, okBody } from '../../core/base/base-controller';
import type { AttendanceService } from './attendance.service';

const timeOfDay = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Must be HH:MM or HH:MM:SS.');

const studentStatus = z.enum(['present', 'absent', 'late', 'leave']);
const staffStatus = z.enum(['present', 'absent', 'late', 'leave', 'half_day']);

const submitStudentSheetBody = z
  .object({
    sectionId: idParam,
    academicYearId: idParam,
    date: isoDate,
    reason: text(200).optional(),
    entries: z
      .array(z.object({ enrollmentId: idParam, status: studentStatus, remarks: text(200).optional() }).strict())
      .min(1)
      .max(500),
  })
  .strict();

const submitStaffSheetBody = z
  .object({
    date: isoDate,
    reason: text(200).optional(),
    entries: z
      .array(
        z
          .object({ staffId: idParam, status: staffStatus, checkIn: timeOfDay.optional(), checkOut: timeOfDay.optional() })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();

const dateRangeQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
}).strict();

export function attendanceRoutes(attendance: AttendanceService): RouteDeclaration[] {
  return [
    /* ---------------- student attendance ---------------- */
    {
      method: 'get',
      path: '/attendance/students/sections/:sectionId/years/:yearId',
      summary: "Get a section's attendance sheet for a date",
      permission: 'attendance.read',
      ownership: 'teacher-sections',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ sectionId: idParam, yearId: idParam }).strict(),
        query: z.object({ date: isoDate }).strict(),
      },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { sectionId, yearId } = params as { sectionId: string; yearId: string };
        const { date } = query as { date: string };
        return okBody({ sheet: await attendance.getStudentSheet(actorOf(req), sectionId, yearId, date) });
      }),
    },
    {
      method: 'post',
      path: '/attendance/students/submit',
      summary: "Submit a whole section's attendance sheet (bulk upsert)",
      permission: 'attendance.mark',
      ownership: 'teacher-sections',
      rateLimit: 'userStandard',
      schemas: { body: submitStudentSheetBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof submitStudentSheetBody }>(req);
        return okBody(await attendance.submitStudentSheet(actorOf(req), body));
      }),
      errors: ['NOT_A_SCHOOL_DAY', 'INVALID_ENROLLMENT_IN_BATCH'],
    },
    {
      method: 'get',
      path: '/attendance/students/enrollments/:enrollmentId',
      summary: "An enrollment's attendance history",
      permission: 'attendance.read',
      ownership: 'student-self',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ enrollmentId: idParam }).strict(), query: dateRangeQuery },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { enrollmentId } = params as { enrollmentId: string };
        const { from, to, limit, cursor } = query as { from?: string; to?: string; limit: number; cursor?: string };
        return okBody(await attendance.getEnrollmentHistory(actorOf(req), enrollmentId, { from, to }, { limit, cursor }));
      }),
    },
    {
      method: 'get',
      path: '/attendance/students/enrollments/:enrollmentId/summary',
      summary: "An enrollment's attendance percentage over a date range",
      permission: 'attendance.read',
      ownership: 'student-self',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ enrollmentId: idParam }).strict(), query: z.object({ from: isoDate, to: isoDate }).strict() },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { enrollmentId } = params as { enrollmentId: string };
        return okBody(await attendance.getStudentSummary(actorOf(req), enrollmentId, query as { from: string; to: string }));
      }),
    },
    {
      method: 'get',
      path: '/attendance/students/sections/:sectionId/years/:yearId/summary',
      summary: "A section's daily attendance counts",
      permission: 'attendance.read',
      ownership: 'teacher-sections',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ sectionId: idParam, yearId: idParam }).strict(), query: z.object({ date: isoDate }).strict() },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { sectionId, yearId } = params as { sectionId: string; yearId: string };
        const { date } = query as { date: string };
        return okBody(await attendance.getSectionSummary(actorOf(req), sectionId, yearId, date));
      }),
    },
    {
      method: 'get',
      path: '/attendance/students/sections/:sectionId/years/:yearId/defaulters',
      summary: 'Enrollments below an attendance percentage threshold over a range',
      permission: 'attendance.read',
      ownership: 'teacher-sections',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ sectionId: idParam, yearId: idParam }).strict(),
        query: z.object({ from: isoDate, to: isoDate, threshold: z.coerce.number().min(0).max(100).default(75) }).strict(),
      },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { sectionId, yearId } = params as { sectionId: string; yearId: string };
        const { from, to, threshold } = query as { from: string; to: string; threshold: number };
        return okBody({ defaulters: await attendance.getDefaulters(actorOf(req), sectionId, yearId, { from, to }, threshold) });
      }),
    },

    /* ---------------- staff attendance ---------------- */
    {
      method: 'get',
      path: '/attendance/staff',
      summary: "The staff attendance sheet for a date",
      permission: 'attendance.read_staff',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        query: z.object({ date: isoDate, departmentId: idParam.optional(), designationId: idParam.optional() }).strict(),
      },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        const { date, departmentId, designationId } = query as { date: string; departmentId?: string; designationId?: string };
        return okBody({ sheet: await attendance.getStaffSheet(actorOf(req), date, { departmentId, designationId }) });
      }),
    },
    {
      method: 'post',
      path: '/attendance/staff/submit',
      summary: "Submit staff attendance for a date (bulk upsert)",
      permission: 'attendance.mark_staff',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: submitStaffSheetBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof submitStaffSheetBody }>(req);
        return okBody(await attendance.submitStaffSheet(actorOf(req), body));
      }),
      errors: ['NOT_A_SCHOOL_DAY', 'STAFF_NOT_ACTIVE'],
    },
    {
      method: 'get',
      path: '/attendance/staff/:staffId',
      summary: "A staff member's attendance history",
      // staff.read_own, not attendance.read_staff: every staff-ish role holds
      // it for self-service, and the service narrows to self unless the
      // caller also holds attendance.read_staff (or is admin).
      permission: 'staff.read_own',
      ownership: 'staff-self-or-hr',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ staffId: idParam }).strict(), query: dateRangeQuery },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { staffId } = params as { staffId: string };
        const { from, to, limit, cursor } = query as { from?: string; to?: string; limit: number; cursor?: string };
        return okBody(await attendance.getStaffHistory(actorOf(req), staffId, { from, to }, { limit, cursor }));
      }),
    },
    {
      method: 'get',
      path: '/attendance/staff/:staffId/summary',
      summary: "A staff member's attendance summary over a date range",
      permission: 'staff.read_own',
      ownership: 'staff-self-or-hr',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ staffId: idParam }).strict(), query: z.object({ from: isoDate, to: isoDate }).strict() },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { staffId } = params as { staffId: string };
        return okBody(await attendance.getStaffSummary(actorOf(req), staffId, query as { from: string; to: string }));
      }),
    },
  ];
}
