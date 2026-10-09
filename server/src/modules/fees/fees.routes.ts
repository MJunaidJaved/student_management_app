import { z } from 'zod';
import type { RouteDeclaration } from '../../core/http/route-registry';
import { validated, idParam, isoDate, text, moneyAmount } from '../../core/http/validate';
import { handler, actorOf, created, okBody, noContent } from '../../core/base/base-controller';
import type { FeesService } from './fees.service';

const idSchema = { params: z.object({ id: idParam }).strict() };

/** Optional at the route level; the service treats a missing key as "not idempotent". */
const idempotencyHeader = z.object({ 'idempotency-key': text(128).optional() }).passthrough();

const categoryBody = z.object({ name: text(80), frequency: z.enum(['monthly', 'termly', 'yearly', 'one_time']), incomeHeadId: idParam.nullable().optional() }).strict();
const structureBody = z.object({ academicYearId: idParam, classId: idParam, feeCategoryId: idParam, amount: moneyAmount, dueDay: z.coerce.number().int().min(1).max(31).optional() }).strict();
const discountBody = z.object({ name: text(80), type: z.enum(['percent', 'fixed']), value: moneyAmount }).strict();
const studentDiscountBody = z.object({ enrollmentId: idParam, discountId: idParam, feeCategoryId: idParam.optional(), validFrom: isoDate, validTo: isoDate.optional() }).strict();

const generateInvoiceBody = z.object({ enrollmentId: idParam, billingPeriod: text(20), issueDate: isoDate, dueDate: isoDate }).strict();
const bulkGenerateBody = z.object({ academicYearId: idParam, classId: idParam, billingPeriod: text(20), issueDate: isoDate, dueDate: isoDate }).strict();

const recordPaymentBody = z
  .object({
    guardianId: idParam.optional(),
    amount: moneyAmount,
    method: z.enum(['cash', 'bank', 'online', 'cheque']),
    referenceNo: text(60).optional(),
    bankAccountId: idParam.optional(),
    allocations: z.array(z.object({ invoiceId: idParam, amount: moneyAmount.optional() }).strict()).min(1).max(50),
  })
  .strict();

const reverseBody = z.object({ reason: text(300) }).strict();

const invoiceListQuery = z
  .object({
    enrollmentId: idParam.optional(),
    status: z.enum(['unpaid', 'partial', 'paid', 'cancelled']).optional(),
    dueBefore: isoDate.optional(),
    billingPeriod: text(20).optional(),
    classId: idParam.optional(),
    sectionId: idParam.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().optional(),
  })
  .strict();

export function feesRoutes(fees: FeesService): RouteDeclaration[] {
  return [
    /* ---------------- fee categories ---------------- */
    {
      method: 'get', path: '/fee-categories', summary: 'List fee categories', permission: 'fees.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: z.object({ includeInactive: z.union([z.boolean(), z.enum(['true', 'false'])]).transform((v) => v === true || v === 'true').optional() }).strict() },
      handler: handler(async (req) => {
        const { query } = validated<{ query: z.ZodTypeAny }>(req);
        return okBody({ categories: await fees.listCategories(actorOf(req), (query as { includeInactive?: boolean }).includeInactive ?? false) });
      }),
    },
    {
      method: 'post', path: '/fee-categories', summary: 'Create a fee category', permission: 'fees.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: categoryBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof categoryBody }>(req); return created(await fees.createCategory(actorOf(req), body)); }),
    },
    {
      method: 'patch', path: '/fee-categories/:id', summary: 'Edit a fee category', permission: 'fees.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), body: categoryBody.partial().refine((b) => Object.keys(b).length > 0, 'Provide a field to change.') },
      handler: handler(async (req) => { const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req); return okBody(await fees.updateCategory(actorOf(req), (params as { id: string }).id, body as never)); }),
    },
    {
      method: 'post', path: '/fee-categories/:id/deactivate', summary: 'Deactivate a fee category', permission: 'fees.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await fees.setCategoryActive(actorOf(req), params.id, false)); }),
    },
    {
      method: 'post', path: '/fee-categories/:id/activate', summary: 'Reactivate a fee category', permission: 'fees.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await fees.setCategoryActive(actorOf(req), params.id, true)); }),
    },
    {
      method: 'delete', path: '/fee-categories/:id', summary: 'Delete a fee category not referenced by any structure or invoice', permission: 'fees.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); await fees.deleteCategory(actorOf(req), params.id); return noContent(); }),
      errors: ['FEE_CATEGORY_IN_USE'],
    },

    /* ---------------- fee structures ---------------- */
    {
      method: 'get', path: '/fee-structures', summary: 'List fee structures for a year', permission: 'fees.read', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: z.object({ academicYearId: idParam, classId: idParam.optional() }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); const { academicYearId, classId } = query as { academicYearId: string; classId?: string }; return okBody({ structures: await fees.listStructures(actorOf(req), academicYearId, classId) }); }),
    },
    {
      method: 'post', path: '/fee-structures', summary: 'Create a fee structure', permission: 'fees.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: structureBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof structureBody }>(req); return created(await fees.createStructure(actorOf(req), body)); }),
      errors: ['FEE_STRUCTURE_EXISTS'],
    },
    {
      method: 'patch', path: '/fee-structures/:id', summary: 'Edit a fee structure (does not alter already-issued invoices)', permission: 'fees.manage_structures', ownership: 'none', rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), body: z.object({ amount: moneyAmount.optional(), dueDay: z.coerce.number().int().min(1).max(31).nullable().optional() }).strict().refine((b) => Object.keys(b).length > 0, 'Provide a field to change.') },
      handler: handler(async (req) => { const { params, body } = validated<{ params: z.ZodTypeAny; body: z.ZodTypeAny }>(req); return okBody(await fees.updateStructure(actorOf(req), (params as { id: string }).id, body as never)); }),
    },

    /* ---------------- discounts ---------------- */
    {
      method: 'get', path: '/discounts', summary: 'List discount definitions', permission: 'fees.manage_discounts', ownership: 'none', rateLimit: 'userStandard',
      handler: handler(async (req) => okBody({ discounts: await fees.listDiscounts(actorOf(req)) })),
    },
    {
      method: 'post', path: '/discounts', summary: 'Create a discount definition', permission: 'fees.manage_discounts', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: discountBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof discountBody }>(req); return created(await fees.createDiscount(actorOf(req), body)); }),
    },
    {
      method: 'post', path: '/student-discounts', summary: 'Assign (and thereby approve) a discount for a student', permission: 'fees.approve_discount', ownership: 'none', rateLimit: 'userStandard',
      schemas: { body: studentDiscountBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof studentDiscountBody }>(req); return created(await fees.assignStudentDiscount(actorOf(req), body)); }),
      errors: ['INVALID_RANGE'],
    },
    {
      method: 'get', path: '/enrollments/:id/discounts', summary: "An enrollment's active discounts", permission: 'fees.read_own', ownership: 'student-self', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody({ discounts: await fees.listStudentDiscounts(actorOf(req), params.id) }); }),
    },

    /* ---------------- invoices ---------------- */
    {
      method: 'post', path: '/invoices', summary: 'Generate one invoice for an enrollment and billing period (idempotent)', permission: 'fees.generate_invoices', ownership: 'none', rateLimit: 'money',
      schemas: { body: generateInvoiceBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof generateInvoiceBody }>(req); return created(await fees.generateInvoice(actorOf(req), body)); }),
      errors: ['INVALID_RANGE', 'NO_FEE_STRUCTURE'],
    },
    {
      method: 'post', path: '/invoices/bulk-generate', summary: 'Generate invoices for every un-invoiced active enrollment in a class', permission: 'fees.generate_invoices', ownership: 'none', rateLimit: 'expensive',
      schemas: { body: bulkGenerateBody },
      handler: handler(async (req) => { const { body } = validated<{ body: typeof bulkGenerateBody }>(req); return okBody(await fees.bulkGenerateForClass(actorOf(req), body)); }),
    },
    {
      method: 'get', path: '/invoices', summary: 'List fee invoices within your scope', permission: 'fees.read_own', ownership: 'none', rateLimit: 'userStandard',
      schemas: { query: invoiceListQuery },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); const { limit, cursor, ...filters } = query as z.infer<typeof invoiceListQuery>; return okBody(await fees.listInvoices(actorOf(req), filters, { limit, cursor })); }),
    },
    {
      method: 'get', path: '/invoices/:id', summary: 'Get an invoice with items and payment history', permission: 'fees.read_own', ownership: 'student-self', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await fees.getInvoice(actorOf(req), params.id)); }),
    },
    {
      method: 'post', path: '/invoices/:id/cancel', summary: 'Cancel an invoice with no valid payments allocated', permission: 'fees.cancel_invoice', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await fees.cancelInvoice(actorOf(req), params.id)); }),
      errors: ['INVOICE_CANCELLED', 'INVOICE_HAS_PAYMENTS'],
    },

    /* ---------------- payments ---------------- */
    {
      method: 'post', path: '/payments', summary: 'Record a payment and allocate it to one or more invoices', permission: 'fees.collect', ownership: 'none', rateLimit: 'money',
      schemas: { body: recordPaymentBody, headers: idempotencyHeader },
      handler: handler(async (req) => {
        const { body } = validated<{ body: typeof recordPaymentBody }>(req);
        // validate() checks the header's format but, deliberately, never
        // replays it through validated() (see that file's comment) — read
        // the raw value directly; by the time the handler runs it has
        // already passed the schema.
        const rawKey = req.headers['idempotency-key'];
        const idempotencyKey = Array.isArray(rawKey) ? rawKey[0] : rawKey;
        const result = await fees.recordPayment(actorOf(req), { ...body, idempotencyKey });
        return created(result);
      }),
      errors: ['ALLOCATION_EXCEEDS_OUTSTANDING', 'OVERPAYMENT_REJECTED'],
    },
    {
      method: 'get', path: '/payments/:id', summary: 'Get a payment and its allocations', permission: 'fees.read_own', ownership: 'none', rateLimit: 'userStandard',
      schemas: idSchema,
      handler: handler(async (req) => { const { params } = validated<typeof idSchema>(req); return okBody(await fees.getPayment(actorOf(req), params.id)); }),
    },
    {
      method: 'post', path: '/payments/:id/reverse', summary: 'Reverse a valid payment', permission: 'fees.reverse_payment', ownership: 'none', rateLimit: 'money',
      schemas: { params: z.object({ id: idParam }).strict(), body: reverseBody },
      handler: handler(async (req) => { const { params, body } = validated<{ params: z.ZodTypeAny; body: typeof reverseBody }>(req); return okBody(await fees.reversePayment(actorOf(req), (params as { id: string }).id, body.reason)); }),
      errors: ['PAYMENT_ALREADY_REVERSED'],
    },
    {
      method: 'get', path: '/guardians/:id/payments', summary: "A guardian's payment history", permission: 'fees.read_own', ownership: 'guardian-children', rateLimit: 'userStandard',
      schemas: { params: z.object({ id: idParam }).strict(), query: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().optional() }).strict() },
      handler: handler(async (req) => { const { params, query } = validated<{ params: z.ZodTypeAny; query: z.ZodTypeAny }>(req); return okBody(await fees.listPaymentsForGuardian(actorOf(req), (params as { id: string }).id, query as { limit: number; cursor?: string })); }),
    },
    {
      method: 'get', path: '/receipts/:receiptNo', summary: 'Get a receipt by number (derived from stored payment and allocation records)', permission: 'fees.read_own', ownership: 'none', rateLimit: 'userStandard',
      schemas: { params: z.object({ receiptNo: text(20) }).strict() },
      handler: handler(async (req) => { const { params } = validated<{ params: z.ZodTypeAny }>(req); return okBody(await fees.getReceipt(actorOf(req), (params as { receiptNo: string }).receiptNo)); }),
    },

    /* ---------------- reports ---------------- */
    {
      method: 'get', path: '/reports/fees/outstanding', summary: 'Outstanding and overdue totals', permission: 'fees.read_defaulters', ownership: 'none', rateLimit: 'expensive',
      schemas: { query: z.object({ classId: idParam.optional(), sectionId: idParam.optional() }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); return okBody(await fees.getOutstandingSummary(actorOf(req), query as { classId?: string; sectionId?: string })); }),
    },
    {
      method: 'get', path: '/reports/fees/collection', summary: 'Collections by method over a date range', permission: 'fees.read_collection_report', ownership: 'none', rateLimit: 'expensive',
      schemas: { query: z.object({ from: isoDate, to: isoDate }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); const { from, to } = query as { from: string; to: string }; return okBody({ byMethod: await fees.getCollectionSummary(actorOf(req), from, to) }); }),
    },
    {
      method: 'get', path: '/reports/fees/invoice-status', summary: 'Invoice counts and totals by status', permission: 'fees.read', ownership: 'none', rateLimit: 'expensive',
      schemas: { query: z.object({ billingPeriod: text(20).optional() }).strict() },
      handler: handler(async (req) => { const { query } = validated<{ query: z.ZodTypeAny }>(req); return okBody({ byStatus: await fees.getInvoiceStatusSummary(actorOf(req), (query as { billingPeriod?: string }).billingPeriod) }); }),
    },
  ];
}
