import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam } from '../../core/http/validate';
import { handler, actorOf, okBody, noContent } from '../../core/base/base-controller';
import type { NotificationService } from './notifications.service';

export function notificationRoutes(notifications: NotificationService): RouteDeclaration[] {
  return [
    {
      method: 'get',
      path: '/notifications',
      summary: 'List my in-app notifications',
      authenticatedOnly: true,
      ownership: 'self-only',
      reason: 'Entirely scoped to the caller’s own inbox; nobody else’s notifications are reachable through this id.',
      rateLimit: 'userStandard',
      schemas: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).strict() },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        return okBody(await notifications.listMine(actorOf(req), query as { limit: number; cursor?: string }));
      }),
    },
    {
      method: 'post',
      path: '/notifications/:id/read',
      summary: 'Mark one notification read',
      authenticatedOnly: true,
      ownership: 'self-only',
      reason: 'The repository query is scoped to the caller’s own user id; another user’s log row never matches.',
      rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict() },
      handler: handler(async (req) => {
        const { params } = validated<{ params: z.ZodTypeAny }>(req);
        await notifications.markRead(actorOf(req), (params as { id: string }).id);
        return noContent();
      }),
    },
    {
      method: 'post',
      path: '/notifications/read-all',
      summary: 'Mark all my notifications read',
      authenticatedOnly: true,
      ownership: 'self-only',
      reason: 'Only ever updates rows matching the caller’s own user id.',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody(await notifications.markAllRead(actorOf(req)))),
    },
  ];
}
