import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../../app';
import { buildContainer } from '../../container';
import { SYSTEM_ACTOR, transaction } from '../../core/db/uow';
import { closePool } from '../../core/db/pool';
import { hashPassword } from '../../core/auth/password';
import { SUPER_ADMIN_ROLE } from '../../core/authz/default-roles';
import { InProcessCacheStore } from '../../core/cache/cache';

const ADMIN = { username: '__apitest_fees__', password: 'FeesPassw0rd!2026' };

/*
 * Fixed, reused setup fixtures — found if they already exist, created only
 * once, never torn down.
 *
 * A real payment permanently locks its whole ancestor chain: `payments` can
 * never be deleted (`guard_payments` blocks it unconditionally, even for a
 * payment that was never reversed) and a posted voucher is immutable
 * (`guard_posted_voucher`), so nothing that references them — the
 * allocation, the invoice, the enrollment, the section, the class, the
 * academic year — can be deleted either (every FK in that chain is
 * RESTRICT). That is correct: it is the same guarantee that protects a real
 * school's financial history, and this suite's own "database-enforced"
 * tests below rely on it. The practical consequence is that the class,
 * section, year, account heads and fee categories below cannot be
 * created-then-deleted per run; `classes.level_order` is a scarce 0-100
 * value system-wide, so a fresh one per run was never viable anyway. They
 * are find-or-create fixtures this file reuses forever instead.
 */
const FIXED = {
  yearName: '__apitest_fees_year__',
  className: '__apitest_fees_class__',
  classLevelOrder: 97,
  sectionName: 'A',
  tuitionCategoryName: '__apitest_fees_tuition__',
  examCategoryName: '__apitest_fees_exam__',
  // Must be exactly 'CASH': AccountingService.resolveDebitHead hardcodes
  // this code to find the cash-in-hand head for a cash-method receipt. This
  // is the one real, shared, canonical account head, not a test fixture.
  cashHeadCode: 'CASH',
  incomeHeadCode: '__TESTINC',
};

let server: Server;
let baseUrl: string;
let token: string;

// Only fixtures that are genuinely deletable end up here. Students,
// guardians, enrollments, invoices, payments and vouchers are not — see the
// comment on FIXED above — so this suite's residue there is permanent by
// design, not an oversight.
const made = { discounts: [] as string[] };

async function call(path: string, init: Omit<RequestInit, 'body'> & { token?: string; body?: any; headers?: Record<string, string> } = {}): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${init.token ?? token}` };
  const res = await fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers }, ...(init.body !== undefined && { body: JSON.stringify(init.body) }) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Deliberately far from any calendar year the rest of the test suite uses
// (several other files share the literal '2026-01-01'..'2026-12-31' range,
// relying on each cleaning up its own year before the next file runs — a
// permanent fixture can't rely on that). Enrollment/invoice/payment dates
// elsewhere in this file stay '2026-...' regardless; nothing validates them
// against this year's own start/end bounds.
const FIXTURE_YEAR_RANGE = { start: '2090-01-01', end: '2090-12-31' };

async function findOrCreateYear(): Promise<string> {
  // Looked up by date range, not name: academic_years has an EXCLUDE
  // constraint on overlapping ranges (not just a unique name), so a prior
  // run's year — however it was named — already permanently occupies this
  // exact range (student_enrollments.academic_year_id is RESTRICT, and an
  // enrollment here is permanently anchored by its invoice's payments).
  const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM academic_years WHERE start_date = $1 AND end_date = $2`, [FIXTURE_YEAR_RANGE.start, FIXTURE_YEAR_RANGE.end]));
  if (existing) return existing.id;
  const res = await call('/api/v1/academic/years', { method: 'POST', body: { name: FIXED.yearName, startDate: FIXTURE_YEAR_RANGE.start, endDate: FIXTURE_YEAR_RANGE.end } });
  if (res.status !== 201) throw new Error('Could not create fixture year: ' + JSON.stringify(res.body));
  return res.body.data.id;
}

async function findOrCreateClass(): Promise<string> {
  const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM classes WHERE name = $1`, [FIXED.className]));
  if (existing) return existing.id;
  const res = await call('/api/v1/academic/classes', { method: 'POST', body: { name: FIXED.className, levelOrder: FIXED.classLevelOrder } });
  if (res.status !== 201) throw new Error('Could not create fixture class: ' + JSON.stringify(res.body));
  return res.body.data.id;
}

async function findOrCreateSection(classId: string): Promise<string> {
  const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM sections WHERE class_id = $1 AND name = $2`, [classId, FIXED.sectionName]));
  if (existing) return existing.id;
  const res = await call('/api/v1/academic/sections', { method: 'POST', body: { classId, name: FIXED.sectionName, capacity: 10 } });
  if (res.status !== 201) throw new Error('Could not create fixture section: ' + JSON.stringify(res.body));
  return res.body.data.id;
}

async function findOrCreateAccountHead(code: string, name: string, type: string): Promise<string> {
  const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM account_heads WHERE code = $1`, [code]));
  if (existing) return existing.id;
  const res = await call('/api/v1/account-heads', { method: 'POST', body: { code, name, type } });
  if (res.status !== 201) throw new Error('Could not create fixture account head: ' + JSON.stringify(res.body));
  return res.body.data.id;
}

async function findOrCreateFeeCategory(name: string, frequency: string, incomeHeadId: string): Promise<string> {
  const existing = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM fee_categories WHERE name = $1`, [name]));
  if (existing) return existing.id;
  const res = await call('/api/v1/fee-categories', { method: 'POST', body: { name, frequency, incomeHeadId } });
  if (res.status !== 201) throw new Error('Could not create fixture fee category: ' + JSON.stringify(res.body));
  return res.body.data.id;
}

beforeAll(async () => {
  // A dedicated in-process cache, isolated to this file's own container, so
  // the payment-idempotency path (cache-backed, see fees.service.ts) is
  // actually exercised. `forTests` alone gives a NullCacheStore, which is
  // right for permission caching but would make idempotency untestable.
  const app = createApp(buildContainer({ forTests: true, cache: new InProcessCacheStore() }));
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;

  await transaction(SYSTEM_ACTOR, async (uow) => {
    const hash = await hashPassword(ADMIN.password);
    const existing = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE lower(username) = $1`, [ADMIN.username]);
    if (existing) {
      await uow.count(`UPDATE users SET must_change_password = false, is_active = true WHERE id = $1`, [existing.id]);
    } else {
      const u = await uow.one<{ id: string }>(`INSERT INTO users (username, password_hash, user_type, must_change_password, is_active) VALUES ($1, $2, 'admin', false, true) RETURNING id::text AS id`, [ADMIN.username, hash]);
      await uow.count(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE name = $2`, [u.id, SUPER_ADMIN_ROLE]);
    }
  });
  const login = await call('/api/v1/auth/login', { method: 'POST', token: 'none', body: { username: ADMIN.username, password: ADMIN.password } });
  if (login.status !== 200) throw new Error('Login failed: ' + JSON.stringify(login.body));
  token = login.body.data.accessToken;
});

afterAll(async () => {
  await transaction(SYSTEM_ACTOR, async (uow) => {
    await uow.count(`DELETE FROM student_discounts WHERE discount_id = ANY($1)`, [made.discounts]);
    for (const id of made.discounts) await uow.count(`DELETE FROM discounts WHERE id = $1`, [id]);
  });
  server.close();
  await closePool();
});

describe('Fees API', () => {
  let yearId: string, classId: string, sectionId: string;
  let studentId: string, enrollmentId: string, guardianId: string;
  let tuitionCategoryId: string, examCategoryId: string;
  let incomeHeadId: string;

  beforeAll(async () => {
    yearId = await findOrCreateYear();
    classId = await findOrCreateClass();
    sectionId = await findOrCreateSection(classId);
    // Only its existence matters here — the cash side of a receipt voucher
    // is resolved by code, not by this id (see the comment on FIXED above).
    await findOrCreateAccountHead(FIXED.cashHeadCode, 'Cash in hand', 'asset');
    incomeHeadId = await findOrCreateAccountHead(FIXED.incomeHeadCode, 'Test fee income', 'income');
    tuitionCategoryId = await findOrCreateFeeCategory(FIXED.tuitionCategoryName, 'monthly', incomeHeadId);
    examCategoryId = await findOrCreateFeeCategory(FIXED.examCategoryName, 'termly', incomeHeadId);

    // fee_structures ARE safely deletable (nothing references them), so the
    // reused class starts from a clean slate every run rather than carrying
    // over amendments (like the 9999.00 made below) from a previous one.
    await transaction(SYSTEM_ACTOR, (uow) => uow.count(`DELETE FROM fee_structures WHERE class_id = $1`, [classId]));

    const s = await call('/api/v1/students', { method: 'POST', body: { firstName: 'Fee', lastName: 'Payer', gender: 'male', dob: '2015-01-01', admissionDate: '2026-01-01' } });
    studentId = s.body.data.student.id;
    const e = await call('/api/v1/enrollments', { method: 'POST', body: { studentId, academicYearId: yearId, classId, sectionId, enrolledOn: '2026-01-01' } });
    enrollmentId = e.body.data.id;

    const g = await call('/api/v1/guardians', { method: 'POST', body: { fullName: 'Fee Guardian', phone: '03006001122' } });
    guardianId = g.body.data.id;
    await call('/api/v1/student-guardians', { method: 'POST', body: { studentId, guardianId, relation: 'father', isPrimary: true, isFeePayer: true } });

    await call('/api/v1/fee-structures', { method: 'POST', body: { academicYearId: yearId, classId, feeCategoryId: tuitionCategoryId, amount: '1000.00', dueDay: 10 } });
    await call('/api/v1/fee-structures', { method: 'POST', body: { academicYearId: yearId, classId, feeCategoryId: examCategoryId, amount: '500.00' } });
  });

  it('rejects a duplicate fee structure for the same year/class/category', async () => {
    const res = await call('/api/v1/fee-structures', { method: 'POST', body: { academicYearId: yearId, classId, feeCategoryId: tuitionCategoryId, amount: '1200.00' } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('FEE_STRUCTURE_EXISTS');
  });

  let invoiceId: string;
  it('generates an invoice from the class fee structures, with correct totals', async () => {
    const res = await call('/api/v1/invoices', { method: 'POST', body: { enrollmentId, billingPeriod: '2026-01', issueDate: '2026-01-01', dueDate: '2026-01-10' } });
    expect(res.status).toBe(201);
    expect(res.body.data.skipped).toBe(false);
    expect(res.body.data.invoice.subtotal).toBe('1500.00');
    expect(res.body.data.invoice.discountTotal).toBe('0.00');
    expect(res.body.data.invoice.total).toBe('1500.00');
    expect(res.body.data.invoice.status).toBe('unpaid');
    invoiceId = res.body.data.invoice.id;
  });

  it('re-running the same invoice generation is idempotent: skips, never duplicates', async () => {
    const res = await call('/api/v1/invoices', { method: 'POST', body: { enrollmentId, billingPeriod: '2026-01', issueDate: '2026-01-01', dueDate: '2026-01-10' } });
    expect(res.status).toBe(201);
    expect(res.body.data.skipped).toBe(true);
    expect(res.body.data.invoice.id).toBe(invoiceId);

    const count = await transaction(SYSTEM_ACTOR, (uow) => uow.one<{ n: number }>(`SELECT count(*)::int AS n FROM fee_invoices WHERE enrollment_id = $1 AND billing_period = '2026-01'`, [enrollmentId]));
    expect(count.n).toBe(1);
  });

  it('a later change to the fee structure does not alter the already-issued invoice', async () => {
    const structures = await call(`/api/v1/fee-structures?academicYearId=${yearId}&classId=${classId}`);
    const tuitionStructure = structures.body.data.structures.find((s: { feeCategoryId: string }) => s.feeCategoryId === tuitionCategoryId);
    await call(`/api/v1/fee-structures/${tuitionStructure.id}`, { method: 'PATCH', body: { amount: '9999.00' } });

    const invoice = await call(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.data.items.find((i: { feeCategoryId: string }) => i.feeCategoryId === tuitionCategoryId).amount).toBe('1000.00');
    expect(invoice.body.data.total).toBe('1500.00');
  });

  it('a guardian cannot read another family\'s invoice (404, not 403)', async () => {
    // Proves the ownership-check path is a clean 404, not a leak, for a
    // nonsense id — the family-scoping itself is exercised by the listing
    // tests further down.
    const res = await call(`/api/v1/invoices/999999999`);
    expect(res.status).toBe(404);
  });

  it('rejects a payment that would overpay the invoice', async () => {
    const res = await call('/api/v1/payments', { method: 'POST', body: { guardianId, amount: '2000.00', method: 'cash', allocations: [{ invoiceId }] } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('OVERPAYMENT_REJECTED');
  });

  let paymentId: string;
  it('records a partial payment, which leaves the invoice partially paid', async () => {
    const res = await call('/api/v1/payments', { method: 'POST', body: { guardianId, amount: '600.00', method: 'cash', allocations: [{ invoiceId, amount: '600.00' }] } });
    expect(res.status).toBe(201);
    expect(res.body.data.payment.amount).toBe('600.00');
    paymentId = res.body.data.payment.id;

    const invoice = await call(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.data.status).toBe('partial');
    expect(invoice.body.data.paidTotal).toBe('600.00');
    expect(invoice.body.data.outstanding).toBe('900.00');
  });

  it('auto-posted a balanced receipt voucher for the payment', async () => {
    const voucher = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string; status: string }>(`SELECT id::text AS id, status FROM vouchers WHERE source_type = 'payment' AND source_id = $1`, [paymentId]));
    expect(voucher).not.toBeNull();
    expect(voucher!.status).toBe('posted');

    const entries = await transaction(SYSTEM_ACTOR, (uow) => uow.many<{ debit: string; credit: string }>(`SELECT debit, credit FROM voucher_entries WHERE voucher_id = $1`, [voucher!.id]));
    const totalDebit = entries.reduce((s, e) => s + Number(e.debit), 0);
    const totalCredit = entries.reduce((s, e) => s + Number(e.credit), 0);
    expect(totalDebit).toBe(600);
    expect(totalCredit).toBe(600);
  });

  it('refuses a duplicate payment request carrying the same idempotency key', async () => {
    const key = `test-idem-${invoiceId}-${Date.now()}`;
    const first = await call('/api/v1/payments', { headers: { 'idempotency-key': key }, method: 'POST', body: { guardianId, amount: '100.00', method: 'cash', allocations: [{ invoiceId, amount: '100.00' }] } });
    expect(first.status).toBe(201);
    const firstPaymentId = first.body.data.payment.id;

    const replay = await call('/api/v1/payments', { headers: { 'idempotency-key': key }, method: 'POST', body: { guardianId, amount: '100.00', method: 'cash', allocations: [{ invoiceId, amount: '100.00' }] } });
    expect(replay.status).toBe(201);
    expect(replay.body.data.idempotentReplay).toBe(true);
    expect(replay.body.data.payment.id).toBe(firstPaymentId);

    const count = await transaction(SYSTEM_ACTOR, (uow) => uow.one<{ n: number }>(`SELECT count(*)::int AS n FROM payments WHERE id = $1`, [firstPaymentId]));
    expect(count.n).toBe(1);

    // This payment stays (payments cannot be deleted); the next test reverses
    // it so the invoice balance assertions after it are correct.
  });

  it('refuses to cancel an invoice with a valid payment allocated', async () => {
    const res = await call(`/api/v1/invoices/${invoiceId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVOICE_HAS_PAYMENTS');
  });

  it('reverses the payment, restoring the invoice balance and posting an offsetting voucher', async () => {
    const res = await call(`/api/v1/payments/${paymentId}/reverse`, { method: 'POST', body: { reason: 'Entered in error' } });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('reversed');

    // The idempotency-key test above recorded a second, separate 100.00
    // payment against this same invoice; reverse that one too so the
    // invoice returns fully to unpaid.
    const other = await transaction(SYSTEM_ACTOR, (uow) => uow.many<{ id: string }>(`SELECT id::text AS id FROM payments WHERE guardian_id = $1 AND status <> 'reversed' AND id <> $2`, [guardianId, paymentId]));
    for (const row of other) {
      const rev = await call(`/api/v1/payments/${row.id}/reverse`, { method: 'POST', body: { reason: 'Test cleanup' } });
      expect(rev.status).toBe(200);
    }

    const invoice = await call(`/api/v1/invoices/${invoiceId}`);
    expect(invoice.body.data.status).toBe('unpaid');
    expect(invoice.body.data.paidTotal).toBe('0.00');

    const reversalVoucher = await transaction(SYSTEM_ACTOR, (uow) => uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM vouchers WHERE source_type = 'payment_reversal' AND source_id = $1`, [paymentId]));
    expect(reversalVoucher).not.toBeNull();
  });

  it('refuses to reverse an already-reversed payment', async () => {
    const res = await call(`/api/v1/payments/${paymentId}/reverse`, { method: 'POST', body: { reason: 'again' } });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_ALREADY_REVERSED');
  });

  it('a reversed payment can never be edited or deleted (database-enforced)', async () => {
    // Let the error propagate out of transaction() itself, so the aborted
    // Postgres transaction is rolled back properly rather than papered over
    // inside the callback, which would leave the connection in a state
    // where even COMMIT fails. The thrown message is translate-error.ts's
    // friendly wording, not the raw trigger text (translateDbError runs on
    // every query, including this direct one).
    await expect(transaction(SYSTEM_ACTOR, (uow) => uow.count(`UPDATE payments SET amount = '1.00' WHERE id = $1`, [paymentId]))).rejects.toThrow(/already been reversed and cannot be changed/i);
  });

  it('now cancels the invoice, since its only payment is reversed', async () => {
    const res = await call(`/api/v1/invoices/${invoiceId}/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('cancelled');
  });

  it('applies and clamps a discount at invoice generation time', async () => {
    // Clear any leftover discount of this name from a previous, unclean run
    // (discounts.name is unique, and a discount IS safely deletable once its
    // student_discounts rows are gone).
    await transaction(SYSTEM_ACTOR, async (uow) => {
      await uow.count(`DELETE FROM student_discounts WHERE discount_id IN (SELECT id FROM discounts WHERE name = $1)`, ['__test sibling discount']);
      await uow.count(`DELETE FROM discounts WHERE name = $1`, ['__test sibling discount']);
    });

    const discount = await call('/api/v1/discounts', { method: 'POST', body: { name: '__test sibling discount', type: 'fixed', value: '10000.00' } }); // deliberately larger than any item
    made.discounts.push(discount.body.data.id);
    await call('/api/v1/student-discounts', { method: 'POST', body: { enrollmentId, discountId: discount.body.data.id, feeCategoryId: examCategoryId, validFrom: '2026-02-01' } });

    const res = await call('/api/v1/invoices', { method: 'POST', body: { enrollmentId, billingPeriod: '2026-02', issueDate: '2026-02-01', dueDate: '2026-02-10' } });
    expect(res.status).toBe(201);
    const invoice = await call(`/api/v1/invoices/${res.body.data.invoice.id}`);
    const examItem = invoice.body.data.items.find((i: { feeCategoryId: string }) => i.feeCategoryId === examCategoryId);
    const tuitionItem = invoice.body.data.items.find((i: { feeCategoryId: string }) => i.feeCategoryId === tuitionCategoryId);
    // The discount (10000) is clamped to the item's own amount (500), never negative.
    expect(examItem.discountAmount).toBe('500.00');
    // Total is tuition alone (whatever the structure's current amount is —
    // the earlier test changed it to 9999.00) plus the fully-discounted exam fee (0).
    expect(invoice.body.data.total).toBe(tuitionItem.amount);
  });

  it('bulk-generates for the whole class, skipping enrollments already invoiced for that period', async () => {
    const res = await call('/api/v1/invoices/bulk-generate', { method: 'POST', body: { academicYearId: yearId, classId, billingPeriod: '2026-03', issueDate: '2026-03-01', dueDate: '2026-03-10' } });
    expect(res.status).toBe(200);
    expect(res.body.data.failed).toBe(0);
    // The class fixture is reused across runs of this suite (see FIXED's
    // comment), so other runs' enrollments may also be in it and may also
    // need a 2026-03 invoice the first time this period is bulk-generated —
    // this run's own enrollment just needs to be one of the ones created.
    const own = res.body.data.results.find((r: { enrollmentId: string }) => r.enrollmentId === enrollmentId);
    expect(own.status).toBe('created');

    // The worklist query excludes already-invoiced enrollments at the SQL
    // level (enrollmentsNeedingInvoice), so a second run for the same period
    // finds nothing left to attempt, rather than visiting and skipping it.
    const again = await call('/api/v1/invoices/bulk-generate', { method: 'POST', body: { academicYearId: yearId, classId, billingPeriod: '2026-03', issueDate: '2026-03-01', dueDate: '2026-03-10' } });
    expect(again.status).toBe(200);
    expect(again.body.data.total).toBe(0);
    expect(again.body.data.created).toBe(0);
  });

  it('lists invoices filtered by status and class', async () => {
    const res = await call(`/api/v1/invoices?classId=${classId}&status=cancelled`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.some((i: { id: string }) => i.id === invoiceId)).toBe(true);
  });

  it('reports outstanding and overdue totals for the class', async () => {
    const res = await call(`/api/v1/reports/fees/outstanding?classId=${classId}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.outstanding)).toBeGreaterThan(0);
  });

  it('reports collections by method for the date range', async () => {
    const res = await call('/api/v1/reports/fees/collection?from=2026-01-01&to=2026-12-31');
    expect(res.status).toBe(200);
    const cash = res.body.data.byMethod.find((m: { method: string }) => m.method === 'cash');
    expect(cash).toBeDefined();
  });

  it('retrieves a receipt by number, derived from stored records', async () => {
    const aprilInvoice = await call('/api/v1/invoices', { method: 'POST', body: { enrollmentId, billingPeriod: '2026-04', issueDate: '2026-04-01', dueDate: '2026-04-10' } });
    const payment = await call('/api/v1/payments', { method: 'POST', body: { guardianId, amount: '1000.00', method: 'cash', allocations: [{ invoiceId: aprilInvoice.body.data.invoice.id, amount: '1000.00' }] } });
    expect(payment.status).toBe(201);
    const receipt = await call(`/api/v1/receipts/${payment.body.data.payment.receiptNo}`);
    expect(receipt.status).toBe(200);
    expect(receipt.body.data.amount).toBe('1000.00');
    expect(receipt.body.data.allocations.length).toBe(1);
  });

  it('a request without fees.collect is forbidden', async () => {
    const noAuth = await fetch(`${baseUrl}/api/v1/payments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ guardianId, amount: '1', method: 'cash', allocations: [{ invoiceId }] }) });
    expect(noAuth.status).toBe(401);
  });
});
