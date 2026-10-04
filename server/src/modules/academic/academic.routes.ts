/**
 * Academic setup endpoints (Module 2).
 *
 * `ownership: 'none'` throughout, and that is correct rather than lazy: a
 * class, section, subject or room is school-wide configuration with no
 * per-record owner. Access is decided entirely by the permission code. The
 * endpoints that *do* carry per-record scope are in the students, attendance
 * and exams modules.
 */

import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text } from '../../core/http/validate';
import { handler, actorOf, created, okBody, noContent } from '../../core/base/base-controller';
import { SUBJECT_TYPES } from '../../core/db/enums';
import type { AcademicService } from './academic.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

const yearBody = z
  .object({ name: text(40), startDate: isoDate, endDate: isoDate })
  .strict();

const termBody = z
  .object({
    academicYearId: idParam,
    name: text(40),
    startDate: isoDate,
    endDate: isoDate,
  })
  .strict();

const classBody = z
  .object({
    name: text(40),
    // Orders the classes for promotion and reporting; bounded because it is an
    // ordinal, not an identifier.
    levelOrder: z.coerce.number().int().min(0).max(100),
  })
  .strict();

const sectionBody = z
  .object({
    classId: idParam,
    name: text(20),
    capacity: z.coerce.number().int().min(1).max(500),
    classTeacherId: idParam.nullable().optional(),
  })
  .strict();

const subjectBody = z
  .object({
    code: text(20),
    name: text(80),
    type: z.enum(SUBJECT_TYPES),
  })
  .strict();

const roomBody = z
  .object({
    name: text(40),
    roomType: text(30),
    capacity: z.coerce.number().int().min(1).max(1000).nullable().optional(),
  })
  .strict();

export function academicRoutes(academic: AcademicService): RouteDeclaration[] {
  return [
    /* ---------------- academic years ---------------- */
    {
      method: 'get',
      path: '/years',
      summary: 'List academic years',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ years: await academic.listYears(actorOf(req)) })),
    },
    {
      method: 'get',
      path: '/years/current',
      summary: 'The current academic year',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody(await academic.currentYear(actorOf(req)))),
      errors: ['NO_CURRENT_YEAR'],
    },
    {
      method: 'post',
      path: '/years',
      summary: 'Create an academic year',
      permission: 'academic.manage_years',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: yearBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof yearBody }>(req);
        return created(await academic.createYear(actorOf(req), body));
      }),
      errors: ['OVERLAPPING_YEAR', 'INVALID_RANGE'],
    },
    {
      method: 'patch',
      path: '/years/:id',
      summary: 'Edit an academic year',
      permission: 'academic.manage_years',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: yearBody.partial().refine((b) => Object.keys(b).length > 0, 'Provide a field to change.'),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{
          params: z.ZodObject<{ id: typeof idParam }>;
          body: z.ZodTypeAny;
        }>(req);
        return okBody(
          await academic.updateYear(actorOf(req), params.id, body as Record<string, never>),
        );
      }),
      errors: ['YEAR_CLOSED', 'OVERLAPPING_YEAR', 'TERM_OUTSIDE_YEAR'],
    },
    {
      method: 'post',
      path: '/years/:id/set-current',
      summary: 'Make this the current academic year',
      permission: 'academic.set_current_year',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody(await academic.setCurrentYear(actorOf(req), params.id));
      }),
      errors: ['YEAR_CLOSED', 'NOT_FOUND'],
    },
    {
      method: 'get',
      path: '/years/:id/closing-check',
      summary: 'What is preventing this academic year from being closed',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'expensive',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody(await academic.closingPreCheck(actorOf(req), params.id));
      }),
    },
    {
      method: 'post',
      path: '/years/:id/close',
      summary: 'Close an academic year, making it read-only',
      permission: 'academic.close_year',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody(await academic.closeYear(actorOf(req), params.id));
      }),
      errors: ['YEAR_NOT_CLOSEABLE', 'YEAR_IS_CURRENT'],
    },
    {
      method: 'post',
      path: '/years/:id/copy-setup-from/:fromId',
      summary: 'Copy subject-teacher assignments from another year',
      permission: 'academic.copy_setup',
      ownership: 'none',
      rateLimit: 'expensive',
      schemas: { params: z.object({ id: idParam, fromId: idParam }).strict() },
      handler: handler(async (req) => {
        const { params } = validated<{
          params: z.ZodObject<{ id: typeof idParam; fromId: typeof idParam }>;
        }>(req);
        return okBody(await academic.copySetupFromYear(actorOf(req), params.fromId, params.id));
      }),
      errors: ['SAME_YEAR', 'YEAR_CLOSED'],
    },

    /* ---------------- terms ---------------- */
    {
      method: 'get',
      path: '/years/:id/terms',
      summary: 'Terms of an academic year',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody({ terms: await academic.listTerms(actorOf(req), params.id) });
      }),
    },
    {
      method: 'post',
      path: '/terms',
      summary: 'Create a term inside an academic year',
      permission: 'academic.manage_years',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: termBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof termBody }>(req);
        return created(await academic.createTerm(actorOf(req), body));
      }),
      errors: ['TERM_OUTSIDE_YEAR', 'OVERLAPPING_TERM', 'YEAR_CLOSED'],
    },

    /* ---------------- classes ---------------- */
    {
      method: 'get',
      path: '/classes',
      summary: 'List classes in level order',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ classes: await academic.listClasses(actorOf(req)) })),
    },
    {
      method: 'post',
      path: '/classes',
      summary: 'Create a class',
      permission: 'academic.manage_classes',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: classBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof classBody }>(req);
        return created(await academic.createClass(actorOf(req), body));
      }),
    },
    {
      method: 'patch',
      path: '/classes/:id',
      summary: 'Rename a class or change its level order',
      permission: 'academic.manage_classes',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: classBody.partial().refine((b) => Object.keys(b).length > 0, 'Provide a field.'),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{
          params: z.ZodObject<{ id: typeof idParam }>;
          body: z.ZodTypeAny;
        }>(req);
        return okBody(
          await academic.updateClass(actorOf(req), params.id, body as Record<string, never>),
        );
      }),
    },
    {
      method: 'delete',
      path: '/classes/:id',
      summary: 'Soft-delete a class that nothing references',
      permission: 'academic.manage_classes',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await academic.deleteClass(actorOf(req), params.id);
        return noContent();
      }),
      errors: ['CLASS_IN_USE'],
    },

    /* ---------------- sections ---------------- */
    {
      method: 'get',
      path: '/sections',
      summary: 'Sections with current strength against capacity',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { query: z.object({ classId: idParam.optional() }).strict() },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodObject<{ classId: z.ZodOptional<typeof idParam> }> }>(req);
        return okBody({ sections: await academic.listSections(actorOf(req), query.classId) });
      }),
    },
    {
      method: 'post',
      path: '/sections',
      summary: 'Create a section',
      permission: 'academic.manage_classes',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: sectionBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof sectionBody }>(req);
        return created(await academic.createSection(actorOf(req), body));
      }),
    },
    {
      method: 'patch',
      path: '/sections/:id',
      summary: 'Edit a section, including its class teacher',
      permission: 'academic.manage_classes',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: z
          .object({
            name: text(20).optional(),
            capacity: z.coerce.number().int().min(1).max(500).optional(),
            classTeacherId: idParam.nullable().optional(),
          })
          .strict()
          .refine((b) => Object.keys(b).length > 0, 'Provide a field to change.'),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{
          params: z.ZodObject<{ id: typeof idParam }>;
          body: z.ZodTypeAny;
        }>(req);
        return okBody(
          await academic.updateSection(actorOf(req), params.id, body as Record<string, never>),
        );
      }),
      errors: ['CAPACITY_BELOW_STRENGTH'],
    },

    /* ---------------- subjects ---------------- */
    {
      method: 'get',
      path: '/subjects',
      summary: 'List subjects',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ subjects: await academic.listSubjects(actorOf(req)) })),
    },
    {
      method: 'post',
      path: '/subjects',
      summary: 'Create a subject',
      permission: 'academic.manage_subjects',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: subjectBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof subjectBody }>(req);
        return created(await academic.createSubject(actorOf(req), body));
      }),
    },
    {
      method: 'get',
      path: '/classes/:id/subjects',
      summary: 'Subjects a class studies',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody({ subjects: await academic.listClassSubjects(actorOf(req), params.id) });
      }),
    },
    {
      method: 'put',
      path: '/classes/:id/subjects',
      summary: 'Replace the subject list for a class',
      permission: 'academic.manage_subjects',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        body: z
          .object({
            subjects: z
              .array(z.object({ subjectId: idParam, isMandatory: z.boolean() }).strict())
              .max(60),
          })
          .strict(),
      },
      handler: handler(async (req) => {
        const { params, body } = validated<{
          params: z.ZodObject<{ id: typeof idParam }>;
          body: z.ZodTypeAny;
        }>(req);
        const input = body as { subjects: { subjectId: string; isMandatory: boolean }[] };
        return okBody({
          subjects: await academic.setClassSubjects(actorOf(req), params.id, input.subjects),
        });
      }),
    },

    /* ---------------- subject teachers ---------------- */
    {
      method: 'get',
      path: '/years/:id/subject-teachers',
      summary: 'Subject-teacher assignments for a year',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        params: z.object({ id: idParam }).strict(),
        query: z.object({ sectionId: idParam.optional(), staffId: idParam.optional() }).strict(),
      },
      handler: handler(async (req) => {
        const { params, query } = validated<{
          params: z.ZodObject<{ id: typeof idParam }>;
          query: z.ZodTypeAny;
        }>(req);
        const filters = query as { sectionId?: string; staffId?: string };
        return okBody({
          assignments: await academic.listSubjectTeachers(actorOf(req), params.id, filters),
        });
      }),
    },
    {
      method: 'post',
      path: '/subject-teachers',
      summary: 'Assign a teacher to a subject in a section',
      permission: 'academic.assign_teachers',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: {
        body: z
          .object({
            academicYearId: idParam,
            sectionId: idParam,
            subjectId: idParam,
            staffId: idParam,
          })
          .strict(),
      },
      handler: handler(async (req) => {
        const { body } = validated<{ body: z.ZodTypeAny }>(req);
        return created(
          await academic.assignSubjectTeacher(
            actorOf(req),
            body as {
              academicYearId: string;
              sectionId: string;
              subjectId: string;
              staffId: string;
            },
          ),
        );
      }),
      errors: ['SUBJECT_NOT_IN_CLASS', 'YEAR_CLOSED'],
    },
    {
      method: 'delete',
      path: '/subject-teachers/:id',
      summary: 'Remove a subject-teacher assignment',
      permission: 'academic.assign_teachers',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await academic.removeSubjectTeacher(actorOf(req), params.id);
        return noContent();
      }),
      errors: ['YEAR_CLOSED'],
    },

    /* ---------------- rooms ---------------- */
    {
      method: 'get',
      path: '/rooms',
      summary: 'List rooms',
      permission: 'academic.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ rooms: await academic.listRooms(actorOf(req)) })),
    },
    {
      method: 'post',
      path: '/rooms',
      summary: 'Create a room',
      permission: 'academic.manage_rooms',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: roomBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof roomBody }>(req);
        return created(await academic.createRoom(actorOf(req), body));
      }),
    },
  ];
}
