/**
 * Fee management (Module 5) — the most financially sensitive module.
 * Correctness beats speed.
 *
 * Money moves through `core/money`'s `Money` class end to end; nothing here
 * does arithmetic on a plain JS number. The database is the authority on
 * `paid_total` and invoice `status` (see fees.repository.ts's header) — this
 * service computes totals it is about to INSERT (a new invoice's subtotal,
 * discount, total) and never recomputes or overwrites what the trigger owns.
 *
 * Deliberately not built this phase, and why:
 *   - Fine rules exist as a table but nothing applies them automatically —
 *     that is a nightly job, and there is no job runner in this codebase to
 *     schedule it in. Fines can still be entered as an invoice item's own
 *     amount is not how fines work here (fine_total is a column), so fines
 *     are out of scope until a job runner exists. Not invented around.
 *   - Installment plans: the table exists; no workflow is built on it. A
 *     real implementation needs due-date-driven overdue marking, which is
 *     the same missing job runner.
 *   - Carry-forward to the next year: explicitly deferred (fees.carry_forward
 *     permission exists, unused).
 *   - Discount "approval workflow": `student_discounts` has an `approved_by`
 *     column but no status/pending state. Assigning one IS the approval —
 *     gated on `fees.approve_discount` — rather than inventing a two-step
 *     state machine the schema does not model.
 */

import { readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../core/errors';
import { Money } from '../../core/money/money';
import type { PolicyContext, StudentPolicy } from '../../core/policy/policy';
import type { PermissionService } from '../../core/authz/permission-service';
import type { CacheStore } from '../../core/cache/cache';
import { EnrollmentRepository } from '../students/students.repository';
import {
  FeeCategoryRepository,
  FeeStructureRepository,
  DiscountRepository,
  StudentDiscountRepository,
  FeeInvoiceRepository,
  FeeInvoiceItemRepository,
  PaymentRepository,
  PaymentAllocationRepository,
  assertInvoiceNotCancelled,
  type FeeCategoryRow,
  type FeeStructureRow,
  type DiscountRow,
  type FeeInvoiceRow,
  type FeeInvoiceItemRow,
  type PaymentRow,
  type PaymentAllocationRow,
  type StudentDiscountRow,
} from './fees.repository';
import type { AccountingService } from '../accounting/accounting.service';

/* ------------------------------------------------------------------ *
 * Views
 * ------------------------------------------------------------------ */

export type FeeCategoryView = { id: string; name: string; frequency: string; incomeHeadId: string | null; isActive: boolean };
function toCategoryView(r: FeeCategoryRow): FeeCategoryView {
  return { id: r.id, name: r.name, frequency: r.frequency, incomeHeadId: r.income_head_id, isActive: r.is_active };
}

export type FeeStructureView = { id: string; academicYearId: string; classId: string; feeCategoryId: string; amount: string; dueDay: number | null };
function toStructureView(r: FeeStructureRow): FeeStructureView {
  return { id: r.id, academicYearId: r.academic_year_id, classId: r.class_id, feeCategoryId: r.fee_category_id, amount: r.amount, dueDay: r.due_day };
}

export type DiscountView = { id: string; name: string; type: string; value: string };
function toDiscountView(r: DiscountRow): DiscountView {
  return { id: r.id, name: r.name, type: r.type, value: r.value };
}

export type StudentDiscountView = { id: string; enrollmentId: string; discountId: string; feeCategoryId: string | null; approvedBy: string | null; validFrom: string; validTo: string | null };
function toStudentDiscountView(r: StudentDiscountRow): StudentDiscountView {
  return { id: r.id, enrollmentId: r.enrollment_id, discountId: r.discount_id, feeCategoryId: r.fee_category_id, approvedBy: r.approved_by, validFrom: r.valid_from, validTo: r.valid_to };
}

export type FeeInvoiceView = {
  id: string; invoiceNo: string; enrollmentId: string; billingPeriod: string; issueDate: string; dueDate: string;
  subtotal: string; discountTotal: string; fineTotal: string; total: string; paidTotal: string; outstanding: string; status: string;
};
function toInvoiceView(r: FeeInvoiceRow): FeeInvoiceView {
  return {
    id: r.id, invoiceNo: r.invoice_no, enrollmentId: r.enrollment_id, billingPeriod: r.billing_period,
    issueDate: r.issue_date, dueDate: r.due_date, subtotal: r.subtotal, discountTotal: r.discount_total,
    fineTotal: r.fine_total, total: r.total, paidTotal: r.paid_total,
    outstanding: Money.of(r.total).minus(r.paid_total).toString(),
    status: r.status,
  };
}

export type FeeInvoiceItemView = { id: string; feeCategoryId: string; feeCategoryName: string; description: string | null; amount: string; discountAmount: string };
function toItemView(r: FeeInvoiceItemRow & { fee_category_name: string }): FeeInvoiceItemView {
  return { id: r.id, feeCategoryId: r.fee_category_id, feeCategoryName: r.fee_category_name, description: r.description, amount: r.amount, discountAmount: r.discount_amount };
}

export type PaymentView = {
  id: string; receiptNo: string; guardianId: string | null; amount: string; method: string; referenceNo: string | null;
  bankAccountId: string | null; paidAt: string; receivedBy: string; status: string;
  reversedBy: string | null; reversedAt: string | null; reversalReason: string | null;
};
function toPaymentView(r: PaymentRow): PaymentView {
  return {
    id: r.id, receiptNo: r.receipt_no, guardianId: r.guardian_id, amount: r.amount, method: r.method,
    referenceNo: r.reference_no, bankAccountId: r.bank_account_id, paidAt: r.paid_at, receivedBy: r.received_by,
    status: r.status, reversedBy: r.reversed_by, reversedAt: r.reversed_at, reversalReason: r.reversal_reason,
  };
}

export type AllocationView = { id: string; invoiceId: string; amount: string };
function toAllocationView(r: PaymentAllocationRow): AllocationView {
  return { id: r.id, invoiceId: r.invoice_id, amount: r.amount };
}

export class FeesService {
  constructor(
    private readonly categories: FeeCategoryRepository,
    private readonly structures: FeeStructureRepository,
    private readonly discounts: DiscountRepository,
    private readonly studentDiscounts: StudentDiscountRepository,
    private readonly invoices: FeeInvoiceRepository,
    private readonly invoiceItems: FeeInvoiceItemRepository,
    private readonly payments: PaymentRepository,
    private readonly allocations: PaymentAllocationRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly studentPolicy: StudentPolicy,
    private readonly permissions: PermissionService,
    private readonly accounting: AccountingService,
    private readonly cache: CacheStore,
  ) {}

  private async context(uow: Uow, actor: Actor): Promise<PolicyContext> {
    const permissions = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
    return { actor, uow, permissions };
  }

  /** A guardian or student may see their own family's invoices/payments; anyone with fees.read sees everything. */
  private async assertCanViewEnrollment(ctx: PolicyContext, enrollmentId: string): Promise<void> {
    if (ctx.actor.userType === 'admin' || ctx.permissions.has('fees.read')) return;
    const enrollment = await this.enrollments.getById(ctx.uow, enrollmentId);
    const allowed = await this.studentPolicy.canView(ctx, enrollment.student_id);
    if (!allowed.allowed) throw new NotFoundError('Invoice');
  }

  /* ---------------- fee categories ---------------- */

  async listCategories(actor: Actor, includeInactive = false): Promise<FeeCategoryView[]> {
    return readTransaction(actor, async (uow) => (await this.categories.listAll(uow, includeInactive)).map(toCategoryView));
  }

  async createCategory(actor: Actor, input: { name: string; frequency: string; incomeHeadId?: string | null | undefined }): Promise<FeeCategoryView> {
    return transaction(actor, async (uow) => toCategoryView(await this.categories.create(uow, { name: input.name, frequency: input.frequency, income_head_id: input.incomeHeadId ?? null })));
  }

  async updateCategory(actor: Actor, id: string, input: { name?: string | undefined; frequency?: string | undefined; incomeHeadId?: string | null | undefined }): Promise<FeeCategoryView> {
    return transaction(actor, async (uow) => toCategoryView(await this.categories.update(uow, id, { name: input.name, frequency: input.frequency, income_head_id: input.incomeHeadId })));
  }

  async setCategoryActive(actor: Actor, id: string, active: boolean): Promise<FeeCategoryView> {
    return transaction(actor, async (uow) => toCategoryView(await this.categories.setActive(uow, id, active)));
  }

  async deleteCategory(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const counts = await this.categories.referenceCounts(uow, id);
      if (counts.structures > 0 || counts.invoiceItems > 0) {
        throw new BusinessRuleError(`That fee category is used by ${counts.structures} structure(s) and ${counts.invoiceItems} invoice item(s). Deactivate it instead.`, 'FEE_CATEGORY_IN_USE');
      }
      await uow.count(`DELETE FROM fee_categories WHERE id = $1`, [id]);
    });
  }

  /* ---------------- fee structures ---------------- */

  async listStructures(actor: Actor, yearId: string, classId?: string): Promise<(FeeStructureView & { feeCategoryName: string; className: string })[]> {
    return readTransaction(actor, async (uow) => {
      const rows = await this.structures.listForYear(uow, yearId, classId);
      return rows.map((r) => ({ ...toStructureView(r), feeCategoryName: r.fee_category_name, className: r.class_name }));
    });
  }

  async createStructure(actor: Actor, input: { academicYearId: string; classId: string; feeCategoryId: string; amount: string; dueDay?: number | null | undefined }): Promise<FeeStructureView> {
    return transaction(actor, async (uow) => {
      const existing = await this.structures.findOne(uow, input.academicYearId, input.classId, input.feeCategoryId);
      if (existing) {
        throw new ConflictError('A fee structure already exists for this year, class and fee category. Edit it instead.', 'FEE_STRUCTURE_EXISTS');
      }
      const row = await this.structures.create(uow, { academic_year_id: input.academicYearId, class_id: input.classId, fee_category_id: input.feeCategoryId, amount: Money.of(input.amount).quantize().toString(), due_day: input.dueDay ?? null });
      return toStructureView(row);
    });
  }

  /**
   * Edit a structure's amount or due day.
   *
   * This never touches an issued invoice: invoice items snapshot their own
   * `amount` at generation time and never re-read `fee_structures`, so
   * every invoice issued before this change keeps the old amount, exactly
   * as Part 4 of this task requires.
   */
  async updateStructure(actor: Actor, id: string, input: { amount?: string | undefined; dueDay?: number | null | undefined }): Promise<FeeStructureView> {
    return transaction(actor, async (uow) => {
      const row = await this.structures.update(uow, id, { amount: input.amount ? Money.of(input.amount).quantize().toString() : undefined, due_day: input.dueDay });
      return toStructureView(row);
    });
  }

  /* ---------------- discounts ---------------- */

  async listDiscounts(actor: Actor): Promise<DiscountView[]> {
    return readTransaction(actor, async (uow) => (await this.discounts.listAll(uow)).map(toDiscountView));
  }

  async createDiscount(actor: Actor, input: { name: string; type: string; value: string }): Promise<DiscountView> {
    return transaction(actor, async (uow) => {
      if (input.type === 'percent' && Money.of(input.value).greaterThan('100')) {
        throw new ValidationError('A percentage discount cannot exceed 100.', [{ field: 'value', message: 'Must be at most 100.' }]);
      }
      return toDiscountView(await this.discounts.create(uow, { name: input.name, type: input.type, value: Money.of(input.value).quantize().toString() }));
    });
  }

  /** Assigning a student discount IS its approval — gated on fees.approve_discount. */
  async assignStudentDiscount(actor: Actor, input: { enrollmentId: string; discountId: string; feeCategoryId?: string | undefined; validFrom: string; validTo?: string | undefined }) {
    return transaction(actor, async (uow) => {
      await this.enrollments.getById(uow, input.enrollmentId);
      await this.discounts.getById(uow, input.discountId);
      if (input.validTo && input.validTo < input.validFrom) {
        throw new BusinessRuleError('The end date must not be before the start date.', 'INVALID_RANGE');
      }
      const row = await this.studentDiscounts.create(uow, {
        enrollment_id: input.enrollmentId,
        discount_id: input.discountId,
        fee_category_id: input.feeCategoryId ?? null,
        approved_by: actor.userId,
        valid_from: input.validFrom,
        valid_to: input.validTo ?? null,
      });
      return toStudentDiscountView(row);
    });
  }

  async listStudentDiscounts(actor: Actor, enrollmentId: string): Promise<(StudentDiscountView & { type: string; value: string })[]> {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      await this.assertCanViewEnrollment(ctx, enrollmentId);
      const rows = await this.studentDiscounts.activeForEnrollment(uow, enrollmentId, new Date().toISOString().slice(0, 10));
      return rows.map((r) => ({ ...toStudentDiscountView(r), type: r.type, value: r.value }));
    });
  }

  /* ---------------- invoice generation ---------------- */

  /**
   * Build one enrollment's invoice for a billing period from the class's
   * fee structures, snapshotting each item's amount and applying any active
   * student discount — clamped to the item amount, matching the database's
   * own `discount_amount <= amount` CHECK. Idempotent: a second call for
   * the same enrollment and period returns `{ skipped: true }` rather than
   * erroring or creating a duplicate, because `fee_invoices` has a real
   * UNIQUE constraint on exactly that pair.
   */
  private async generateOne(
    uow: Uow,
    actor: Actor,
    input: { enrollmentId: string; classId: string; academicYearId: string; billingPeriod: string; issueDate: string; dueDate: string },
  ): Promise<{ invoiceId: string; skipped: boolean }> {
    const structuresForClass = await this.structures.forClassAndYear(uow, input.academicYearId, input.classId);
    if (structuresForClass.length === 0) {
      throw new BusinessRuleError('No fee structures are configured for this class and year.', 'NO_FEE_STRUCTURE');
    }

    const activeDiscounts = await this.studentDiscounts.activeForEnrollment(uow, input.enrollmentId, input.issueDate);

    let subtotal = Money.zero();
    let discountTotal = Money.zero();
    const items: { fee_category_id: string; description: string; amount: string; discount_amount: string }[] = [];

    for (const s of structuresForClass) {
      const amount = Money.of(s.amount).quantize();
      const applicable = activeDiscounts.filter((d) => d.fee_category_id === null || d.fee_category_id === s.fee_category_id);
      let discountAmount = Money.zero();
      for (const d of applicable) {
        const raw = d.type === 'percent' ? amount.percent(d.value) : Money.of(d.value);
        discountAmount = discountAmount.plus(raw);
      }
      discountAmount = discountAmount.quantize().min(amount).clampToZero();

      subtotal = subtotal.plus(amount);
      discountTotal = discountTotal.plus(discountAmount);
      items.push({ fee_category_id: s.fee_category_id, description: s.fee_category_name, amount: amount.toString(), discount_amount: discountAmount.toString() });
    }

    const total = subtotal.minus(discountTotal).quantize();

    const invoice = await this.invoices.createIfAbsent(uow, {
      enrollment_id: input.enrollmentId,
      billing_period: input.billingPeriod,
      issue_date: input.issueDate,
      due_date: input.dueDate,
      subtotal: subtotal.quantize().toString(),
      discount_total: discountTotal.quantize().toString(),
      fine_total: '0.00',
      total: total.toString(),
      created_by: actor.userId,
    });

    if (!invoice) {
      const existing = await this.invoices.findByEnrollmentAndPeriod(uow, input.enrollmentId, input.billingPeriod);
      return { invoiceId: existing!.id, skipped: true };
    }

    await this.invoiceItems.createMany(uow, items.map((it) => ({ invoice_id: invoice.id, ...it })));
    return { invoiceId: invoice.id, skipped: false };
  }

  async generateInvoice(actor: Actor, input: { enrollmentId: string; billingPeriod: string; issueDate: string; dueDate: string }) {
    return transaction(actor, async (uow) => {
      if (input.dueDate < input.issueDate) throw new BusinessRuleError('The due date must not be before the issue date.', 'INVALID_RANGE');
      const enrollment = await this.enrollments.getById(uow, input.enrollmentId);
      const result = await this.generateOne(uow, actor, { ...input, classId: enrollment.class_id, academicYearId: enrollment.academic_year_id });
      const invoice = await this.invoices.getById(uow, result.invoiceId);
      return { ...result, invoice: toInvoiceView(invoice) };
    });
  }

  /**
   * Bulk-generate for every active enrollment in a class that does not yet
   * have an invoice for this billing period. Each enrollment is its own
   * transaction (via `generateInvoice`'s single-row path called per id, in
   * its own call) — one enrollment's failure cannot roll back another's
   * already-created invoice, and the whole operation is safe to re-run:
   * already-invoiced enrollments are skipped, never duplicated.
   */
  async bulkGenerateForClass(actor: Actor, input: { academicYearId: string; classId: string; billingPeriod: string; issueDate: string; dueDate: string }) {
    const worklist = await readTransaction(actor, (uow) => this.invoices.enrollmentsNeedingInvoice(uow, input.academicYearId, input.classId, input.billingPeriod));
    const results: { enrollmentId: string; status: 'created' | 'skipped' | 'failed'; invoiceId?: string; error?: string }[] = [];
    for (const row of worklist) {
      try {
        const r = await this.generateInvoice(actor, { enrollmentId: row.id, billingPeriod: input.billingPeriod, issueDate: input.issueDate, dueDate: input.dueDate });
        results.push({ enrollmentId: row.id, status: r.skipped ? 'skipped' : 'created', invoiceId: r.invoice.id });
      } catch (err) {
        results.push({ enrollmentId: row.id, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { total: worklist.length, created: results.filter((r) => r.status === 'created').length, skipped: results.filter((r) => r.status === 'skipped').length, failed: results.filter((r) => r.status === 'failed').length, results };
  }

  /* ---------------- reading invoices ---------------- */

  async getInvoice(actor: Actor, id: string) {
    return readTransaction(actor, async (uow) => {
      const invoice = await this.invoices.getById(uow, id);
      const ctx = await this.context(uow, actor);
      await this.assertCanViewEnrollment(ctx, invoice.enrollment_id);
      const items = await this.invoiceItems.forInvoice(uow, id);
      const allocations = await this.allocations.forInvoice(uow, id);
      return { ...toInvoiceView(invoice), items: items.map(toItemView), payments: allocations.map((a) => ({ paymentId: a.payment_id, receiptNo: a.receipt_no, paidAt: a.paid_at, amount: a.amount, status: a.payment_status })) };
    });
  }

  async listInvoices(
    actor: Actor,
    filters: { enrollmentId?: string | undefined; status?: string | undefined; dueBefore?: string | undefined; billingPeriod?: string | undefined; classId?: string | undefined; sectionId?: string | undefined },
    page: { limit: number; cursor?: string | undefined },
  ) {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      const scoped = { ...filters };
      if (!ctx.permissions.has('fees.read') && ctx.actor.userType !== 'admin') {
        if (ctx.actor.userType === 'guardian') {
          const studentRows = await uow.many<{ student_id: string }>(`SELECT student_id FROM student_guardians WHERE guardian_id = $1`, [ctx.actor.guardianId]);
          const enrollmentRows = studentRows.length === 0 ? [] : await uow.many<{ id: string }>(`SELECT id::text AS id FROM student_enrollments WHERE student_id = ANY($1)`, [studentRows.map((r) => r.student_id)]);
          const ids = new Set(enrollmentRows.map((r) => r.id));
          if (scoped.enrollmentId && !ids.has(scoped.enrollmentId)) throw new NotFoundError('Invoice');
          if (!scoped.enrollmentId) {
            if (ids.size === 0) return { items: [], hasMore: false, nextCursor: null };
            // Narrow to the family: list each child's invoices and merge — small, bounded by family size.
            const all = [];
            for (const id of ids) all.push(...(await this.invoices.listFiltered(uow, { ...scoped, enrollmentId: id }, { limit: page.limit })));
            all.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
            const hasMore = all.length > page.limit;
            const items = all.slice(0, page.limit);
            return { items: items.map((i) => ({ ...toInvoiceView(i), studentName: `${i.first_name} ${i.last_name ?? ''}`.trim(), className: i.class_name, sectionName: i.section_name })), hasMore, nextCursor: null };
          }
        } else if (ctx.actor.userType === 'student') {
          const own = await uow.many<{ id: string }>(`SELECT id::text AS id FROM student_enrollments WHERE student_id = $1`, [ctx.actor.studentId]);
          const ids = new Set(own.map((r) => r.id));
          if (scoped.enrollmentId && !ids.has(scoped.enrollmentId)) throw new NotFoundError('Invoice');
          if (!scoped.enrollmentId && own[0]) scoped.enrollmentId = own[0].id;
        } else {
          throw new ForbiddenError('You do not have permission to list fee invoices.');
        }
      }

      let cursorCreatedAt: string | undefined, cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as { v: string; i: string };
        cursorCreatedAt = decoded.v;
        cursorId = decoded.i;
      }
      const rows = await this.invoices.listFiltered(uow, scoped, { limit: page.limit, cursorCreatedAt, cursorId });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      return {
        items: items.map((i) => ({ ...toInvoiceView(i), studentName: `${i.first_name} ${i.last_name ?? ''}`.trim(), className: i.class_name, sectionName: i.section_name })),
        hasMore,
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: last.created_at, i: last.id }), 'utf8').toString('base64url') : null,
      };
    });
  }

  /** Cancelling is blocked while any valid payment is allocated — reverse those first. */
  async cancelInvoice(actor: Actor, id: string) {
    return transaction(actor, async (uow) => {
      const invoice = await this.invoices.getById(uow, id);
      assertInvoiceNotCancelled(invoice);
      if (Money.of(invoice.paid_total).isPositive()) {
        throw new ConflictError('This invoice has valid payments allocated to it. Reverse them before cancelling.', 'INVOICE_HAS_PAYMENTS');
      }
      return toInvoiceView(await this.invoices.cancel(uow, id));
    });
  }

  /* ---------------- payments ---------------- */

  /**
   * Record a payment and allocate it across one or more invoices.
   *
   * All in one transaction: the target invoices are locked in ascending id
   * order (Part 9.5 — consistent ordering is what makes two concurrent
   * payments against the same invoice deadlock-free rather than merely
   * unlikely to deadlock), the allocation is validated against each
   * invoice's current outstanding balance read under that lock, the payment
   * and its allocations are inserted, and the database recomputes every
   * affected invoice via `recompute_invoice()`. Overpayment is rejected
   * outright, never carried as a credit — Part 5 of Section 1 already
   * decided that, and nothing here revisits it.
   *
   * Idempotency is cache-based, not a database column: a short-lived
   * `CacheStore` entry maps the caller's idempotency key to the payment id
   * it produced, so a retried request within the window returns the same
   * payment instead of creating a second one. This is weaker than a
   * database-backed key (it is lost on restart and not visible across
   * instances without a shared cache), which is reported as a limitation
   * rather than implied to be stronger than it is.
   */
  async recordPayment(
    actor: Actor,
    input: {
      guardianId?: string | undefined;
      amount: string;
      method: string;
      referenceNo?: string | undefined;
      bankAccountId?: string | undefined;
      allocations: { invoiceId: string; amount?: string | undefined }[];
      idempotencyKey?: string | undefined;
    },
  ) {
    if (input.idempotencyKey) {
      const cached = await this.cache.get<{ paymentId: string }>('payment-idempotency', input.idempotencyKey);
      if (cached) {
        const existing = await readTransaction(actor, (uow) => this.payments.getById(uow, cached.paymentId));
        const existingAllocations = await readTransaction(actor, (uow) => this.allocations.forPayment(uow, existing.id));
        return { payment: toPaymentView(existing), allocations: existingAllocations.map(toAllocationView), idempotentReplay: true };
      }
    }

    if ((input.method === 'bank' || input.method === 'cheque') && !input.bankAccountId) {
      throw new ValidationError('A bank account is required for bank or cheque payments.', [{ field: 'bankAccountId', message: 'Required for this method.' }]);
    }

    const amount = Money.of(input.amount).quantize();
    if (!amount.isPositive()) {
      throw new ValidationError('The payment amount must be positive.', [{ field: 'amount', message: 'Must be greater than zero.' }]);
    }

    const result = await transaction(actor, async (uow) => {
      const invoiceIds = [...new Set(input.allocations.map((a) => a.invoiceId))];
      const locked = await this.invoices.lockByIds(uow, invoiceIds);
      if (locked.length !== invoiceIds.length) throw new NotFoundError('Fee invoice');
      const byId = new Map(locked.map((i) => [i.id, i]));
      for (const i of locked) assertInvoiceNotCancelled(i);

      // Decide each line's amount: explicit if given, otherwise fill this
      // invoice's outstanding balance — the oldest-due-first allocation
      // Part 9.4 describes, expressed by the caller's own ordering.
      let remaining = amount;
      const lines: { invoiceId: string; amount: string }[] = [];
      for (const a of input.allocations) {
        const invoice = byId.get(a.invoiceId)!;
        const outstanding = Money.of(invoice.total).minus(invoice.paid_total);
        const lineAmount = a.amount ? Money.of(a.amount).quantize() : remaining.min(outstanding);
        if (lineAmount.isNegative() || lineAmount.isZero()) continue;
        if (lineAmount.greaterThan(outstanding)) {
          throw new BusinessRuleError(`Allocation of ${lineAmount.toString()} exceeds invoice ${invoice.invoice_no}'s outstanding balance of ${outstanding.toString()}.`, 'ALLOCATION_EXCEEDS_OUTSTANDING');
        }
        lines.push({ invoiceId: a.invoiceId, amount: lineAmount.toString() });
        remaining = remaining.minus(lineAmount);
      }
      if (remaining.isPositive()) {
        throw new BusinessRuleError(`The payment amount (${amount.toString()}) exceeds the total outstanding balance of the selected invoices. Overpayment is not accepted.`, 'OVERPAYMENT_REJECTED');
      }
      if (lines.length === 0) {
        throw new ValidationError('At least one invoice allocation is required.', [{ field: 'allocations', message: 'Must not be empty.' }]);
      }

      const payment = await this.payments.create(uow, {
        guardian_id: input.guardianId ?? null,
        amount: amount.toString(),
        method: input.method,
        reference_no: input.referenceNo ?? null,
        bank_account_id: input.bankAccountId ?? null,
        received_by: actor.userId,
      });

      await this.allocations.createMany(uow, lines.map((l) => ({ payment_id: payment.id, invoice_id: l.invoiceId, amount: l.amount })));

      await this.accounting.postReceiptForPayment(uow, { paymentId: payment.id, amount: amount.toString(), method: input.method, bankAccountId: input.bankAccountId, lines, createdBy: actor.userId });

      return payment;
    });

    if (input.idempotencyKey) {
      await this.cache.set('payment-idempotency', input.idempotencyKey, { paymentId: result.id });
    }

    const allocationRows = await readTransaction(actor, (uow) => this.allocations.forPayment(uow, result.id));
    return { payment: toPaymentView(result), allocations: allocationRows.map(toAllocationView), idempotentReplay: false };
  }

  async getPayment(actor: Actor, id: string) {
    return readTransaction(actor, async (uow) => {
      const payment = await this.payments.getById(uow, id);
      const ctx = await this.context(uow, actor);
      if (!ctx.permissions.has('fees.read') && ctx.actor.userType !== 'admin') {
        if (ctx.actor.userType !== 'guardian' || String(ctx.actor.guardianId) !== payment.guardian_id) {
          throw new NotFoundError('Payment');
        }
      }
      const allocationRows = await this.allocations.forPayment(uow, id);
      return { ...toPaymentView(payment), allocations: allocationRows.map(toAllocationView) };
    });
  }

  /** The receipt is derived entirely from stored records — never a separate "receipt" table to drift out of sync. */
  async getReceipt(actor: Actor, receiptNo: string) {
    return readTransaction(actor, async (uow) => {
      const payment = await this.payments.findByReceiptNo(uow, receiptNo);
      if (!payment) throw new NotFoundError('Receipt');
      const ctx = await this.context(uow, actor);
      if (!ctx.permissions.has('fees.read') && ctx.actor.userType !== 'admin') {
        if (ctx.actor.userType !== 'guardian' || String(ctx.actor.guardianId) !== payment.guardian_id) {
          throw new NotFoundError('Receipt');
        }
      }
      const allocationRows = await this.allocations.forPayment(uow, payment.id);
      const invoiceDetails = await Promise.all(allocationRows.map(async (a) => ({ invoiceId: a.invoice_id, invoiceNo: (await this.invoices.getById(uow, a.invoice_id)).invoice_no, amount: a.amount })));
      return { ...toPaymentView(payment), allocations: invoiceDetails };
    });
  }

  async listPaymentsForGuardian(actor: Actor, guardianId: string, page: { limit: number; cursor?: string | undefined }) {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      if (!ctx.permissions.has('fees.read') && ctx.actor.userType !== 'admin' && String(ctx.actor.guardianId) !== guardianId) {
        throw new NotFoundError('Guardian');
      }
      let cursorCreatedAt: string | undefined, cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as { v: string; i: string };
        cursorCreatedAt = decoded.v;
        cursorId = decoded.i;
      }
      const rows = await this.payments.listForGuardian(uow, guardianId, { limit: page.limit, cursorCreatedAt, cursorId });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      return { items: items.map(toPaymentView), hasMore, nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: last.created_at, i: last.id }), 'utf8').toString('base64url') : null };
    });
  }

  /**
   * Reverse a valid payment. Never edits or deletes the original — `status`
   * flips to `reversed`, `trg_payment_reversed` recomputes every invoice the
   * payment had allocations to, and an offsetting voucher is posted.
   */
  async reversePayment(actor: Actor, id: string, reason: string) {
    if (!reason?.trim()) throw new ValidationError('A reason is required to reverse a payment.', [{ field: 'reason', message: 'Required.' }]);
    return transaction(actor, async (uow) => {
      const payment = await this.payments.getById(uow, id);
      if (payment.status === 'reversed') throw new BusinessRuleError('This payment is already reversed.', 'PAYMENT_ALREADY_REVERSED');
      const updated = await this.payments.reverse(uow, id, String(actor.userId), reason);
      const lines = (await this.allocations.forPayment(uow, id)).map((a) => ({ invoiceId: a.invoice_id, amount: a.amount }));
      await this.accounting.postReversalForPayment(uow, { paymentId: id, amount: payment.amount, method: payment.method, lines, createdBy: actor.userId });
      return toPaymentView(updated);
    });
  }

  /* ---------------- reports ---------------- */

  async getOutstandingSummary(actor: Actor, filters: { classId?: string | undefined; sectionId?: string | undefined }) {
    return readTransaction(actor, async (uow) => {
      const where = [`i.status IN ('unpaid','partial')`];
      const params: unknown[] = [];
      if (filters.classId) { params.push(filters.classId); where.push(`e.class_id = $${params.length}`); }
      if (filters.sectionId) { params.push(filters.sectionId); where.push(`e.section_id = $${params.length}`); }
      const row = await uow.one<{ invoice_count: number; outstanding: string; overdue: string }>(
        `SELECT count(*)::int AS invoice_count,
                COALESCE(SUM(i.total - i.paid_total), 0)::text AS outstanding,
                COALESCE(SUM(i.total - i.paid_total) FILTER (WHERE i.due_date < CURRENT_DATE), 0)::text AS overdue
           FROM fee_invoices i JOIN student_enrollments e ON e.id = i.enrollment_id
          WHERE ${where.join(' AND ')}`,
        params,
      );
      return { invoiceCount: row.invoice_count, outstanding: row.outstanding, overdue: row.overdue };
    });
  }

  async getCollectionSummary(actor: Actor, from: string, to: string) {
    return readTransaction(actor, (uow) => this.payments.collectionSummary(uow, from, to));
  }

  async getInvoiceStatusSummary(actor: Actor, billingPeriod?: string) {
    return readTransaction(actor, (uow) => {
      const where = billingPeriod ? `WHERE billing_period = $1` : '';
      return uow.many<{ status: string; count: number; total: string }>(
        `SELECT status, count(*)::int AS count, COALESCE(SUM(total), 0)::text AS total FROM fee_invoices ${where} GROUP BY status ORDER BY status`,
        billingPeriod ? [billingPeriod] : [],
      );
    });
  }
}
