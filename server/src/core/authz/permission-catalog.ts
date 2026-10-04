/**
 * The permission catalogue.
 *
 * `permissions` arrived empty, so the entire list is defined here and seeded
 * from it. This file is the authority: a code that is not in this list cannot
 * be required by a route, and the seed deletes nothing, so removing a code here
 * leaves it orphaned in the database rather than silently un-protecting an
 * endpoint.
 *
 * Naming is `module.action`, with a few conventions that matter:
 *
 *   * `.read` / `.create` / `.update` / `.delete` for ordinary CRUD.
 *   * A separate, explicitly-named code for every action Part 7 calls sensitive
 *     — `fees.reverse_payment`, `exams.unlock`, `payroll.approve`. These are
 *     never folded into `.update`, because the whole point is that holding
 *     "edit fees" must not imply "reverse a payment".
 *   * `.read_own` where a user sees only their own record (a staff member's own
 *     payslip), distinct from `.read_all`.
 *   * `.override` where a code lifts a scope restriction rather than granting
 *     an action, for example marking attendance for a section you do not teach.
 *
 * Only modules 1 to 7 are listed. Modules 8 to 15 are specified in a brief file
 * that has not been supplied, so inventing their codes would mean inventing
 * their endpoints.
 */

export type PermissionDefinition = {
  readonly code: string;
  readonly module: string;
  readonly description: string;
  /** Marks the codes that must be granted narrowly and always audited. */
  readonly sensitive?: boolean;
};

const define = (
  module: string,
  entries: ReadonlyArray<readonly [action: string, description: string, sensitive?: true]>,
): PermissionDefinition[] =>
  entries.map(([action, description, sensitive]) => ({
    code: `${module}.${action}`,
    module,
    description,
    ...(sensitive ? { sensitive: true } : {}),
  }));

/* ---------------- Module 1: users, roles, permissions ---------------- */

const users = define('users', [
  ['read', 'View user accounts'],
  ['create', 'Create a user account'],
  ['update', 'Edit a user account'],
  ['deactivate', 'Activate or deactivate a user account', true],
  ['unlock', 'Unlock a locked-out account'],
  ['reset_password', 'Issue a new temporary password for a user', true],
  ['assign_roles', 'Grant or remove a user’s roles', true],
  ['bulk_create', 'Bulk-create guardian or student portal accounts'],
]);

const roles = define('roles', [
  ['read', 'View roles and their permissions'],
  ['create', 'Create a role'],
  ['update', 'Rename a role or change its permissions', true],
  ['delete', 'Delete a role', true],
]);

const permissions = define('permissions', [['read', 'View the permission list']]);

const audit = define('audit', [
  ['read', 'Search the audit log'],
  ['read_health', 'View health-record access entries in the audit log', true],
]);

const settings = define('settings', [
  ['read', 'View settings'],
  ['update', 'Change settings', true],
]);

/* ---------------- Module 2: academic setup ---------------- */

const academic = define('academic', [
  ['read', 'View academic years, terms, classes, sections and subjects'],
  ['manage_years', 'Create and edit academic years and terms'],
  ['set_current_year', 'Switch the current academic year', true],
  ['close_year', 'Close an academic year, making it read-only', true],
  ['manage_classes', 'Create and edit classes and sections'],
  ['manage_subjects', 'Create and edit subjects and class-subject mappings'],
  ['assign_teachers', 'Assign subject teachers and class teachers'],
  ['manage_rooms', 'Create and edit rooms'],
  ['copy_setup', 'Copy setup from a previous academic year'],
]);

/* ---------------- Module 3: student management ---------------- */

const admissions = define('admissions', [
  ['read', 'View admission applications'],
  ['create', 'Record an admission enquiry or application'],
  ['update', 'Edit an admission application'],
  ['decide', 'Accept or reject an application', true],
  ['enroll', 'Convert an accepted application into an enrolled student', true],
]);

const students = define('students', [
  ['read', 'View students within your scope'],
  ['read_all', 'View every student regardless of section'],
  ['create', 'Create a student record'],
  ['update', 'Edit a student record'],
  ['delete', 'Soft-delete a student with no history', true],
  ['restore', 'Restore a soft-deleted student'],
  ['search', 'Search students'],
  ['manage_documents', 'Upload and remove student documents'],
  ['read_health', 'View student health records', true],
  ['manage_health', 'Create and edit student health records', true],
  ['read_discipline', 'View student discipline records'],
  ['manage_discipline', 'Create and edit student discipline records'],
  ['manage_enrollments', 'Enroll students and transfer them between sections'],
  ['promote', 'Run the end-of-year promotion workflow', true],
  ['leave_school', 'Record a withdrawal or transfer out', true],
  ['issue_certificates', 'Generate leaving, character and bonafide certificates'],
  ['import', 'Bulk-import students and guardians'],
  ['export', 'Export student data'],
]);

const guardians = define('guardians', [
  ['read', 'View guardians within your scope'],
  ['create', 'Create a guardian record'],
  ['update', 'Edit a guardian record'],
  ['search', 'Search guardians by name, phone or national ID'],
]);

/* ---------------- Module 4: attendance ---------------- */

const attendance = define('attendance', [
  ['read', 'View attendance for your own sections'],
  ['read_all', 'View attendance for every section'],
  ['mark', 'Mark attendance for your assigned sections'],
  ['mark_override', 'Mark attendance for any section', true],
  ['edit_past', 'Edit attendance for an earlier date, with a reason', true],
  ['read_staff', 'View staff attendance'],
  ['mark_staff', 'Record staff attendance'],
]);

const leave = define('leave', [
  ['read_own', 'View your own leave requests and balances'],
  ['read_all', 'View anyone’s leave requests'],
  ['request', 'Submit a leave request'],
  ['approve_student', 'Approve or reject student leave'],
  ['approve_staff', 'Approve or reject staff leave', true],
  ['manage_types', 'Create and edit leave types'],
  ['manage_balances', 'Allocate and adjust staff leave balances', true],
]);

/* ---------------- Module 5: fees ---------------- */

const fees = define('fees', [
  ['read', 'View fee structures, invoices and payments'],
  ['read_own', 'View your own or your children’s invoices and payments'],
  ['manage_structures', 'Create and edit fee categories, structures and fine rules'],
  ['generate_invoices', 'Generate invoices, singly or in bulk', true],
  ['cancel_invoice', 'Cancel an invoice', true],
  ['collect', 'Record a fee payment', true],
  ['reverse_payment', 'Reverse a recorded payment', true],
  ['waive_fine', 'Waive a fine on an invoice', true],
  ['manage_discounts', 'Create discounts and assign them to students'],
  ['approve_discount', 'Approve a requested discount or concession', true],
  ['manage_installments', 'Create and edit installment plans'],
  ['read_defaulters', 'View defaulter and dues reports'],
  ['send_reminders', 'Send fee reminders to guardians'],
  ['carry_forward', 'Carry unpaid balances into the next academic year', true],
  ['read_collection_report', 'View the daily collection and cashier closing report'],
  ['reprint_receipt', 'Reprint a payment receipt as a duplicate'],
]);

/* ---------------- Module 6: examinations ---------------- */

const exams = define('exams', [
  ['read', 'View exams, schedules and results within your scope'],
  ['read_all', 'View every exam and result'],
  ['manage', 'Create and edit exam types, exams and schedules'],
  ['enter_marks', 'Enter marks for your assigned subjects'],
  ['enter_marks_override', 'Enter marks for any subject or section', true],
  ['publish', 'Publish exam results and report cards', true],
  ['lock', 'Lock an exam, freezing its marks', true],
  ['unlock', 'Unlock a locked exam so marks can be changed', true],
  ['compute_results', 'Run or re-run result computation'],
  ['manage_grading', 'Create and edit grading scales and ranges'],
  ['generate_admit_cards', 'Generate admit cards'],
  ['generate_report_cards', 'Generate report cards'],
  ['read_analysis', 'View exam analysis and comparisons'],
]);

/* ---------------- Module 7: staff and HR ---------------- */

const staff = define('staff', [
  ['read', 'View staff records'],
  ['read_own', 'View your own staff profile'],
  ['create', 'Create a staff record'],
  ['update', 'Edit a staff record'],
  ['deactivate', 'Record a resignation or termination', true],
  ['delete', 'Soft-delete a staff record with no history', true],
  ['search', 'Search staff'],
  ['read_sensitive', 'View staff national ID, salary and bank details', true],
  ['manage_documents', 'Upload and manage staff documents'],
  ['manage_contracts', 'Create and edit staff contracts', true],
  ['manage_departments', 'Create and edit departments and designations'],
  ['read_workload', 'View teacher workload'],
]);

/** Every permission in the system. */
export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  ...users, ...roles, ...permissions, ...audit, ...settings,
  ...academic,
  ...admissions, ...students, ...guardians,
  ...attendance, ...leave,
  ...fees,
  ...exams,
  ...staff,
];

/** Fast membership checks, and the guard behind `requirePermission`. */
export const PERMISSION_CODES: ReadonlySet<string> = new Set(
  PERMISSION_CATALOG.map((p) => p.code),
);

export const SENSITIVE_PERMISSION_CODES: ReadonlySet<string> = new Set(
  PERMISSION_CATALOG.filter((p) => p.sensitive).map((p) => p.code),
);

/**
 * A compile-time-ish guard for route declarations.
 *
 * Routes call `perm('fees.collect')` rather than passing a bare string, so a
 * typo fails at startup — when the module is imported — instead of at the first
 * request, where a code nobody holds would read as a permissions
 * misconfiguration rather than a typo.
 */
export function perm(code: string): string {
  if (!PERMISSION_CODES.has(code)) {
    throw new Error(
      `Unknown permission code "${code}". Add it to PERMISSION_CATALOG before requiring it.`,
    );
  }
  return code;
}

if (PERMISSION_CATALOG.length !== PERMISSION_CODES.size) {
  const seen = new Set<string>();
  const duplicates = PERMISSION_CATALOG.map((p) => p.code).filter(
    (c) => (seen.has(c) ? true : (seen.add(c), false)),
  );
  throw new Error(`Duplicate permission codes in the catalogue: ${[...new Set(duplicates)].join(', ')}`);
}
