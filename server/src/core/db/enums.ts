/**
 * The schema's CHECK-constrained value sets, in one place.
 *
 * Part 5.4 requires validation to enforce "enums matching the database CHECK
 * constraints". The schema has no Postgres enum types — every one of these is a
 * `text` column with a CHECK — so there is nothing for the driver to reflect
 * and the lists have to be mirrored in code.
 *
 * Mirrored deliberately in one module rather than inline in each validation
 * schema. Duplicating them per module means a value added to a CHECK gets
 * updated in three places and missed in a fourth, and the symptom is a 422 that
 * the database would have accepted.
 *
 * Verified against the live constraints. If a CHECK changes, change it here and
 * the type error will point at every route that needs revisiting.
 */

export const GENDERS = ['male', 'female', 'other'] as const;

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

/** `students.status` */
export const STUDENT_STATUSES = ['active', 'withdrawn', 'transferred', 'graduated'] as const;

/** `student_enrollments.status` */
export const ENROLLMENT_STATUSES = [
  'active',
  'promoted',
  'detained',
  'withdrawn',
  'transferred',
] as const;

/** `admission_applications.status` — the workflow in Module 3. */
export const APPLICATION_STATUSES = [
  'enquiry',
  'applied',
  'test',
  'accepted',
  'rejected',
  'enrolled',
] as const;

/** `subjects.type` */
export const SUBJECT_TYPES = ['core', 'elective', 'co_curricular'] as const;

/** `staff.status` */
export const STAFF_STATUSES = ['active', 'resigned', 'terminated'] as const;

/** `exams.status` — the state machine in Module 6. */
export const EXAM_STATUSES = ['draft', 'published', 'locked'] as const;

/** `student_attendance.status` */
export const STUDENT_ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'leave'] as const;

/** `staff_attendance.status` */
export const STAFF_ATTENDANCE_STATUSES = ['present', 'absent', 'late', 'leave', 'half_day'] as const;

/** `leave_requests.status` — the state machine in Module 4. */
export const LEAVE_STATUSES = ['pending', 'approved', 'rejected', 'cancelled'] as const;

/** `leave_requests.applicant_type` */
export const LEAVE_APPLICANT_TYPES = ['student', 'staff'] as const;

/** `leave_types.applies_to` */
export const LEAVE_APPLIES_TO = ['student', 'staff', 'both'] as const;

/** `fee_categories.frequency` */
export const FEE_FREQUENCIES = ['monthly', 'termly', 'yearly', 'one_time'] as const;

/** `fee_invoices.status` — unpaid/partial/paid are set only by `recompute_invoice()`; the app sets only `cancelled`. */
export const FEE_INVOICE_STATUSES = ['unpaid', 'partial', 'paid', 'cancelled'] as const;

/** `discounts.type` */
export const DISCOUNT_TYPES = ['percent', 'fixed'] as const;

/** `payments.method` */
export const PAYMENT_METHODS = ['cash', 'bank', 'online', 'cheque'] as const;

/** `payments.status` */
export const PAYMENT_STATUSES = ['valid', 'reversed'] as const;

/** `account_heads.type` */
export const ACCOUNT_HEAD_TYPES = ['asset', 'liability', 'income', 'expense', 'equity'] as const;

/** `vouchers.type` */
export const VOUCHER_TYPES = ['receipt', 'payment', 'journal'] as const;

/** `vouchers.status` */
export const VOUCHER_STATUSES = ['draft', 'posted'] as const;

/** `salary_components.type` and `payslip_items.type` */
export const SALARY_COMPONENT_TYPES = ['earning', 'deduction'] as const;

/** `salary_components.calc_type` */
export const SALARY_COMPONENT_CALC_TYPES = ['fixed', 'percent'] as const;

/** `payroll_runs.status` — the state machine in Module 8. */
export const PAYROLL_RUN_STATUSES = ['draft', 'approved', 'paid'] as const;

/** `student_promotions.action` */
export const PROMOTION_ACTIONS = ['promoted', 'detained', 'graduated'] as const;

/** `purchase_orders.status` — the workflow in Module 11. */
export const PURCHASE_ORDER_STATUSES = ['draft', 'ordered', 'received', 'cancelled'] as const;

/** `stock_movements.type` */
export const STOCK_MOVEMENT_TYPES = ['in', 'out', 'adjustment'] as const;

/** `book_issues.borrower_type` */
export const BORROWER_TYPES = ['student', 'staff'] as const;

/** `book_issues.status` — the workflow in Module 12. */
export const BOOK_ISSUE_STATUSES = ['issued', 'returned', 'lost'] as const;

/** `library_fines.status` */
export const LIBRARY_FINE_STATUSES = ['unpaid', 'paid', 'waived'] as const;

export type Gender = (typeof GENDERS)[number];
export type BloodGroup = (typeof BLOOD_GROUPS)[number];
export type StudentStatus = (typeof STUDENT_STATUSES)[number];
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type StaffStatus = (typeof STAFF_STATUSES)[number];
export type ExamStatus = (typeof EXAM_STATUSES)[number];
export type StudentAttendanceStatus = (typeof STUDENT_ATTENDANCE_STATUSES)[number];
export type StaffAttendanceStatus = (typeof STAFF_ATTENDANCE_STATUSES)[number];
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
export type LeaveApplicantType = (typeof LEAVE_APPLICANT_TYPES)[number];
export type SalaryComponentType = (typeof SALARY_COMPONENT_TYPES)[number];
export type SalaryComponentCalcType = (typeof SALARY_COMPONENT_CALC_TYPES)[number];
export type PayrollRunStatus = (typeof PAYROLL_RUN_STATUSES)[number];
export type PromotionAction = (typeof PROMOTION_ACTIONS)[number];
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export type BorrowerType = (typeof BORROWER_TYPES)[number];
export type BookIssueStatus = (typeof BOOK_ISSUE_STATUSES)[number];
export type LibraryFineStatus = (typeof LIBRARY_FINE_STATUSES)[number];

/**
 * Allowed transitions for the admission workflow (Part 4.6, State pattern).
 *
 * Declared explicitly, and anything absent is rejected. Note that `rejected`
 * and `enrolled` are terminal: an enrolled application cannot go back to
 * `accepted`, because a student record now exists and reversing the status
 * would leave the two disagreeing.
 */
export const APPLICATION_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  enquiry: ['applied', 'rejected'],
  applied: ['test', 'accepted', 'rejected'],
  test: ['accepted', 'rejected'],
  accepted: ['enrolled', 'rejected'],
  rejected: [],
  enrolled: [],
};

/**
 * Allowed transitions for an exam (Module 6).
 *
 * `locked` is reachable only from `published`, and leaving it requires the
 * separate `exams.unlock` permission rather than being a normal transition —
 * which is why `locked` lists nothing here.
 */
export const EXAM_TRANSITIONS: Readonly<Record<ExamStatus, readonly ExamStatus[]>> = {
  draft: ['published'],
  published: ['locked', 'draft'],
  locked: [],
};

/**
 * Allowed transitions for a leave request (Module 4).
 *
 * `approved` can still move to `cancelled` — a reversal, which is what
 * restores any staff leave balance it consumed. `rejected` and `cancelled`
 * are both terminal: nothing reopens a decided request, a fresh one is
 * submitted instead.
 */
export const LEAVE_TRANSITIONS: Readonly<Record<LeaveStatus, readonly LeaveStatus[]>> = {
  pending: ['approved', 'rejected', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
};

/**
 * Allowed transitions for a payroll run (Module 8).
 *
 * Linear and one-way: there is no "un-approve" or "un-pay". A mistake found
 * after approval is corrected by adjusting the next run, not by reopening a
 * finalized one — the same reasoning Section 3 applied to a posted voucher.
 */
export const PAYROLL_RUN_TRANSITIONS: Readonly<Record<PayrollRunStatus, readonly PayrollRunStatus[]>> = {
  draft: ['approved'],
  approved: ['paid'],
  paid: [],
};

/**
 * Allowed transitions for a purchase order (Module 11).
 *
 * `received` is reached by the service once every item is fully received,
 * not by a direct caller-chosen transition — partial receiving keeps the
 * order `ordered` across several receipts. A draft can still be cancelled
 * before anything is ordered; once `received` or `cancelled`, Part 11's
 * "received or cancelled state are frozen" makes both terminal.
 */
export const PURCHASE_ORDER_TRANSITIONS: Readonly<Record<PurchaseOrderStatus, readonly PurchaseOrderStatus[]>> = {
  draft: ['ordered', 'cancelled'],
  ordered: ['received', 'cancelled'],
  received: [],
  cancelled: [],
};

/**
 * Allowed transitions for a library book issue (Module 12).
 *
 * Both `returned` and `lost` are terminal: a returned book is re-borrowed
 * through a fresh issue, and a lost one is settled through its fine, never
 * reopened.
 */
export const BOOK_ISSUE_TRANSITIONS: Readonly<Record<BookIssueStatus, readonly BookIssueStatus[]>> = {
  issued: ['returned', 'lost'],
  returned: [],
  lost: [],
};

/** True when `to` is reachable from `from`. */
export function canTransition<T extends string>(
  map: Readonly<Record<T, readonly T[]>>,
  from: T,
  to: T,
): boolean {
  return (map[from] ?? []).includes(to);
}
