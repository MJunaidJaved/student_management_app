import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text, moneyAmount } from '../../core/http/validate';
import { handler, actorOf, created, okBody } from '../../core/base/base-controller';
import type { ExamsService } from './exams.service';

const idSchema = { params: z.object({ id: idParam }).strict() };
const timeOfDay = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Must be HH:MM or HH:MM:SS.');

const examTypeBody = z.object({ name: text(80), weightage: moneyAmount.optional() }).strict();
const examBody = z.object({ academicYearId: idParam, termId: idParam.optional(), examTypeId: idParam, name: text(120), startDate: isoDate, endDate: isoDate }).strict();
const updateExamBody = z.object({ name: text(120).optional(), termId: idParam.optional(), startDate: isoDate.optional(), endDate: isoDate.optional() }).strict();

const scheduleBody = z.object({
  examId: idParam, classId: idParam, subjectId: idParam, examDate: isoDate, startTime: timeOfDay, endTime: timeOfDay,
  roomId: idParam.optional(), totalMarks: moneyAmount, passingMarks: moneyAmount,
}).strict();
const updateScheduleBody = z.object({ examDate: isoDate.optional(), startTime: timeOfDay.optional(), endTime: timeOfDay.optional(), roomId: idParam.optional(), totalMarks: moneyAmount.optional(), passingMarks: moneyAmount.optional() }).strict();

const marksEntryBody = z.object({
  examScheduleId: idParam,
  entries: z.array(z.object({ enrollmentId: idParam, marksObtained: moneyAmount.optional(), isAbsent: z.boolean().default(false) }).strict()).min(1).max(200),
}).strict();

const scaleBody = z.object({ name: text(80), isDefault: z.boolean().optional() }).strict();
const rangeBody = z.object({
  gradingScaleId: idParam, minPercent: moneyAmount, maxPercent: moneyAmount, grade: text(10), gpaPoints: moneyAmount.optional(), remark: text(200).optional(),
}).strict();
const updateRangeBody = z.object({ minPercent: moneyAmount.optional(), maxPercent: moneyAmount.optional(), grade: text(10).optional(), gpaPoints: moneyAmount.optional(), remark: text(200).optional() }).strict();

export function examsRoutes(exams: ExamsService): RouteDeclaration[] {
  return [
    /* ---------------- exam types ---------------- */
    { method: 'get', path: '/exam-types', summary: 'List exam types', permission: 'exams.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ types: await exams.listTypes(actorOf(req)) })) },
    {
      method: 'post', path: '/exam-types', summary: 'Create an exam type', permission: 'exams.manage', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: examTypeBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof examTypeBody }>(req); return created(await exams.createType(actorOf(req), body)); }),
    },
    {
      method: 'patch', path: '/exam-types/:id', summary: 'Edit an exam type', permission: 'exams.manage', ownership: 'none', rateLimit: 'userStandard',
      schemas: { ...idSchema, body: examTypeBody.partial() },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: ReturnType<typeof examTypeBody.partial> }>(req); return okBody(await exams.updateType(actorOf(req), params.id, body)); }),
    },
    {
      method: 'delete', path: '/exam-types/:id', summary: 'Delete an unused exam type', permission: 'exams.manage', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); await exams.deleteType(actorOf(req), params.id); return okBody({ deleted: true }); }),
      errors: ['EXAM_TYPE_IN_USE'],
    },

    /* ---------------- exams ---------------- */
    {
      method: 'get', path: '/exams', summary: 'List exams', permission: 'exams.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: z.object({ academicYearId: idParam.optional(), termId: idParam.optional(), status: z.enum(['draft', 'published', 'locked']).optional() }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); return okBody({ exams: await exams.listExams(actorOf(req), query as { academicYearId?: string; termId?: string; status?: string }) }); }),
    },
    {
      method: 'get', path: '/exams/:id', summary: 'Get an exam', permission: 'exams.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await exams.getExam(actorOf(req), params.id)); }),
    },
    {
      method: 'post', path: '/exams', summary: 'Create a draft exam', permission: 'exams.manage', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: examBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof examBody }>(req); return created(await exams.createExam(actorOf(req), body)); }),
    },
    {
      method: 'patch', path: '/exams/:id', summary: 'Edit a draft exam', permission: 'exams.manage', ownership: 'none', rateLimit: 'userStandard',
      schemas: { ...idSchema, body: updateExamBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof updateExamBody }>(req); return okBody(await exams.updateExam(actorOf(req), params.id, body)); }),
      errors: ['EXAM_NOT_DRAFT'],
    },
    {
      method: 'post', path: '/exams/:id/publish', summary: 'Compute and publish results for an exam', permission: 'exams.publish', ownership: 'none', rateLimit: 'expensive',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await exams.publishExam(actorOf(req), params.id)); }),
      errors: ['ILLEGAL_EXAM_TRANSITION', 'EXAM_HAS_NO_SCHEDULES'],
    },
    {
      method: 'post', path: '/exams/:id/compute-results', summary: 'Preview result computation without publishing', permission: 'exams.compute_results', ownership: 'none', rateLimit: 'expensive',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await exams.computeResults(actorOf(req), params.id)); }),
      errors: ['EXAM_HAS_NO_SCHEDULES'],
    },
    {
      method: 'post', path: '/exams/:id/lock', summary: 'Lock an exam, freezing its marks', permission: 'exams.lock', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await exams.lockExam(actorOf(req), params.id)); }),
      errors: ['ILLEGAL_EXAM_TRANSITION'],
    },
    {
      method: 'post', path: '/exams/:id/unlock', summary: 'Unlock a locked exam so marks can be corrected', permission: 'exams.unlock', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await exams.unlockExam(actorOf(req), params.id)); }),
      errors: ['EXAM_NOT_LOCKED'],
    },

    /* ---------------- exam schedules ---------------- */
    {
      method: 'get', path: '/exams/:id/schedules', summary: "An exam's schedules", permission: 'exams.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody({ schedules: await exams.listSchedules(actorOf(req), params.id) }); }),
    },
    {
      method: 'get', path: '/exam-schedules', summary: 'Search exam schedules', permission: 'exams.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: z.object({ classId: idParam.optional(), subjectId: idParam.optional(), roomId: idParam.optional(), examDate: isoDate.optional(), academicYearId: idParam.optional() }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); return okBody({ schedules: await exams.searchSchedules(actorOf(req), query as Record<string, string>) }); }),
    },
    {
      method: 'post', path: '/exam-schedules', summary: 'Schedule an exam paper', permission: 'exams.manage', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: scheduleBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof scheduleBody }>(req); return created(await exams.createSchedule(actorOf(req), body)); }),
      errors: ['EXAM_NOT_DRAFT', 'SUBJECT_NOT_IN_CLASS', 'EXAM_SCHEDULE_CONFLICT'],
    },
    {
      method: 'patch', path: '/exam-schedules/:id', summary: 'Edit an exam schedule', permission: 'exams.manage', ownership: 'none', rateLimit: 'userStandard',
      schemas: { ...idSchema, body: updateScheduleBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof updateScheduleBody }>(req); return okBody(await exams.updateSchedule(actorOf(req), params.id, body)); }),
      errors: ['EXAM_NOT_DRAFT', 'EXAM_SCHEDULE_CONFLICT'],
    },
    {
      method: 'post', path: '/exam-schedules/:id/cancel', summary: 'Cancel a scheduled exam paper', permission: 'exams.manage', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); await exams.cancelSchedule(actorOf(req), params.id); return okBody({ cancelled: true }); }),
      errors: ['EXAM_NOT_DRAFT', 'EXAM_SCHEDULE_HAS_MARKS'],
    },

    /* ---------------- marks ---------------- */
    {
      method: 'get', path: '/exam-schedules/:id/marks', summary: 'Marks entered for an exam schedule', permission: 'exams.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody({ marks: await exams.getMarksForSchedule(actorOf(req), params.id) }); }),
    },
    {
      method: 'post', path: '/marks/submit', summary: 'Bulk-submit marks for an exam schedule', permission: 'exams.enter_marks', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: marksEntryBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof marksEntryBody }>(req); return created({ marks: await exams.submitMarks(actorOf(req), body) }); }),
      errors: ['INVALID_ENROLLMENT_IN_BATCH'],
    },
    {
      method: 'post', path: '/marks/:id/lock', summary: 'Lock one mark entry', permission: 'exams.enter_marks_override', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await exams.setMarkLock(actorOf(req), params.id, true)); }),
    },
    {
      method: 'post', path: '/marks/:id/unlock', summary: 'Unlock one mark entry', permission: 'exams.enter_marks_override', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await exams.setMarkLock(actorOf(req), params.id, false)); }),
    },

    /* ---------------- grading ---------------- */
    { method: 'get', path: '/grading-scales', summary: 'List grading scales', permission: 'exams.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ scales: await exams.listScales(actorOf(req)) })) },
    {
      method: 'post', path: '/grading-scales', summary: 'Create a grading scale', permission: 'exams.manage_grading', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: scaleBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof scaleBody }>(req); return created(await exams.createScale(actorOf(req), body)); }),
    },
    {
      method: 'post', path: '/grading-scales/:id/set-default', summary: 'Make this the default grading scale', permission: 'exams.manage_grading', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await exams.setDefaultScale(actorOf(req), params.id)); }),
    },
    {
      method: 'get', path: '/grading-scales/:id/ranges', summary: "A grading scale's ranges", permission: 'exams.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody({ ranges: await exams.listRanges(actorOf(req), params.id) }); }),
    },
    {
      method: 'post', path: '/grading-scale-ranges', summary: 'Add a grade range to a scale', permission: 'exams.manage_grading', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: rangeBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof rangeBody }>(req); return created(await exams.createRange(actorOf(req), body)); }),
    },
    {
      method: 'patch', path: '/grading-scale-ranges/:id', summary: 'Edit a grade range', permission: 'exams.manage_grading', ownership: 'none', rateLimit: 'userStandard',
      schemas: { ...idSchema, body: updateRangeBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof updateRangeBody }>(req); return okBody(await exams.updateRange(actorOf(req), params.id, body)); }),
    },
    {
      method: 'delete', path: '/grading-scale-ranges/:id', summary: 'Remove a grade range', permission: 'exams.manage_grading', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); await exams.deleteRange(actorOf(req), params.id); return okBody({ deleted: true }); }),
    },

    /* ---------------- results and report cards ---------------- */
    {
      method: 'get', path: '/exams/:id/report-cards', summary: "A class's report cards for an exam", permission: 'exams.read', ownership: 'none', rateLimit: 'expensive',
      schemas: { params: z.object({ id: idParam }).strict(), query: z.object({ classId: idParam }).strict() },
      handler: handler(async (req) => { const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req); return okBody({ reportCards: await exams.listReportCardsForExam(actorOf(req), (params as { id: string }).id, (query as { classId: string }).classId) }); }),
    },
    {
      method: 'get', path: '/exams/:examId/report-cards/:enrollmentId', summary: "One student's report card for an exam", permission: 'exams.read_own', ownership: 'student-self', rateLimit: 'userStandard',
      schemas: { params: z.object({ examId: idParam, enrollmentId: idParam }).strict() },
      handler: handler(async (req) => { const { params } = validated<{ params: z.ZodTypeAny }>(req); const p = params as { examId: string; enrollmentId: string }; return okBody(await exams.getReportCard(actorOf(req), p.examId, p.enrollmentId)); }),
    },
    {
      method: 'get', path: '/enrollments/:enrollmentId/report-cards', summary: "A student's report-card history", permission: 'exams.read_own', ownership: 'student-self', rateLimit: 'userStandard',
      schemas: { params: z.object({ enrollmentId: idParam }).strict() },
      handler: handler(async (req) => { const { params } = validated<{ params: z.ZodTypeAny }>(req); return okBody({ reportCards: await exams.listReportCardsForEnrollment(actorOf(req), (params as { enrollmentId: string }).enrollmentId) }); }),
    },
  ];
}
