/**
 * Vitest global setup: refuse to run the suite against a database that holds
 * real people or money.
 *
 * There is one database and no separate test database, so the suite writes to
 * the same tables the application uses. This guard stops the run before the
 * first test if any operational table already has rows that are not
 * accounted for below, so a test run can never be mistaken for real use or
 * mixed into real records.
 *
 * Section 3's payment tests are a deliberate, narrow exception. Once a
 * payment exists, `guard_payments` makes it permanently undeletable — by
 * design, the same guarantee that protects a real family's payment history
 * — and that immutability cascades through its invoice, enrollment, student
 * and guardian (every FK on that chain is RESTRICT). fees.api.test.ts's own
 * fixtures are therefore never cleaned up; they are excluded here by their
 * known, literal identity (the same fixed names that test uses every run),
 * not by weakening the check for anything else.
 *
 * exams.api.test.ts's 'Exam Guardian' is a narrower instance of the same
 * problem: `users_check` requires a guardian-type user's `guardian_id` to
 * stay non-null, so a guardian with a login attached can be reassigned but
 * never unlinked, which means it can never be deleted either. Each run
 * leaves one more such row — harmless, since nothing else depends on it.
 *
 * payroll.api.test.ts's 'Payroll Staff One' is the same shape again, one
 * level over: `guard_payslips` makes a payslip immutable once its run
 * leaves `draft`, which blocks deleting the payslip, which blocks deleting
 * the staff member it belongs to (`payslips.staff_id` is RESTRICT).
 *
 * A row in these tables that does not match one of these patterns still
 * fails the run.
 */

import { closePool, withClient } from '../db/pool';

const PROTECTED_TABLES = ['students', 'guardians', 'staff', 'payments'] as const;

const KNOWN_PERMANENT_TEST_FIXTURES: Partial<Record<(typeof PROTECTED_TABLES)[number], string>> = {
  guardians: `full_name IN ('Fee Guardian', 'Exam Guardian')`,
  students: `first_name = 'Fee' AND last_name = 'Payer'`,
  staff: `full_name = 'Payroll Staff One'`,
  payments: `guardian_id IN (SELECT id FROM guardians WHERE full_name = 'Fee Guardian')`,
};

export default async function refuseRealData(): Promise<void> {
  const counts = await withClient(async (client) => {
    const result = await client.query<Record<string, string>>(
      `SELECT ${PROTECTED_TABLES.map((t) => {
        const exclude = KNOWN_PERMANENT_TEST_FIXTURES[t];
        const where = exclude ? ` WHERE NOT (${exclude})` : '';
        return `(SELECT count(*) FROM ${t}${where})::int AS ${t}`;
      }).join(', ')}`,
    );
    return result.rows[0] ?? {};
  });
  await closePool();

  const populated = PROTECTED_TABLES.filter((t) => Number(counts[t] ?? 0) > 0);
  if (populated.length > 0) {
    throw new Error(
      `Refusing to run tests: real rows exist in ${populated.join(', ')}. ` +
        'The test suite must not run against a database that holds live records.',
    );
  }
}
