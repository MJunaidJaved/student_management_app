/**
 * Fee data access (Module 5): categories, structures, discounts, invoices,
 * payments and allocations.
 *
 * The database owns more of the correctness here than in any other module:
 * `fee_invoices.paid_total` and `.status` are written only by the
 * `recompute_invoice()` trigger (fired after every allocation insert and
 * every payment reversal), `payment_allocations` is append-only
 * (`trg_alloc_immutable`), and a deferred constraint trigger rejects a
 * payment whose allocations do not sum to its amount. None of that is
 * duplicated in application code — these repositories write the rows the
 * triggers react to and never touch `paid_total` or invoice `status`
 * themselves (except `cancelInvoice`, the one status the trigger leaves
 * alone on purpose).
 */

import { BaseRepository, type BaseRow } from '../../core/base/base-repository';
import type { Uow } from '../../core/db/uow';
import { ConditionBuilder } from '../../core/db/query-builder';
import type { SortMap } from '../../core/db/query-builder';
import { BusinessRuleError } from '../../core/errors';

/* ------------------------------------------------------------------ *
 * Fee categories
 * ------------------------------------------------------------------ */

export type FeeCategoryRow = BaseRow & {
  name: string;
  frequency: string;
  income_head_id: string | null;
  is_active: boolean;
};

export class FeeCategoryRepository extends BaseRepository<FeeCategoryRow> {
  protected readonly table = 'fee_categories';
  protected readonly writableColumns = ['name', 'frequency', 'income_head_id'] as const;
  // No deleted_at column: "deactivate" is the is_active flag, not a soft delete.
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'fee_categories.name', index: 'fee_categories_pkey (small table)' } };

  async listAll(uow: Uow, includeInactive = false): Promise<FeeCategoryRow[]> {
    return uow.many<FeeCategoryRow>(
      `SELECT * FROM fee_categories ${includeInactive ? '' : 'WHERE is_active'} ORDER BY name`,
    );
  }

  async setActive(uow: Uow, id: string, active: boolean): Promise<FeeCategoryRow> {
    return uow.one<FeeCategoryRow>(`UPDATE fee_categories SET is_active = $2 WHERE id = $1 RETURNING *`, [id, active], 'Fee category');
  }

  async referenceCounts(uow: Uow, id: string): Promise<{ structures: number; invoiceItems: number }> {
    const row = await uow.one<{ structures: number; invoice_items: number }>(
      `SELECT
         (SELECT count(*)::int FROM fee_structures WHERE fee_category_id = $1) AS structures,
         (SELECT count(*)::int FROM fee_invoice_items WHERE fee_category_id = $1) AS invoice_items`,
      [id],
    );
    return { structures: row.structures, invoiceItems: row.invoice_items };
  }
}

/* ------------------------------------------------------------------ *
 * Fee structures
 * ------------------------------------------------------------------ */

export type FeeStructureRow = BaseRow & {
  academic_year_id: string;
  class_id: string;
  fee_category_id: string;
  amount: string;
  due_day: number | null;
};

export class FeeStructureRepository extends BaseRepository<FeeStructureRow> {
  protected readonly table = 'fee_structures';
  protected readonly writableColumns = ['academic_year_id', 'class_id', 'fee_category_id', 'amount', 'due_day'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = { created_at: { column: 'fee_structures.created_at', index: 'fee_structures_pkey' } };

  async listForYear(uow: Uow, yearId: string, classId?: string): Promise<(FeeStructureRow & { fee_category_name: string; class_name: string })[]> {
    const where = new ConditionBuilder();
    where.add('fs.academic_year_id = ?', yearId);
    where.addIf(classId, 'fs.class_id = ?', classId);
    return uow.many(
      `SELECT fs.*, fc.name AS fee_category_name, c.name AS class_name
         FROM fee_structures fs
         JOIN fee_categories fc ON fc.id = fs.fee_category_id
         JOIN classes c ON c.id = fs.class_id
        ${where.where()}
        ORDER BY c.level_order, fc.name`,
      where.params(),
    );
  }

  async findOne(uow: Uow, yearId: string, classId: string, feeCategoryId: string): Promise<FeeStructureRow | null> {
    return uow.maybeOne<FeeStructureRow>(
      `SELECT * FROM fee_structures WHERE academic_year_id = $1 AND class_id = $2 AND fee_category_id = $3`,
      [yearId, classId, feeCategoryId],
    );
  }

  /** The structures that apply to a class for a year, used to build an invoice's line items. */
  async forClassAndYear(uow: Uow, yearId: string, classId: string): Promise<(FeeStructureRow & { fee_category_name: string })[]> {
    return uow.many(
      `SELECT fs.*, fc.name AS fee_category_name
         FROM fee_structures fs
         JOIN fee_categories fc ON fc.id = fs.fee_category_id AND fc.is_active
        WHERE fs.academic_year_id = $1 AND fs.class_id = $2`,
      [yearId, classId],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Discounts and student discounts
 * ------------------------------------------------------------------ */

export type DiscountRow = BaseRow & { name: string; type: string; value: string };

export class DiscountRepository extends BaseRepository<DiscountRow> {
  protected readonly table = 'discounts';
  protected readonly writableColumns = ['name', 'type', 'value'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'name';
  protected readonly sortable: SortMap = { name: { column: 'discounts.name', index: 'discounts_pkey (small table)' } };

  async listAll(uow: Uow): Promise<DiscountRow[]> {
    return uow.many<DiscountRow>(`SELECT * FROM discounts ORDER BY name`);
  }
}

export type StudentDiscountRow = BaseRow & {
  enrollment_id: string;
  discount_id: string;
  fee_category_id: string | null;
  approved_by: string | null;
  valid_from: string;
  valid_to: string | null;
};

export class StudentDiscountRepository extends BaseRepository<StudentDiscountRow> {
  protected readonly table = 'student_discounts';
  protected readonly writableColumns = ['enrollment_id', 'discount_id', 'fee_category_id', 'approved_by', 'valid_from', 'valid_to'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = { created_at: { column: 'student_discounts.created_at', index: 'student_discounts_pkey' } };

  /** Discounts active for an enrollment on a given date, optionally narrowed to one fee category. */
  async activeForEnrollment(uow: Uow, enrollmentId: string, onDate: string): Promise<(StudentDiscountRow & { type: string; value: string })[]> {
    return uow.many(
      `SELECT sd.*, d.type, d.value
         FROM student_discounts sd
         JOIN discounts d ON d.id = sd.discount_id
        WHERE sd.enrollment_id = $1
          AND sd.valid_from <= $2
          AND (sd.valid_to IS NULL OR sd.valid_to >= $2)`,
      [enrollmentId, onDate],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Invoices and items
 * ------------------------------------------------------------------ */

export type FeeInvoiceRow = BaseRow & {
  invoice_no: string;
  enrollment_id: string;
  billing_period: string;
  issue_date: string;
  due_date: string;
  subtotal: string;
  discount_total: string;
  fine_total: string;
  total: string;
  paid_total: string;
  status: string;
  created_by: string | null;
};

export class FeeInvoiceRepository extends BaseRepository<FeeInvoiceRow> {
  protected readonly table = 'fee_invoices';
  // paid_total and status are the trigger's; never writable from here.
  protected readonly writableColumns = ['enrollment_id', 'billing_period', 'issue_date', 'due_date', 'subtotal', 'discount_total', 'fine_total', 'total', 'created_by'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = {
    created_at: { column: 'fee_invoices.created_at', index: 'fee_invoices_pkey' },
    due_date: { column: 'fee_invoices.due_date', index: 'fee_invoices_enrollment_id_billing_period_key' },
    invoice_no: { column: 'fee_invoices.invoice_no', index: 'fee_invoices_invoice_no_key' },
  };

  /**
   * Create an invoice, skipping silently if one already exists for this
   * enrollment and billing period (Part 5: idempotent, safe to re-run).
   * `ON CONFLICT DO NOTHING` returns no row rather than erroring, which is
   * how bulk generation reports "skipped" instead of failing the batch.
   */
  async createIfAbsent(uow: Uow, data: Readonly<Record<string, unknown>>): Promise<FeeInvoiceRow | null> {
    const entries = Object.entries(data).filter(([k]) => (this.writableColumns as readonly string[]).includes(k));
    const columns = entries.map(([c]) => c);
    const placeholders = entries.map((_, i) => `$${i + 1}`);
    return uow.maybeOne<FeeInvoiceRow>(
      `INSERT INTO fee_invoices (${columns.join(', ')})
       VALUES (${placeholders.join(', ')})
       ON CONFLICT (enrollment_id, billing_period) DO NOTHING
       RETURNING *`,
      entries.map(([, v]) => v),
    );
  }

  async findByEnrollmentAndPeriod(uow: Uow, enrollmentId: string, billingPeriod: string): Promise<FeeInvoiceRow | null> {
    return uow.maybeOne<FeeInvoiceRow>(`SELECT * FROM fee_invoices WHERE enrollment_id = $1 AND billing_period = $2`, [enrollmentId, billingPeriod]);
  }

  async findByInvoiceNo(uow: Uow, invoiceNo: string): Promise<FeeInvoiceRow | null> {
    return uow.maybeOne<FeeInvoiceRow>(`SELECT * FROM fee_invoices WHERE invoice_no = $1`, [invoiceNo]);
  }

  async cancel(uow: Uow, id: string): Promise<FeeInvoiceRow> {
    return uow.one<FeeInvoiceRow>(`UPDATE fee_invoices SET status = 'cancelled' WHERE id = $1 RETURNING *`, [id], 'Fee invoice');
  }

  async listFiltered(
    uow: Uow,
    filters: { enrollmentId?: string | undefined; status?: string | undefined; dueBefore?: string | undefined; billingPeriod?: string | undefined; classId?: string | undefined; sectionId?: string | undefined },
    page: { limit: number; cursorCreatedAt?: string | undefined; cursorId?: string | undefined },
  ): Promise<(FeeInvoiceRow & { first_name: string; last_name: string | null; admission_no: string; class_name: string; section_name: string })[]> {
    const where = new ConditionBuilder();
    where.addIf(filters.enrollmentId, 'i.enrollment_id = ?', filters.enrollmentId);
    where.addIf(filters.status, 'i.status = ?', filters.status);
    where.addIf(filters.dueBefore, 'i.due_date <= ?', filters.dueBefore);
    where.addIf(filters.billingPeriod, 'i.billing_period = ?', filters.billingPeriod);
    where.addIf(filters.classId, 'e.class_id = ?', filters.classId);
    where.addIf(filters.sectionId, 'e.section_id = ?', filters.sectionId);
    if (page.cursorCreatedAt && page.cursorId) {
      where.add('(i.created_at, i.id) < (?::timestamptz, ?::bigint)', page.cursorCreatedAt, page.cursorId);
    }
    return uow.many(
      `SELECT i.*, s.first_name, s.last_name, s.admission_no, c.name AS class_name, sec.name AS section_name
         FROM fee_invoices i
         JOIN student_enrollments e ON e.id = i.enrollment_id
         JOIN students s ON s.id = e.student_id
         JOIN classes c ON c.id = e.class_id
         JOIN sections sec ON sec.id = e.section_id
        ${where.where()}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${page.limit + 1}`,
      where.params(),
    );
  }

  /** Every active enrollment in a class/year with no invoice yet for a billing period — the bulk-generation worklist. */
  async enrollmentsNeedingInvoice(uow: Uow, yearId: string, classId: string, billingPeriod: string): Promise<{ id: string }[]> {
    return uow.many(
      `SELECT e.id::text AS id
         FROM student_enrollments e
        WHERE e.academic_year_id = $1 AND e.class_id = $2 AND e.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM fee_invoices i WHERE i.enrollment_id = e.id AND i.billing_period = $3)`,
      [yearId, classId, billingPeriod],
    );
  }
}

export type FeeInvoiceItemRow = BaseRow & {
  invoice_id: string;
  fee_category_id: string;
  description: string | null;
  amount: string;
  discount_amount: string;
};

export class FeeInvoiceItemRepository extends BaseRepository<FeeInvoiceItemRow> {
  protected readonly table = 'fee_invoice_items';
  protected readonly writableColumns = ['invoice_id', 'fee_category_id', 'description', 'amount', 'discount_amount'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'fee_invoice_items.id', index: 'fee_invoice_items_pkey' } };

  async forInvoice(uow: Uow, invoiceId: string): Promise<(FeeInvoiceItemRow & { fee_category_name: string })[]> {
    return uow.many(
      `SELECT it.*, fc.name AS fee_category_name FROM fee_invoice_items it JOIN fee_categories fc ON fc.id = it.fee_category_id WHERE it.invoice_id = $1 ORDER BY it.id`,
      [invoiceId],
    );
  }
}

/* ------------------------------------------------------------------ *
 * Payments and allocations
 * ------------------------------------------------------------------ */

export type PaymentRow = BaseRow & {
  receipt_no: string;
  guardian_id: string | null;
  amount: string;
  method: string;
  reference_no: string | null;
  bank_account_id: string | null;
  paid_at: string;
  received_by: string;
  status: string;
  reversed_by: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
};

export class PaymentRepository extends BaseRepository<PaymentRow> {
  protected readonly table = 'payments';
  protected readonly writableColumns = ['guardian_id', 'amount', 'method', 'reference_no', 'bank_account_id', 'received_by'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'created_at';
  protected readonly sortable: SortMap = {
    created_at: { column: 'payments.created_at', index: 'payments_pkey' },
    receipt_no: { column: 'payments.receipt_no', index: 'payments_receipt_no_key' },
  };

  async findByReceiptNo(uow: Uow, receiptNo: string): Promise<PaymentRow | null> {
    return uow.maybeOne<PaymentRow>(`SELECT * FROM payments WHERE receipt_no = $1`, [receiptNo]);
  }

  /** `guard_payments` forbids editing amount/method/receipt and forbids deleting — this is the only legal write after creation. */
  async reverse(uow: Uow, id: string, reversedBy: string, reason: string): Promise<PaymentRow> {
    return uow.one<PaymentRow>(
      `UPDATE payments SET status = 'reversed', reversed_by = $2, reversed_at = now(), reversal_reason = $3 WHERE id = $1 RETURNING *`,
      [id, reversedBy, reason],
      'Payment',
    );
  }

  async listForGuardian(
    uow: Uow,
    guardianId: string,
    page: { limit: number; cursorCreatedAt?: string | undefined; cursorId?: string | undefined },
  ): Promise<PaymentRow[]> {
    const where = new ConditionBuilder();
    where.add('guardian_id = ?', guardianId);
    if (page.cursorCreatedAt && page.cursorId) {
      where.add('(created_at, id) < (?::timestamptz, ?::bigint)', page.cursorCreatedAt, page.cursorId);
    }
    return uow.many<PaymentRow>(`SELECT * FROM payments ${where.where()} ORDER BY created_at DESC, id DESC LIMIT ${page.limit + 1}`, where.params());
  }

  /** The day's collection, grouped by method — the daily cashier-closing report. */
  async collectionSummary(uow: Uow, from: string, to: string): Promise<{ method: string; count: number; total: string }[]> {
    return uow.many(
      `SELECT method, count(*)::int AS count, COALESCE(SUM(amount), 0)::text AS total
         FROM payments
        WHERE status = 'valid' AND paid_at::date BETWEEN $1 AND $2
        GROUP BY method
        ORDER BY method`,
      [from, to],
    );
  }
}

export type PaymentAllocationRow = BaseRow & { payment_id: string; invoice_id: string; amount: string };

export class PaymentAllocationRepository extends BaseRepository<PaymentAllocationRow> {
  protected readonly table = 'payment_allocations';
  protected readonly writableColumns = ['payment_id', 'invoice_id', 'amount'] as const;
  protected override readonly softDeletes = false;
  protected readonly defaultSort = 'id';
  protected readonly sortable: SortMap = { id: { column: 'payment_allocations.id', index: 'payment_allocations_pkey' } };

  async forPayment(uow: Uow, paymentId: string): Promise<PaymentAllocationRow[]> {
    return uow.many<PaymentAllocationRow>(`SELECT * FROM payment_allocations WHERE payment_id = $1 ORDER BY id`, [paymentId]);
  }

  async forInvoice(uow: Uow, invoiceId: string): Promise<(PaymentAllocationRow & { receipt_no: string; paid_at: string; payment_status: string })[]> {
    return uow.many(
      `SELECT a.*, p.receipt_no, p.paid_at, p.status AS payment_status
         FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
        WHERE a.invoice_id = $1 ORDER BY a.id`,
      [invoiceId],
    );
  }
}

/** Guard: refuse to act on a cancelled invoice. */
export function assertInvoiceNotCancelled(invoice: FeeInvoiceRow): void {
  if (invoice.status === 'cancelled') {
    throw new BusinessRuleError('That invoice is cancelled.', 'INVOICE_CANCELLED');
  }
}
