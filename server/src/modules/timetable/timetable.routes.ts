import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text } from '../../core/http/validate';
import { handler, actorOf, created, okBody, noContent } from '../../core/base/base-controller';
import type { TimetableService } from './timetable.service';

const idSchema = { params: z.object({ id: idParam }).strict() };
const timeOfDay = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Must be HH:MM or HH:MM:SS.');
const dayOfWeek = z.coerce.number().int().min(1).max(7);

const periodBody = z.object({ name: text(40), startTime: timeOfDay, endTime: timeOfDay, sortOrder: z.coerce.number().int().min(1) }).strict();

const entryBody = z
  .object({
    academicYearId: idParam,
    sectionId: idParam,
    dayOfWeek,
    periodId: idParam,
    subjectId: idParam,
    staffId: idParam,
    roomId: idParam.optional(),
  })
  .strict();

const entryUpdateBody = z
  .object({ dayOfWeek: dayOfWeek.optional(), periodId: idParam.optional(), subjectId: idParam.optional(), staffId: idParam.optional(), roomId: idParam.nullable().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Provide a field to change.');

const bulkSaveBody = z
  .object({
    sectionId: idParam,
    academicYearId: idParam,
    entries: z
      .array(z.object({ dayOfWeek, periodId: idParam, subjectId: idParam, staffId: idParam, roomId: idParam.optional() }).strict())
      .max(200),
  })
  .strict();

const substitutionBody = z
  .object({ timetableEntryId: idParam, subDate: isoDate, substituteStaffId: idParam, reason: text(300).optional() })
  .strict();

export function timetableRoutes(timetable: TimetableService): RouteDeclaration[] {
  return [
    /* ---------------- periods ---------------- */
    {
      method: 'get',
      path: '/periods',
      summary: 'List the bell schedule',
      permission: 'timetable.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ periods: await timetable.listPeriods(actorOf(req)) })),
    },
    {
      method: 'post',
      path: '/periods',
      summary: 'Create a period',
      permission: 'timetable.manage_periods',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: periodBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof periodBody }>(req);
        return created(await timetable.createPeriod(actorOf(req), body));
      }),
    },
    {
      method: 'patch',
      path: '/periods/:id',
      summary: 'Edit a period',
      permission: 'timetable.manage_periods',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), body: periodBody.partial().refine((b) => Object.keys(b).length > 0, 'Provide a field to change.') },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        return okBody(await timetable.updatePeriod(actorOf(req), (params as { id: string }).id, body as never));
      }),
    },
    {
      method: 'delete',
      path: '/periods/:id',
      summary: 'Delete a period with no timetable entries attached',
      permission: 'timetable.manage_periods',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await timetable.deletePeriod(actorOf(req), params.id);
        return noContent();
      }),
      errors: ['PERIOD_IN_USE'],
    },

    /* ---------------- entries ---------------- */
    {
      method: 'post',
      path: '/timetable/entries',
      summary: 'Create a timetable entry',
      permission: 'timetable.manage',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: entryBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof entryBody }>(req);
        return created(await timetable.createEntry(actorOf(req), body));
      }),
      errors: ['SUBJECT_NOT_IN_CLASS', 'TEACHER_NOT_ASSIGNED', 'STAFF_NOT_ACTIVE', 'TIMETABLE_CONFLICT'],
    },
    {
      method: 'patch',
      path: '/timetable/entries/:id',
      summary: 'Edit a timetable entry',
      permission: 'timetable.manage',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), body: entryUpdateBody },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        return okBody(await timetable.updateEntry(actorOf(req), (params as { id: string }).id, body as never));
      }),
      errors: ['SUBJECT_NOT_IN_CLASS', 'TEACHER_NOT_ASSIGNED', 'STAFF_NOT_ACTIVE', 'TIMETABLE_CONFLICT'],
    },
    {
      method: 'delete',
      path: '/timetable/entries/:id',
      summary: 'Delete a timetable entry',
      permission: 'timetable.manage',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        await timetable.deleteEntry(actorOf(req), params.id);
        return noContent();
      }),
    },
    {
      method: 'post',
      path: '/timetable/sections/:sectionId/bulk-save',
      summary: "Replace a whole section's timetable in one transaction",
      permission: 'timetable.manage',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ sectionId: idParam }).strict(), body: bulkSaveBody.omit({ sectionId: true }) },
      handler: handler(async (req) => {
        const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req);
        const { sectionId } = params as { sectionId: string };
        return okBody(await timetable.bulkSaveSection(actorOf(req), { sectionId, ...(body as Record<string, unknown>) } as never));
      }),
      errors: ['SUBJECT_NOT_IN_CLASS', 'TEACHER_NOT_ASSIGNED', 'STAFF_NOT_ACTIVE', 'DUPLICATE_SLOT_IN_BATCH', 'TIMETABLE_CONFLICT'],
    },
    {
      method: 'get',
      path: '/timetable/sections/:sectionId/years/:yearId',
      summary: "A section's timetable",
      permission: 'timetable.read',
      ownership: 'teacher-sections',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ sectionId: idParam, yearId: idParam }).strict() },
      handler: handler(async (req) => {
        const { params } = validated<{ params: z.ZodTypeAny }>(req);
        const { sectionId, yearId } = params as { sectionId: string; yearId: string };
        return okBody({ entries: await timetable.getForSection(actorOf(req), sectionId, yearId) });
      }),
    },
    {
      method: 'get',
      path: '/timetable/staff/:staffId/years/:yearId',
      summary: "A teacher's own timetable",
      permission: 'timetable.read',
      ownership: 'staff-self-or-hr',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ staffId: idParam, yearId: idParam }).strict() },
      handler: handler(async (req) => {
        const { params } = validated<{ params: z.ZodTypeAny }>(req);
        const { staffId, yearId } = params as { staffId: string; yearId: string };
        return okBody({ entries: await timetable.getForStaff(actorOf(req), staffId, yearId) });
      }),
    },
    {
      method: 'get',
      path: '/timetable/rooms/:roomId/years/:yearId',
      summary: "A room's timetable",
      permission: 'timetable.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ roomId: idParam, yearId: idParam }).strict() },
      handler: handler(async (req) => {
        const { params } = validated<{ params: z.ZodTypeAny }>(req);
        const { roomId, yearId } = params as { roomId: string; yearId: string };
        return okBody({ entries: await timetable.getForRoom(actorOf(req), roomId, yearId) });
      }),
    },

    /* ---------------- substitutions ---------------- */
    {
      method: 'post',
      path: '/substitutions',
      summary: 'Assign a substitute for a scheduled class',
      permission: 'substitutions.manage',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { body: substitutionBody },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof substitutionBody }>(req);
        return created(await timetable.createSubstitution(actorOf(req), body));
      }),
      errors: ['SUBSTITUTE_IS_ORIGINAL', 'STAFF_NOT_ACTIVE', 'SUBSTITUTION_EXISTS', 'SUBSTITUTE_CONFLICT'],
    },
    {
      method: 'post',
      path: '/substitutions/:id/cancel',
      summary: 'Cancel a substitution',
      permission: 'substitutions.manage',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => {
        const { params } = validated<typeof idSchema>(req);
        return okBody(await timetable.cancelSubstitution(actorOf(req), params.id));
      }),
      errors: ['SUBSTITUTION_ALREADY_CANCELLED'],
    },
    {
      method: 'get',
      path: '/substitutions',
      summary: 'The substitution schedule for a date',
      permission: 'substitutions.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: { query: z.object({ date: isoDate }).strict() },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        return okBody({ substitutions: await timetable.getDailySubstitutions(actorOf(req), (query as { date: string }).date) });
      }),
    },
    {
      method: 'get',
      path: '/substitutions/staff/:staffId',
      summary: "A teacher's substitution history",
      permission: 'substitutions.read',
      ownership: 'staff-self-or-hr',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ staffId: idParam }).strict(), query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).strict() },
      handler: handler(async (req) => {
        const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req);
        const { staffId } = params as { staffId: string };
        return okBody(await timetable.getSubstitutionsForStaff(actorOf(req), staffId, query as { limit: number; cursor?: string }));
      }),
    },
  ];
}
