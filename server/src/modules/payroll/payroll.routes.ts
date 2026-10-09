import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text, moneyAmount } from '../../core/http/validate';
import { handler, actorOf, created, okBody } from '../../core/base/base-controller';
import type { PayrollService } from './payroll.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

const componentBody = z.object({ name: text(80), type: z.enum(['earning', 'deduction']), calcType: z.enum(['fixed', 'percent']) }).strict();
const structureBody = z.object({ name: text(80), description: text(300).optional() }).strict();
const assignSalaryBody = z.object({ staffId: idParam, salaryStructureId: idParam.optional(), basicSalary: moneyAmount, effectiveFrom: isoDate }).strict();
const createRunBody = z.object({ payMonth: z.coerce.number().int().min(1).max(12), payYear: z.coerce.number().int().min(2000).max(2100) }).strict();
const adjustmentBody = z.object({ salaryComponentId: idParam, type: z.enum(['earning', 'deduction']), amount: moneyAmount, reason: text(300) }).strict();

export function payrollRoutes(payroll: PayrollService): RouteDeclaration[] {
  return [
    /* ---------------- salary components and structures ---------------- */
    { method: 'get', path: '/salary-components', summary: 'List salary components', permission: 'payroll.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ components: await payroll.listComponents(actorOf(req)) })) },
    {
      method: 'post', path: '/salary-components', summary: 'Create a salary component', permission: 'payroll.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: componentBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof componentBody }>(req); return created(await payroll.createComponent(actorOf(req), body)); }),
    },
    { method: 'get', path: '/salary-structures', summary: 'List salary structures', permission: 'payroll.read', ownership: 'none', rateLimit: 'userStandard', handler: handler(async (req) => okBody({ structures: await payroll.listStructures(actorOf(req)) })) },
    {
      method: 'post', path: '/salary-structures', summary: 'Create a salary structure', permission: 'payroll.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: structureBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof structureBody }>(req); return created(await payroll.createStructure(actorOf(req), body)); }),
    },

    /* ---------------- staff salary assignment ---------------- */
    {
      method: 'post', path: '/staff-salaries', summary: 'Assign a staff member’s salary, effective from a date', permission: 'payroll.manage_salaries', ownership: 'none', rateLimit: 'money',
      schemas: { body: assignSalaryBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof assignSalaryBody }>(req); return created(await payroll.assignSalary(actorOf(req), body)); }),
      errors: ['STAFF_NOT_ACTIVE'],
    },
    {
      method: 'get', path: '/staff/:id/salary-history', summary: "A staff member's effective-dated salary history", permission: 'payroll.read_own', ownership: 'staff-self-or-hr', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody({ history: await payroll.listSalaryHistory(actorOf(req), params.id) }); }),
    },

    /* ---------------- payroll runs ---------------- */
    {
      method: 'get', path: '/payroll-runs', summary: 'List payroll runs', permission: 'payroll.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: z.object({ payYear: z.coerce.number().int().optional(), status: z.enum(['draft', 'approved', 'paid']).optional() }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); return okBody({ runs: await payroll.listRuns(actorOf(req), query as { payYear?: number; status?: string }) }); }),
    },
    {
      method: 'get', path: '/payroll-runs/:id', summary: 'Get a payroll run', permission: 'payroll.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await payroll.getRun(actorOf(req), params.id)); }),
    },
    {
      method: 'post', path: '/payroll-runs', summary: 'Create a draft payroll run for a period', permission: 'payroll.run', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: createRunBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof createRunBody }>(req); return created(await payroll.createRun(actorOf(req), body)); }),
      errors: ['PAYROLL_RUN_EXISTS'],
    },
    {
      method: 'post', path: '/payroll-runs/:id/generate-payslips', summary: 'Generate base payslips for every eligible active staff member', permission: 'payroll.run', ownership: 'none', rateLimit: 'expensive',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await payroll.generatePayslips(actorOf(req), params.id)); }),
      errors: ['PAYROLL_RUN_NOT_DRAFT'],
    },
    {
      method: 'post', path: '/payroll-runs/:id/approve', summary: 'Approve a payroll run', permission: 'payroll.approve', ownership: 'none', rateLimit: 'money',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await payroll.approveRun(actorOf(req), params.id)); }),
      errors: ['ILLEGAL_PAYROLL_TRANSITION', 'PAYROLL_RUN_EMPTY'],
    },
    {
      method: 'post', path: '/payroll-runs/:id/mark-paid', summary: 'Mark an approved payroll run as paid', permission: 'payroll.mark_paid', ownership: 'none', rateLimit: 'money',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await payroll.markRunPaid(actorOf(req), params.id)); }),
      errors: ['ILLEGAL_PAYROLL_TRANSITION'],
    },
    {
      method: 'get', path: '/payroll-runs/:id/payslips', summary: "A run's payslips", permission: 'payroll.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody({ payslips: await payroll.listPayslipsForRun(actorOf(req), params.id) }); }),
    },

    /* ---------------- payslips ---------------- */
    {
      method: 'post', path: '/payslips/:id/adjustments', summary: 'Add a manual earning or deduction to a draft-run payslip', permission: 'payroll.adjust', ownership: 'none', rateLimit: 'money',
      schemas: { ...idSchema, body: adjustmentBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: typeof idSchema.params; body: typeof adjustmentBody }>(req); return created(await payroll.addAdjustment(actorOf(req), params.id, body)); }),
      errors: ['PAYROLL_RUN_NOT_DRAFT'],
    },
    {
      method: 'get', path: '/payslips/:id', summary: 'Get a payslip with its line items', permission: 'payroll.read_own', ownership: 'staff-self-or-hr', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await payroll.getPayslip(actorOf(req), params.id)); }),
    },
    {
      method: 'get', path: '/staff/:id/payslips', summary: "A staff member's payslip history", permission: 'payroll.read_own', ownership: 'staff-self-or-hr', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody({ payslips: await payroll.listPayslipsForStaff(actorOf(req), params.id) }); }),
    },
  ];
}
