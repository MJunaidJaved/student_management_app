/**
 * Turning Postgres errors into domain errors.
 *
 * The schema does a great deal of enforcement itself — 106 triggers, 147 CHECK
 * constraints, three EXCLUDE constraints — and it is the last line of defence,
 * not the first. Services validate before writing, so anything that surfaces
 * here is either a race the service could not prevent or a gap in it.
 *
 * Either way the caller must not receive a raw driver message. `duplicate key
 * value violates unique constraint "students_admission_no_key"` leaks the
 * schema and means nothing to whoever is standing at the fee counter.
 *
 * The trigger messages matched below are quoted from the live functions
 * (`guard_marks`, `guard_payments`, `prevent_mutation`, and so on). They are
 * matched on their text because PL/pgSQL `RAISE EXCEPTION` without an explicit
 * ERRCODE reports P0001 for all of them, so the text is the only discriminator
 * available. If a trigger's wording changes, the fallback still produces a
 * correct 422 with the database's own message — less specific, never wrong.
 */

import {
  AppError,
  BusinessRuleError,
  ConflictError,
  ValidationError,
  type FieldIssue,
} from '../errors';

/** The subset of `pg`'s error shape this needs. */
type PgError = {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
  table?: string;
  column?: string;
};

const isPgError = (e: unknown): e is PgError =>
  typeof e === 'object' && e !== null && 'code' in e && typeof (e as PgError).code === 'string';

/** Postgres error classes this module recognises. */
const SQLSTATE = {
  UNIQUE_VIOLATION: '23505',
  FOREIGN_KEY_VIOLATION: '23503',
  NOT_NULL_VIOLATION: '23502',
  CHECK_VIOLATION: '23514',
  EXCLUSION_VIOLATION: '23P01',
  RAISE_EXCEPTION: 'P0001',
  SERIALIZATION_FAILURE: '40001',
  DEADLOCK_DETECTED: '40P01',
  LOCK_NOT_AVAILABLE: '55P03',
  QUERY_CANCELED: '57014',
  NUMERIC_VALUE_OUT_OF_RANGE: '22003',
  INVALID_TEXT_REPRESENTATION: '22P02',
} as const;

/**
 * Friendly wording for the constraints a user can realistically trip.
 *
 * Keyed by constraint name so the message can name the field rather than the
 * constraint. Anything not listed falls back to a generic conflict, which is
 * correct but vaguer.
 */
const UNIQUE_MESSAGES: Record<string, string> = {
  users_username_key: 'That username is already taken.',
  students_admission_no_key: 'That admission number already exists.',
  staff_employee_no_key: 'That employee number already exists.',
  fee_invoices_invoice_no_key: 'That invoice number already exists.',
  payments_receipt_no_key: 'That receipt number already exists.',
  books_accession_no_key: 'That accession number already exists.',
  permissions_code_key: 'That permission code already exists.',
  roles_name_key: 'A role with that name already exists.',
};

/** Constraint-name fragments that identify the column a clash happened on. */
const UNIQUE_HINTS: ReadonlyArray<readonly [fragment: string, message: string]> = [
  ['roll_no', 'That roll number is already used in this section for this academic year.'],
  ['enrollment', 'This student is already enrolled for that academic year.'],
  ['exam_schedule', 'Marks for this student and paper already exist.'],
  ['billing_period', 'An invoice for this student and billing period already exists.'],
  ['attendance', 'Attendance for this student and date already exists.'],
];

/**
 * Messages raised by the schema's guard triggers, matched to the rule they
 * enforce. Order matters only in that the first match wins.
 */
const TRIGGER_RULES: ReadonlyArray<readonly [test: RegExp, code: string, message: string]> = [
  [/Marks are locked/i, 'MARKS_LOCKED',
    'These marks are locked and can no longer be changed. Unlocking requires permission.'],
  [/Marks \(.*\) exceed total marks/i, 'MARKS_EXCEED_TOTAL',
    'A mark is higher than the paper’s total marks.'],
  [/Payments cannot be deleted/i, 'PAYMENT_IMMUTABLE',
    'A payment cannot be deleted. Reverse it instead, which keeps the audit trail.'],
  [/Reversed payment cannot be modified/i, 'PAYMENT_REVERSED',
    'This payment has already been reversed and cannot be changed.'],
  [/Payment amount\/receipt\/method cannot be edited/i, 'PAYMENT_IMMUTABLE',
    'A payment’s amount, receipt number and method cannot be edited. Reverse it and record a new one.'],
  [/Allocations \(.*\) must equal payment amount/i, 'ALLOCATION_MISMATCH',
    'The amounts allocated to invoices must add up to exactly the payment amount.'],
  [/Payroll run is .* and cannot be changed/i, 'PAYROLL_LOCKED',
    'This payroll run is no longer a draft, so its payslips cannot be changed.'],
  [/Posted voucher is immutable/i, 'VOUCHER_POSTED',
    'A posted voucher cannot be changed.'],
  [/Entries of a posted voucher are immutable/i, 'VOUCHER_POSTED',
    'The entries of a posted voucher cannot be changed.'],
  [/Voucher .* unbalanced/i, 'VOUCHER_UNBALANCED',
    'A voucher cannot be posted until its debits and credits are equal and non-zero.'],
  [/Academic year is closed/i, 'YEAR_CLOSED',
    'That academic year is closed and is now read-only.'],
  [/Vehicle capacity \(.*\) exceeded/i, 'VEHICLE_FULL',
    'The vehicle on this route is already at capacity.'],
  [/Table .* is append-only/i, 'APPEND_ONLY',
    'These records are append-only and cannot be edited or deleted.'],
];

/** A foreign-key failure is either a bad reference in, or a delete of something still in use. */
function foreignKey(err: PgError): AppError {
  const detail = err.detail ?? '';

  // "is still referenced from table x" means the row the caller tried to remove
  // is in use; the other direction means they pointed at something absent.
  if (/still referenced from table/i.test(detail)) {
    const referencing = /still referenced from table "([^"]+)"/i.exec(detail)?.[1];
    return new ConflictError(
      referencing
        ? `This cannot be removed because ${referencing.replace(/_/g, ' ')} still refers to it.`
        : 'This cannot be removed because other records still refer to it.',
      'IN_USE',
    );
  }

  const column = /Key \(([^)]+)\)=/i.exec(detail)?.[1];
  const issues: FieldIssue[] = column
    ? [{ field: column, message: 'That record does not exist.' }]
    : [];
  return new ValidationError('A referenced record does not exist.', issues);
}

/** The three EXCLUDE constraints all guard overlapping ranges. */
function exclusion(err: PgError): AppError {
  const c = err.constraint ?? '';
  if (c.includes('staff_contracts')) {
    return new ConflictError(
      'This staff member already has an active contract covering part of that period.',
      'OVERLAPPING_CONTRACT',
    );
  }
  if (c.includes('staff_salaries')) {
    return new ConflictError(
      'A salary structure for this staff member already covers part of that period.',
      'OVERLAPPING_SALARY',
    );
  }
  if (c.includes('grading_scale_ranges')) {
    return new ConflictError(
      'That percentage range overlaps another range in this grading scale.',
      'OVERLAPPING_RANGE',
    );
  }
  return new ConflictError('That period overlaps an existing record.', 'OVERLAPPING_PERIOD');
}

/**
 * Translate a driver error, or return it unchanged if it is not one.
 *
 * An AppError passes straight through: a service that already produced a
 * precise error must not have it rewritten by a generic mapper.
 */
export function translateDbError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (!isPgError(err)) return err;

  const message = err.message ?? '';

  switch (err.code) {
    case SQLSTATE.UNIQUE_VIOLATION: {
      const constraint = err.constraint ?? '';
      const exact = UNIQUE_MESSAGES[constraint];
      if (exact) return new ConflictError(exact, 'DUPLICATE');

      const hint = UNIQUE_HINTS.find(([fragment]) => constraint.includes(fragment));
      if (hint) return new ConflictError(hint[1], 'DUPLICATE');

      return new ConflictError('That record already exists.', 'DUPLICATE');
    }

    case SQLSTATE.FOREIGN_KEY_VIOLATION:
      return foreignKey(err);

    case SQLSTATE.NOT_NULL_VIOLATION:
      return new ValidationError('A required value is missing.',
        err.column ? [{ field: err.column, message: 'This is required.' }] : []);

    case SQLSTATE.CHECK_VIOLATION:
      // The CHECK constraints mirror rules the services validate first, so
      // reaching one means the service missed a case. Still a 422, because the
      // value genuinely is unacceptable, and the constraint name aids the fix.
      return new ValidationError(
        'That combination of values is not allowed.',
        err.constraint ? [{ field: err.constraint, message: 'Violates a database rule.' }] : [],
      );

    case SQLSTATE.EXCLUSION_VIOLATION:
      return exclusion(err);

    case SQLSTATE.RAISE_EXCEPTION: {
      const rule = TRIGGER_RULES.find(([test]) => test.test(message));
      if (rule) return new BusinessRuleError(rule[2], rule[1]);
      // An unrecognised guard. The database's own message is the best available
      // description, and every one of these is written for a human already.
      return new BusinessRuleError(message || 'That action is not allowed.');
    }

    case SQLSTATE.NUMERIC_VALUE_OUT_OF_RANGE:
      return new ValidationError('A number is too large for the field it was entered in.');

    case SQLSTATE.INVALID_TEXT_REPRESENTATION:
      return new ValidationError('A value is not in the expected format.');

    /* Contention and timeouts. Retryable cases are handled by the retry wrapper
     * in the transaction helper; by the time one reaches here the retries are
     * spent, so it is reported as a transient failure rather than a bug. */
    case SQLSTATE.SERIALIZATION_FAILURE:
    case SQLSTATE.DEADLOCK_DETECTED:
      return new ConflictError(
        'The record was busy and the change could not be completed. Please try again.',
        'CONTENTION',
      );

    case SQLSTATE.LOCK_NOT_AVAILABLE:
      return new ConflictError(
        'Someone else is editing this right now. Please try again in a moment.',
        'LOCKED',
      );

    case SQLSTATE.QUERY_CANCELED:
      return new BusinessRuleError(
        'That took too long and was stopped. Narrow the date range or filters and try again.',
        'STATEMENT_TIMEOUT',
      );

    default:
      return err;
  }
}

/** True for the error classes a transaction may usefully be retried on. */
export function isRetryable(err: unknown): boolean {
  return (
    isPgError(err) &&
    (err.code === SQLSTATE.SERIALIZATION_FAILURE || err.code === SQLSTATE.DEADLOCK_DETECTED)
  );
}
