import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text } from '../../core/http/validate';
import { handler, actorOf, created, okBody, noContent } from '../../core/base/base-controller';
import type { StudentsService } from './students.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

const studentBody = z
  .object({
    firstName: text(50),
    lastName: text(50).nullable().optional(),
    gender: z.enum(['male', 'female', 'other']),
    dob: isoDate,
    admissionDate: isoDate,
    nationalId: text(20).nullable().optional(),
    phone: text(20).nullable().optional(),
    address: text(200).nullable().optional(),
    bloodGroup: z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']).nullable().optional(),
    religion: text(30).nullable().optional(),
    previousSchool: text(100).nullable().optional(),
  })
  .strict();

const guardianBody = z
  .object({
    fullName: text(100),
    phone: text(20),
    nationalId: text(20).nullable().optional(),
    email: text(100).nullable().optional(),
    occupation: text(50).nullable().optional(),
    address: text(200).nullable().optional(),
  })
  .strict();

const enrollmentBody = z
  .object({
    studentId: idParam,
    academicYearId: idParam,
    classId: idParam,
    sectionId: idParam,
    enrolledOn: isoDate,
    rollNo: z.coerce.number().int().min(1).optional(),
  })
  .strict();

const transferBody = z
  .object({
    sectionId: idParam,
    classId: idParam,
  })
  .strict();

const linkGuardianBody = z
  .object({
    studentId: idParam,
    guardianId: idParam,
    relation: text(30),
    isPrimary: z.boolean(),
    isFeePayer: z.boolean(),
  })
  .strict();

export function studentRoutes(students: StudentsService): RouteDeclaration[] {
  return [
    /* ---------------- students ---------------- */
    {
      method: 'get',
      path: '/students/:id',
      summary: 'Get full student profile',
      permission: 'students.read',
      ownership: 'student-self',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody(await students.getById(actorOf(req), params.id));
      }),
    },
    {
      method: 'get',
      path: '/students',
      summary: 'List students with filters',
      permission: 'students.read',
      ownership: 'none', // The service method handles scope narrowing.
      rateLimit: 'userStandard',
      schemas: {
        query: z.object({
          classId: idParam.optional(),
          sectionId: idParam.optional(),
          status: text(20).optional(),
          gender: text(10).optional(),
          academicYearId: idParam.optional(),
          guardianPhone: text(20).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          cursor: z.string().optional(),
        }).strict(),
      },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        const { limit, cursor, ...filters } = query as { limit: number; cursor?: string; classId?: string; sectionId?: string; status?: string; gender?: string; academicYearId?: string; guardianPhone?: string };
        return okBody(await students.list(actorOf(req), filters, { limit, cursor }));
      }),
    },
    {
      method: 'post',
      path: '/students',
      summary: 'Create a student record',
      permission: 'students.create',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: studentBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof studentBody }>(req);
        return created(await students.create(actorOf(req), body));
      }),
      errors: ['DOB_AFTER_ADMISSION'],
    },
    {
      method: 'patch',
      path: '/students/:id',
      summary: 'Edit a student record',
      permission: 'students.update',
      ownership: 'student-self',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: studentBody.partial().refine((b) => Object.keys(b).length > 0, 'Provide a field to change.'),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{
          params: z.ZodObject<{ id: typeof idParam }>;
          body: z.ZodTypeAny;
        }>(req);
        return okBody(await students.update(actorOf(req), params.id, body as Record<string, unknown>));
      }),
    },
    {
      method: 'delete',
      path: '/students/:id',
      summary: 'Soft-delete a student',
      permission: 'students.delete',
      ownership: 'student-self',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await students.softDelete(actorOf(req), params.id);
        return noContent();
      }),
      errors: ['STUDENT_HAS_HISTORY'],
    },
    {
      method: 'get',
      path: '/students/:id/siblings',
      summary: 'Get student siblings',
      permission: 'students.read',
      ownership: 'student-self',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody({ siblings: await students.siblingsOf(actorOf(req), params.id) });
      }),
    },
    {
      method: 'get',
      path: '/search',
      summary: 'Search students and guardians',
      permission: 'students.search',
      ownership: 'none',
      rateLimit: 'userStandard',
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
        return okBody(await students.search(actorOf(req), q, { limit, ...(typeahead !== undefined && { typeahead }) }));
      }),
    },

    /* ---------------- guardians ---------------- */
    {
      method: 'post',
      path: '/guardians',
      summary: 'Create a guardian',
      permission: 'guardians.create',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: guardianBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof guardianBody }>(req);
        return created(await students.createGuardian(actorOf(req), body));
      }),
      errors: ['GUARDIAN_EXISTS'],
    },
    {
      method: 'get',
      path: '/guardians/search',
      summary: 'Search guardians',
      permission: 'guardians.search',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        query: z.object({
          q: z.string().min(1).max(100),
          limit: z.coerce.number().int().min(1).max(50).default(10),
        }).strict(),
      },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        const { q, limit } = query as { q: string; limit: number };
        return okBody({ guardians: await students.searchGuardians(actorOf(req), q, limit) });
      }),
    },
    {
      method: 'post',
      path: '/student-guardians',
      summary: 'Link a guardian to a student',
      permission: 'students.update', // Updating the student's links
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: linkGuardianBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof linkGuardianBody }>(req);
        return okBody({ links: await students.linkGuardian(actorOf(req), body) });
      }),
    },
    {
      method: 'delete',
      path: '/students/:studentId/guardians/:guardianId',
      summary: 'Unlink a guardian',
      permission: 'students.update',
      ownership: 'none', // using None for now as studentId param requires custom mapping in base-controller if ownership="student"
      rateLimit: 'userStandard',
      schemas: { params: z.object({ studentId: idParam, guardianId: idParam }).strict() },
      handler: handler(async (req) => {
        const { params } = validated<{ params: z.ZodTypeAny }>(req);
        await students.unlinkGuardian(actorOf(req), params.studentId, params.guardianId);
        return noContent();
      }),
      errors: ['LAST_GUARDIAN', 'LAST_FEE_PAYER'],
    },

    /* ---------------- enrollments ---------------- */
    {
      method: 'post',
      path: '/enrollments',
      summary: 'Enroll a student',
      permission: 'students.manage_enrollments',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: enrollmentBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof enrollmentBody }>(req);
        return created(await students.enroll(actorOf(req), body));
      }),
      errors: ['SECTION_FULL', 'ALREADY_ENROLLED', 'SECTION_CLASS_MISMATCH'],
    },
    {
      method: 'post',
      path: '/enrollments/:id/transfer',
      summary: 'Transfer section',
      permission: 'students.manage_enrollments',
      ownership: 'none', // The service checks policies
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: transferBody,
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: typeof transferBody }>(req);
        return okBody(await students.transferSection(actorOf(req), params.id, body));
      }),
      errors: ['SAME_SECTION', 'SECTION_FULL'],
    },
    {
      method: 'get',
      path: '/sections/:sectionId/years/:yearId/class-list',
      summary: 'Class list for a section',
      permission: 'students.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ sectionId: idParam, yearId: idParam }).strict(),
      },
      handler: handler(async (req) => {
        const { params } = validated<{ params: z.ZodTypeAny }>(req);
        return okBody({ classList: await students.classList(actorOf(req), params.sectionId, params.yearId) });
      }),
    },
    {
      method: 'post',
      path: '/sections/:sectionId/years/:yearId/resort',
      summary: 'Resort roll numbers alphabetically',
      permission: 'students.manage_enrollments',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ sectionId: idParam, yearId: idParam }).strict(),
      },
      handler: handler(async (req) => {
        const { params } = validated<{ params: z.ZodTypeAny }>(req);
        return okBody(await students.resortRollNumbers(actorOf(req), params.sectionId, params.yearId));
      }),
    },

    /* ---------------- admissions ---------------- */
    {
      method: 'patch',
      path: '/applications/:id/status',
      summary: 'Set admission application status',
      permission: 'admissions.decide',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: z.object({ status: text(30), remarks: text(200).optional() }).strict(),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        const { status, remarks } = body as { status: 'test' | 'accepted' | 'enquiry' | 'applied' | 'rejected' | 'enrolled'; remarks?: string };
        return okBody(await students.setApplicationStatus(actorOf(req), (params as { id: string }).id, status, remarks));
      }),
      errors: ['USE_CONVERSION_ENDPOINT'],
    },
  ];
}
