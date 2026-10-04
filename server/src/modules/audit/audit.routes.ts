/**
 * Audit log endpoints (Module 1): read-only, no update or delete at all.
 */

import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate } from '../../core/http/validate';
import { ok } from '../../core/http/envelope';
import { getRequestId } from '../../core/http/request-context';
import { currentUser } from '../../core/http/authenticate';
import { toActor } from '../../core/authz/permission-service';
import type { AuditService } from './audit.service';

/**
 * Filters are an allow-list (Part 5.5): anything else is rejected rather than
 * ignored, because a silently dropped filter returns more rows than the caller
 * asked for.
 */
const searchSchema = {
  query: z
    .object({
      userId: idParam.optional(),
      tableName: z.string().max(63).optional(),
      recordId: z.string().max(64).optional(),
      action: z.string().max(40).optional(),
      from: isoDate.optional(),
      to: isoDate.optional(),
      cursor: z.string().max(512).optional(),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      withTotal: z
        .enum(['true', 'false'])
        .transform((v) => v === 'true')
        .optional(),
    })
    .strict()
    .refine((q) => !q.from || !q.to || q.from <= q.to, {
      message: 'from must not be after to.',
      path: ['from'],
    }),
};

const idSchema = { params: z.object({ id: idParam }).strict() };

export function auditRoutes(audit: AuditService): RouteDeclaration[] {
  return [
    {
      method: 'get',
      path: '/',
      summary: 'Search the audit log by user, table, record, action or date range',
      permission: 'audit.read',
      ownership: 'none',
      // The expensive tier: an unfiltered search over a growing table, and
      // withTotal makes it a full scan.
      rateLimit: 'expensive',
      schemas: searchSchema,
      handler: (req, res, next) => {
        void (async () => {
          const { query } = validated<typeof searchSchema>(req);
          const result = await audit.search(toActor(currentUser(req)), query);
          res.status(200).json(
            ok({ entries: result.entries }, getRequestId(), { page: result.page }),
          );
        })().catch(next);
      },
      errors: ['PERMISSION_DENIED', 'INVALID_CURSOR', 'CURSOR_SORT_MISMATCH'],
    },
    {
      method: 'get',
      path: '/:id',
      summary: 'One audit entry with its before and after values',
      permission: 'audit.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      schemas: idSchema,
      handler: (req, res, next) => {
        void (async () => {
          const { params } = validated<typeof idSchema>(req);
          const entry = await audit.get(toActor(currentUser(req)), params.id);
          res.status(200).json(ok(entry, getRequestId()));
        })().catch(next);
      },
      errors: ['NOT_FOUND', 'PERMISSION_DENIED'],
    },
  ];
}
