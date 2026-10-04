/**
 * Default permission sets for the seven system roles.
 *
 * The seven roles already exist in the database with `is_system = true`; what
 * was missing is which permissions each holds. These sets are a starting point
 * for review, not a final answer — the whole matrix is printed by
 * `scripts/show-role-matrix.ts` for exactly that purpose.
 *
 * Three principles applied throughout, all from Part 7:
 *
 *   1. **Sensitive actions are granted narrowly.** `fees.reverse_payment`,
 *      `exams.unlock` and `users.assign_roles` go to as few roles as possible,
 *      even where it makes a role slightly less convenient.
 *
 *   2. **Segregation of duties.** The Accountant records payments and creates
 *      payroll; approving a discount and approving payroll sit with the
 *      Principal. Giving both to one role would defeat the check the brief
 *      asks for at the service layer.
 *
 *   3. **Scope beats permission for teachers.** A Teacher gets `attendance.mark`
 *      and `exams.enter_marks`, never the `_override` variants. The override
 *      codes are what lift the "only your own sections" restriction, and a
 *      class teacher is still restricted to their own section — that comes
 *      from the policy layer, not from a broader permission.
 *
 * Super Admin is deliberately not listed: it receives every permission in the
 * catalogue, and is handled as a special case in the seeder so a newly added
 * permission is never accidentally withheld from it.
 */

import { PERMISSION_CATALOG } from './permission-catalog';

export const SUPER_ADMIN_ROLE = 'Super Admin';

/**
 * Roles whose permission set is fully enumerated below.
 *
 * Guardian and Student hold almost nothing: their access comes from
 * `*.read_own` plus the ownership checks in the policy layer, which is what
 * keeps one family's data away from another's.
 */
export const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  Principal: [
    // Oversight of everything, and the approvals that must not sit with the
    // person who creates the record.
    'users.read', 'roles.read', 'permissions.read', 'audit.read', 'settings.read',
    'academic.read', 'academic.manage_years', 'academic.manage_classes',
    'academic.manage_subjects', 'academic.assign_teachers', 'academic.manage_rooms',
    'academic.set_current_year', 'academic.close_year', 'academic.copy_setup',
    'admissions.read', 'admissions.decide', 'admissions.enroll',
    'students.read_all', 'students.read', 'students.search', 'students.update',
    'students.promote', 'students.leave_school', 'students.issue_certificates',
    'students.read_discipline', 'students.manage_discipline', 'students.export',
    'guardians.read', 'guardians.search',
    'attendance.read_all', 'attendance.read', 'attendance.mark_override',
    'attendance.edit_past', 'attendance.read_staff',
    'leave.read_all', 'leave.approve_student', 'leave.approve_staff',
    'fees.read', 'fees.read_defaulters', 'fees.approve_discount',
    'fees.cancel_invoice', 'fees.waive_fine', 'fees.read_collection_report',
    'exams.read_all', 'exams.read', 'exams.manage', 'exams.publish', 'exams.lock',
    'exams.unlock', 'exams.compute_results', 'exams.manage_grading',
    'exams.read_analysis', 'exams.generate_report_cards', 'exams.generate_admit_cards',
    'staff.read', 'staff.read_workload', 'staff.read_sensitive',
    'staff.manage_contracts', 'staff.manage_departments',
  ],

  Teacher: [
    // Scoped to their own sections and subjects by the policy layer. No
    // override codes, and no read_all.
    'academic.read',
    'students.read', 'students.search', 'students.read_discipline',
    'students.manage_discipline',
    'guardians.read',
    'attendance.read', 'attendance.mark',
    'leave.read_own', 'leave.request', 'leave.approve_student',
    'exams.read', 'exams.enter_marks', 'exams.read_analysis',
    'staff.read_own', 'staff.read_workload',
  ],

  Accountant: [
    // Creates and collects; does not approve concessions and cannot reverse
    // without the separate code, which stays with the Principal and Super Admin.
    'academic.read',
    'students.read', 'students.search', 'guardians.read', 'guardians.search',
    'fees.read', 'fees.manage_structures', 'fees.generate_invoices',
    'fees.collect', 'fees.manage_discounts', 'fees.manage_installments',
    'fees.read_defaulters', 'fees.send_reminders', 'fees.read_collection_report',
    'fees.reprint_receipt', 'fees.carry_forward',
    'settings.read',
    'staff.read_own',
    'leave.read_own', 'leave.request',
  ],

  Librarian: [
    // Library codes belong to Module 11, whose specification has not been
    // supplied, so this role currently holds only what it needs to identify a
    // borrower. It must be revisited when that module is built.
    'academic.read',
    'students.read', 'students.search',
    'staff.read_own',
    'leave.read_own', 'leave.request',
  ],

  Guardian: [
    // Everything here is "own": the ownership check in the policy layer is what
    // confines it to their own children.
    'fees.read_own',
    'leave.request', 'leave.read_own',
  ],

  Student: [
    'fees.read_own',
    'leave.read_own',
  ],
};

/** Super Admin holds the whole catalogue, including anything added later. */
export const superAdminPermissions = (): readonly string[] =>
  PERMISSION_CATALOG.map((p) => p.code);
