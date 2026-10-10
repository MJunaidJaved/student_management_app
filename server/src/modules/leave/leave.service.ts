/**
 * Leave management (Module 4): types, requests, staff balances.
 *
 * Balance tracking is opt-in, not a built entitlement engine: if no
 * `staff_leave_balances` row exists for a staff member, type and year, their
 * leave is simply not balance-checked — the table already existed in the
 * schema, so using it when a row is present is "the existing design", but
 * building the accrual/allocation workflow that would create those rows in
 * bulk every year is a separate feature this phase does not build. A single
 * upsert endpoint (`leave.manage_balances`) lets an HR user set one row by
 * hand; that is deliberately all it does.
 *
 * Attendance is NOT touched by any leave decision here. Marking a day
 * "leave" in `student_attendance`/`staff_attendance` happens through the
 * attendance module's own submit endpoint, same as any other status. The two
 * systems are related (a teacher marking a day "leave" after seeing an
 * approved request is a normal workflow) but not wired to auto-write each
 * other — an approval does not silently create or overwrite an attendance
 * row. This is a deliberate decision, not an oversight: auto-marking would
 * mean a leave approval reaches into a table it does not own, and the two
 * records could disagree about who is attributed for writing it.
 */

import { readTransaction, transaction, type Actor, type Uow } from '../../core/db/uow';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } from '../../core/errors';
import { canTransition, LEAVE_TRANSITIONS, type LeaveStatus } from '../../core/db/enums';
import { enforce, type PolicyContext, type StudentPolicy } from '../../core/policy/policy';
import type { PermissionService } from '../../core/authz/permission-service';
import { EnrollmentRepository } from '../students/students.repository';
import { StaffRepository } from '../staff/staff.repository';
import type { NotificationService } from '../notifications/notifications.service';
import {
  LeaveTypeRepository,
  LeaveRequestRepository,
  StaffLeaveBalanceRepository,
  type LeaveTypeRow,
  type LeaveRequestRow,
  type StaffLeaveBalanceRow,
} from './leave.repository';

export type LeaveTypeView = { id: string; name: string; appliesTo: string; daysPerYear: number | null };
function toLeaveTypeView(row: LeaveTypeRow): LeaveTypeView {
  return { id: row.id, name: row.name, appliesTo: row.applies_to, daysPerYear: row.days_per_year };
}

export type StaffLeaveBalanceView = {
  id: string;
  staffId: string;
  leaveTypeId: string;
  leaveTypeName: string;
  academicYearId: string;
  allotted: string;
  used: string;
};

function toBalanceView(row: StaffLeaveBalanceRow & { leave_type_name: string }): StaffLeaveBalanceView {
  return {
    id: row.id,
    staffId: row.staff_id,
    leaveTypeId: row.leave_type_id,
    leaveTypeName: row.leave_type_name,
    academicYearId: row.academic_year_id,
    allotted: row.allotted,
    used: row.used,
  };
}

export type LeaveRequestView = {
  id: string;
  applicantType: string;
  enrollmentId: string | null;
  staffId: string | null;
  leaveTypeId: string;
  fromDate: string;
  toDate: string;
  reason: string | null;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
};

function toLeaveRequestView(row: LeaveRequestRow): LeaveRequestView {
  return {
    id: row.id,
    applicantType: row.applicant_type,
    enrollmentId: row.enrollment_id,
    staffId: row.staff_id,
    leaveTypeId: row.leave_type_id,
    fromDate: row.from_date,
    toDate: row.to_date,
    reason: row.reason,
    status: row.status,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
  };
}

/** Inclusive day count, the same convention `staff_leave_balances` expects. */
function daysInclusive(from: string, to: string): number {
  const ms = new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime();
  return Math.round(ms / 86_400_000) + 1;
}

export class LeaveService {
  constructor(
    private readonly leaveTypes: LeaveTypeRepository,
    private readonly leaveRequests: LeaveRequestRepository,
    private readonly balances: StaffLeaveBalanceRepository,
    private readonly enrollments: EnrollmentRepository,
    private readonly staff: StaffRepository,
    private readonly studentPolicy: StudentPolicy,
    private readonly permissions: PermissionService,
    private readonly notifications: NotificationService,
  ) {}

  private async context(uow: Uow, actor: Actor): Promise<PolicyContext> {
    const permissions = actor.userId === null ? new Set<string>() : await this.permissions.forUser(actor.userId);
    return { actor, uow, permissions };
  }

  /* ---------------- leave types ---------------- */

  async listLeaveTypes(actor: Actor): Promise<LeaveTypeView[]> {
    return readTransaction(actor, async (uow) => (await this.leaveTypes.listAll(uow)).map(toLeaveTypeView));
  }

  async createLeaveType(actor: Actor, input: { name: string; appliesTo: string; daysPerYear?: number | null | undefined }): Promise<LeaveTypeView> {
    return transaction(actor, async (uow) =>
      toLeaveTypeView(await this.leaveTypes.create(uow, { name: input.name, applies_to: input.appliesTo, days_per_year: input.daysPerYear ?? null })),
    );
  }

  async updateLeaveType(
    actor: Actor,
    id: string,
    input: { name?: string | undefined; appliesTo?: string | undefined; daysPerYear?: number | null | undefined },
  ): Promise<LeaveTypeView> {
    return transaction(actor, async (uow) =>
      toLeaveTypeView(await this.leaveTypes.update(uow, id, { name: input.name, applies_to: input.appliesTo, days_per_year: input.daysPerYear })),
    );
  }

  async deleteLeaveType(actor: Actor, id: string): Promise<void> {
    await transaction(actor, async (uow) => {
      const counts = await this.leaveTypes.referenceCounts(uow, id);
      if (counts.requests > 0 || counts.balances > 0) {
        throw new BusinessRuleError(
          `That leave type still has ${counts.requests} request(s) and ${counts.balances} balance row(s). It cannot be removed.`,
          'LEAVE_TYPE_IN_USE',
        );
      }
      await this.leaveTypes.hardDelete(uow, id);
    });
  }

  /* ---------------- staff leave balances ---------------- */

  async setStaffLeaveBalance(
    actor: Actor,
    input: { staffId: string; leaveTypeId: string; academicYearId: string; allotted: number },
  ): Promise<StaffLeaveBalanceView> {
    return transaction(actor, async (uow) => {
      await this.staff.getById(uow, input.staffId);
      const leaveType = await this.leaveTypes.getById(uow, input.leaveTypeId);
      const row = await this.balances.upsert(uow, input.staffId, input.leaveTypeId, input.academicYearId, input.allotted);
      return toBalanceView({ ...row, leave_type_name: leaveType.name });
    });
  }

  async getStaffLeaveBalances(actor: Actor, staffId: string, academicYearId?: string): Promise<StaffLeaveBalanceView[]> {
    return readTransaction(actor, async (uow) => {
      await this.staff.getById(uow, staffId);
      const ctx = await this.context(uow, actor);
      if (ctx.actor.userType !== 'admin' && !ctx.permissions.has('leave.read_all') && String(ctx.actor.staffId) !== staffId) {
        throw new NotFoundError('Staff');
      }
      const rows = await this.balances.forStaff(uow, staffId, academicYearId);
      return rows.map(toBalanceView);
    });
  }

  /* ---------------- submitting leave ---------------- */

  /** A guardian submits for their own child, or staff/admin submits on a student's behalf. */
  async submitStudentLeave(
    actor: Actor,
    input: { enrollmentId: string; leaveTypeId: string; fromDate: string; toDate: string; reason?: string | undefined },
  ): Promise<LeaveRequestView> {
    return transaction(actor, async (uow) => {
      const enrollment = await this.enrollments.getById(uow, input.enrollmentId);
      const ctx = await this.context(uow, actor);
      enforce(await this.studentPolicy.canView(ctx, enrollment.student_id), 'Student');

      const leaveType = await this.leaveTypes.getById(uow, input.leaveTypeId);
      if (leaveType.applies_to === 'staff') {
        throw new BusinessRuleError('That leave type does not apply to students.', 'LEAVE_TYPE_MISMATCH');
      }
      if (input.toDate < input.fromDate) {
        throw new BusinessRuleError('The end date must not be before the start date.', 'INVALID_RANGE');
      }

      const overlap = await this.leaveRequests.findOverlapping(uow, 'student', input.enrollmentId, input.fromDate, input.toDate);
      if (overlap.length > 0) {
        throw new ConflictError('This student already has a pending or approved leave request overlapping those dates.', 'OVERLAPPING_LEAVE');
      }

      const row = await this.leaveRequests.create(uow, {
        applicant_type: 'student',
        enrollment_id: input.enrollmentId,
        leave_type_id: input.leaveTypeId,
        from_date: input.fromDate,
        to_date: input.toDate,
        reason: input.reason ?? null,
      });
      return toLeaveRequestView(row);
    });
  }

  /** A staff member submits for themselves. */
  async submitStaffLeave(
    actor: Actor,
    input: { leaveTypeId: string; fromDate: string; toDate: string; reason?: string | undefined },
  ): Promise<LeaveRequestView> {
    return transaction(actor, async (uow) => {
      if (actor.staffId == null) {
        throw new ForbiddenError('Only a staff account may submit staff leave.');
      }
      const staffId = String(actor.staffId);

      const leaveType = await this.leaveTypes.getById(uow, input.leaveTypeId);
      if (leaveType.applies_to === 'student') {
        throw new BusinessRuleError('That leave type does not apply to staff.', 'LEAVE_TYPE_MISMATCH');
      }
      if (input.toDate < input.fromDate) {
        throw new BusinessRuleError('The end date must not be before the start date.', 'INVALID_RANGE');
      }

      const overlap = await this.leaveRequests.findOverlapping(uow, 'staff', staffId, input.fromDate, input.toDate);
      if (overlap.length > 0) {
        throw new ConflictError('You already have a pending or approved leave request overlapping those dates.', 'OVERLAPPING_LEAVE');
      }

      const row = await this.leaveRequests.create(uow, {
        applicant_type: 'staff',
        staff_id: staffId,
        leave_type_id: input.leaveTypeId,
        from_date: input.fromDate,
        to_date: input.toDate,
        reason: input.reason ?? null,
      });
      return toLeaveRequestView(row);
    });
  }

  /* ---------------- listing ---------------- */

  /**
   * Scoped listing: `leave.read_all` sees everything (filters narrow it
   * further); everyone else is confined to their own staff leave, their
   * children's student leave, or — for a teacher — the pending student leave
   * of sections they teach, which is what they need to act on it.
   */
  async listRequests(
    actor: Actor,
    filters: { applicantType?: string | undefined; status?: string | undefined; staffId?: string | undefined; enrollmentId?: string | undefined },
    page: { limit: number; cursor?: string | undefined },
  ) {
    return readTransaction(actor, async (uow) => {
      const ctx = await this.context(uow, actor);
      const scoped: Parameters<LeaveRequestRepository['listFiltered']>[1] = { ...filters };

      if (!ctx.permissions.has('leave.read_all') && ctx.actor.userType !== 'admin') {
        if (ctx.actor.userType === 'guardian') {
          const rows = await uow.many<{ student_id: string }>(`SELECT student_id FROM student_guardians WHERE guardian_id = $1`, [
            ctx.actor.guardianId,
          ]);
          const studentIds = rows.map((r) => r.student_id);
          const enrollmentRows =
            studentIds.length === 0
              ? []
              : await uow.many<{ id: string }>(`SELECT id::text AS id FROM student_enrollments WHERE student_id = ANY($1)`, [studentIds]);
          scoped.enrollmentIds = enrollmentRows.map((r) => r.id);
        } else if (ctx.actor.userType === 'staff') {
          scoped.staffId = String(ctx.actor.staffId);
          if (ctx.permissions.has('leave.approve_student')) {
            const sectionRows = await uow.many<{ section_id: string }>(
              `SELECT st.section_id FROM subject_teachers st JOIN academic_years ay ON ay.id = st.academic_year_id
                WHERE st.staff_id = $1 AND ay.is_current
               UNION
               SELECT id FROM sections WHERE class_teacher_id = $1 AND deleted_at IS NULL`,
              [ctx.actor.staffId],
            );
            scoped.sectionIdsForPendingStudent = sectionRows.map((r) => r.section_id);
            scoped.staffId = undefined; // widen: staff's own, plus their sections' student leave
            scoped.enrollmentIds = undefined;
          }
        } else if (ctx.actor.userType === 'student') {
          const own = await uow.many<{ id: string }>(`SELECT id::text AS id FROM student_enrollments WHERE student_id = $1`, [
            ctx.actor.studentId,
          ]);
          scoped.enrollmentIds = own.map((r) => r.id);
        }
      }

      let cursorCreatedAt: string | undefined, cursorId: string | undefined;
      if (page.cursor) {
        const decoded = JSON.parse(Buffer.from(page.cursor, 'base64url').toString('utf8')) as { v: string; i: string };
        cursorCreatedAt = decoded.v;
        cursorId = decoded.i;
      }
      const rows = await this.leaveRequests.listFiltered(uow, scoped, { limit: page.limit, cursorCreatedAt, cursorId });
      const hasMore = rows.length > page.limit;
      const items = hasMore ? rows.slice(0, page.limit) : rows;
      const last = items[items.length - 1];
      return {
        items: items.map(toLeaveRequestView),
        hasMore,
        nextCursor: hasMore && last ? Buffer.from(JSON.stringify({ v: last.created_at, i: last.id }), 'utf8').toString('base64url') : null,
      };
    });
  }

  async getRequest(actor: Actor, id: string): Promise<LeaveRequestView> {
    return readTransaction(actor, async (uow) => {
      const row = await this.leaveRequests.getById(uow, id);
      const ctx = await this.context(uow, actor);
      await this.assertCanViewRequest(ctx, row);
      return toLeaveRequestView(row);
    });
  }

  private async assertCanViewRequest(ctx: PolicyContext, row: LeaveRequestRow): Promise<void> {
    if (ctx.actor.userType === 'admin' || ctx.permissions.has('leave.read_all')) return;
    if (row.applicant_type === 'staff') {
      if (String(ctx.actor.staffId) === row.staff_id) return;
      throw new NotFoundError('Leave request');
    }
    const enrollment = await this.enrollments.getById(ctx.uow, row.enrollment_id!);
    const allowed = await this.studentPolicy.canView(ctx, enrollment.student_id);
    if (allowed.allowed) return;
    throw new NotFoundError('Leave request');
  }

  /* ---------------- decisions ---------------- */

  async decideStudentLeave(actor: Actor, id: string, decision: 'approved' | 'rejected'): Promise<LeaveRequestView> {
    return transaction(actor, async (uow) => {
      const row = await this.leaveRequests.getById(uow, id);
      if (row.applicant_type !== 'student') {
        throw new BusinessRuleError('That request is not a student leave request.', 'WRONG_APPLICANT_TYPE');
      }
      if (!canTransition(LEAVE_TRANSITIONS, row.status as LeaveStatus, decision)) {
        throw new BusinessRuleError(`Leave request cannot go from "${row.status}" to "${decision}".`, 'ILLEGAL_LEAVE_TRANSITION');
      }

      const ctx = await this.context(uow, actor);
      if (!ctx.permissions.has('leave.approve_student') && ctx.actor.userType !== 'admin') {
        throw new ForbiddenError('Approving student leave requires the approve-student permission.');
      }
      if (ctx.actor.userType === 'staff' && !ctx.permissions.has('attendance.read_all')) {
        // A class teacher may only decide leave for their own sections —
        // the same scope attendance and marks already use.
        const enrollment = await this.enrollments.getById(uow, row.enrollment_id!);
        const assigned = await uow.maybeOne<{ ok: boolean }>(
          `SELECT true AS ok FROM subject_teachers st JOIN academic_years ay ON ay.id = st.academic_year_id
            WHERE st.staff_id = $1 AND st.section_id = $2 AND ay.is_current
           UNION
           SELECT true FROM sections WHERE id = $2 AND class_teacher_id = $1 AND deleted_at IS NULL`,
          [actor.staffId, enrollment.section_id],
        );
        if (!assigned) throw new NotFoundError('Leave request');
      }

      const updated = await this.leaveRequests.decide(uow, id, decision, String(actor.userId));

      // Notify the guardian(s) of the child this leave is for — the person
      // who submitted it may have been a guardian or staff on the student's
      // behalf, but it is the guardians who need to know the outcome.
      const guardianRows = await uow.many<{ guardian_id: string }>(
        `SELECT guardian_id FROM student_guardians sg
           JOIN student_enrollments e ON e.student_id = sg.student_id
          WHERE e.id = $1`,
        [row.enrollment_id],
      );
      await this.notifications.notify(uow, {
        title: `Leave request ${decision}`,
        body: `The leave request from ${row.from_date} to ${row.to_date} was ${decision}.`,
        targetType: 'student',
        targetId: row.enrollment_id ?? undefined,
        createdBy: String(actor.userId),
        recipients: guardianRows.map((g) => ({ guardianId: g.guardian_id })),
      });

      return toLeaveRequestView(updated);
    });
  }

  /**
   * Decide staff leave, with the balance deduction Module 4 describes:
   * approving locks and checks the matching `staff_leave_balances` row (if
   * one exists — untracked types are simply not checked) and rejects when it
   * would go negative.
   */
  async decideStaffLeave(actor: Actor, id: string, decision: 'approved' | 'rejected'): Promise<LeaveRequestView> {
    return transaction(actor, async (uow) => {
      const row = await this.leaveRequests.getById(uow, id);
      if (row.applicant_type !== 'staff') {
        throw new BusinessRuleError('That request is not a staff leave request.', 'WRONG_APPLICANT_TYPE');
      }
      if (!canTransition(LEAVE_TRANSITIONS, row.status as LeaveStatus, decision)) {
        throw new BusinessRuleError(`Leave request cannot go from "${row.status}" to "${decision}".`, 'ILLEGAL_LEAVE_TRANSITION');
      }

      const ctx = await this.context(uow, actor);
      if (!ctx.permissions.has('leave.approve_staff') && ctx.actor.userType !== 'admin') {
        throw new ForbiddenError('Approving staff leave requires the approve-staff permission.');
      }
      // Segregation of duties: nobody decides their own leave.
      if (String(actor.staffId) === row.staff_id) {
        throw new ForbiddenError('You may not decide your own leave request.');
      }

      if (decision === 'approved') {
        await this.applyBalance(uow, row, +daysInclusive(row.from_date, row.to_date));
      }

      const updated = await this.leaveRequests.decide(uow, id, decision, String(actor.userId));

      const recipient = await uow.maybeOne<{ id: string }>(`SELECT id::text AS id FROM users WHERE staff_id = $1`, [row.staff_id]);
      await this.notifications.notify(uow, {
        title: `Leave request ${decision}`,
        body: `Your leave request from ${row.from_date} to ${row.to_date} was ${decision}.`,
        targetType: 'staff',
        targetId: row.staff_id ?? undefined,
        createdBy: String(actor.userId),
        recipients: recipient ? [{ userId: recipient.id }] : [],
      });

      return toLeaveRequestView(updated);
    });
  }

  /** Cancel a pending request (the submitter), or reverse an approved one (an approver), restoring any balance it consumed. */
  async cancelRequest(actor: Actor, id: string): Promise<LeaveRequestView> {
    return transaction(actor, async (uow) => {
      const row = await this.leaveRequests.getById(uow, id);
      if (!canTransition(LEAVE_TRANSITIONS, row.status as LeaveStatus, 'cancelled')) {
        throw new BusinessRuleError(`A "${row.status}" leave request cannot be cancelled.`, 'ILLEGAL_LEAVE_TRANSITION');
      }

      const ctx = await this.context(uow, actor);
      if (row.applicant_type === 'staff') {
        const isOwner = String(ctx.actor.staffId) === row.staff_id;
        const isApprover = ctx.permissions.has('leave.approve_staff') || ctx.actor.userType === 'admin';
        if (!isOwner && !isApprover) throw new NotFoundError('Leave request');
      } else {
        const enrollment = await this.enrollments.getById(uow, row.enrollment_id!);
        const canSeeStudent = await this.studentPolicy.canView(ctx, enrollment.student_id);
        const isApprover = ctx.permissions.has('leave.approve_student') || ctx.actor.userType === 'admin';
        if (!canSeeStudent.allowed && !isApprover) throw new NotFoundError('Leave request');
      }

      if (row.status === 'approved' && row.applicant_type === 'staff') {
        await this.applyBalance(uow, row, -daysInclusive(row.from_date, row.to_date));
      }

      const updated = await this.leaveRequests.decide(uow, id, 'cancelled', String(actor.userId));
      return toLeaveRequestView(updated);
    });
  }

  /** +days on approval, -days on a reversal. No-op when the type is not balance-tracked. */
  private async applyBalance(uow: Uow, row: LeaveRequestRow, deltaDays: number): Promise<void> {
    const year = await uow.maybeOne<{ id: string }>(
      `SELECT id::text AS id FROM academic_years WHERE $1 BETWEEN start_date AND end_date`,
      [row.from_date],
    );
    if (!year) return; // No academic year covers this date; nothing to check against.

    const balance = await this.balances.lockForStaffTypeYear(uow, row.staff_id!, row.leave_type_id, year.id);
    if (!balance) return; // Not a tracked type for this staff member: unlimited.

    if (deltaDays > 0) {
      const remaining = Number(balance.allotted) - Number(balance.used);
      if (remaining < deltaDays) {
        throw new BusinessRuleError(
          `Insufficient leave balance: ${remaining} day(s) remain, ${deltaDays} requested.`,
          'INSUFFICIENT_BALANCE',
        );
      }
    }
    await this.balances.adjustUsed(uow, balance.id, deltaDays);
  }
}
