import type { RouteDeclaration } from '../../core/http/route-registry';
import { handler, actorOf, okBody } from '../../core/base/base-controller';
import type { ReportsService } from './reports.service';

export function reportsRoutes(service: ReportsService): RouteDeclaration[] {
  return [
    {
      method: 'get',
      path: '/reports/students',
      summary: 'Student headcount by status and gender',
      permission: 'students.read',
      ownership: 'none',
      rateLimit: 'expensive',
      handler: handler(async (req) => okBody(await service.getStudentSummary(actorOf(req)))),
    },
    {
      method: 'get',
      path: '/reports/staff',
      summary: 'Staff headcount by status and gender',
      permission: 'staff.read',
      ownership: 'none',
      rateLimit: 'expensive',
      handler: handler(async (req) => okBody(await service.getStaffSummary(actorOf(req)))),
    },
  ];
}
