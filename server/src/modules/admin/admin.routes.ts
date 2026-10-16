import type { RouteDeclaration } from '../../core/http/route-registry';
import { handler, actorOf, okBody } from '../../core/base/base-controller';
import type { AdminService } from './admin.service';

/**
 * The admin console's summaries. Gated on `audit.read`, which only the
 * administrative roles hold: these views span every module at once.
 */
export function adminRoutes(service: AdminService): RouteDeclaration[] {
  return [
    {
      method: 'get',
      path: '/admin/overview',
      summary: 'Everything that needs an administrator today, across all modules',
      permission: 'audit.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody(await service.overview(actorOf(req)))),
    },
    {
      method: 'get',
      path: '/admin/system',
      summary: 'Database, migrations and cloud sync status',
      permission: 'audit.read',
      ownership: 'none',
      rateLimit: 'userStandard',
      handler: handler(async (req) => okBody(await service.system(actorOf(req)))),
    },
  ];
}
