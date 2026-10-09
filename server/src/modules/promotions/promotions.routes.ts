import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, text } from '../../core/http/validate';
import { handler, actorOf, okBody } from '../../core/base/base-controller';
import type { PromotionsService } from './promotions.service';

const applyBody = z.object({
  toAcademicYearId: idParam,
  decisions: z.array(z.object({
    fromEnrollmentId: idParam,
    action: z.enum(['promoted', 'detained', 'graduated']),
    toClassId: idParam.optional(),
    toSectionId: idParam.optional(),
    remarks: text(300).optional(),
  }).strict()).min(1).max(500),
}).strict();

export function promotionsRoutes(promotions: PromotionsService): RouteDeclaration[] {
  return [
    {
      method: 'get', path: '/promotions/preview', summary: 'Preview enrollments eligible for promotion in a class', permission: 'students.promote', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: z.object({ academicYearId: idParam, classId: idParam, sectionId: idParam.optional() }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); return okBody({ candidates: await promotions.preview(actorOf(req), query as { academicYearId: string; classId: string; sectionId?: string }) }); }),
    },
    {
      method: 'post', path: '/promotions/apply', summary: 'Apply a batch of promotion decisions', permission: 'students.promote', ownership: 'none', rateLimit: 'expensive',
      schemas: { body: applyBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof applyBody }>(req); return okBody(await promotions.apply(actorOf(req), body)); }),
      errors: ['ENROLLMENT_NOT_ACTIVE', 'ALREADY_PROMOTED', 'SECTION_FULL'],
    },
    {
      method: 'get', path: '/students/:studentId/promotions', summary: "A student's promotion history", permission: 'students.promote', ownership: 'none', rateLimit: 'userStandard',
      schemas: { params: z.object({ studentId: idParam }).strict() },
      handler: handler(async (req) => { const { params } = validated<{ params: z.ZodTypeAny }>(req); return okBody({ decisions: await promotions.history(actorOf(req), (params as { studentId: string }).studentId) }); }),
    },
  ];
}
